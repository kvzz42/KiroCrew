"""Scheduled messages are one-shot AutoNudge records.

The tests pin the distinctions that ``max_cycles=1`` alone does not provide:
an absolute deadline may be more than one recurring interval away, a successful
turn frees the session's single automation slot, and restart recovery replays a
dispatched-but-unfinished turn while cleaning a durably completed record without
sending it twice.
"""

from __future__ import annotations

import asyncio
import json
import time

import pytest

from kiro_crew.autonudge import AutoNudgeService, MonitorUpdateConflict, NudgeLoop


@pytest.fixture(autouse=True)
def _enable(monkeypatch):
    monkeypatch.setenv("KIROCREW_AUTONUDGE", "1")


@pytest.fixture
def svc(tmp_path):
    return AutoNudgeService(base_dir=tmp_path)


def _capture_arms(svc: AutoNudgeService) -> list[float | None]:
    arms: list[float | None] = []

    def capture(_loop: NudgeLoop, delay: float | None = None) -> None:
        arms.append(delay)

    svc._arm_timer = capture  # type: ignore[method-assign]
    return arms


@pytest.mark.asyncio
async def test_scheduled_add_persists_exact_deadline_and_one_cycle(svc, tmp_path):
    arms = _capture_arms(svc)
    due = time.time() + 2 * 86400

    loop = await svc.add(
        slot_key="chat-1-123",
        message="send the release update",
        idle_secs=15,
        max_cycles=99,
        scheduled_at=due,
    )

    assert loop.scheduled_at == due
    assert loop.next_due_ts == due
    assert loop.max_cycles == 1
    assert arms[-1] == 3600
    raw = json.loads((tmp_path / "autonudge.json").read_text())
    assert raw["loops"][0]["scheduled_at"] == due
    assert raw["loops"][0]["next_due_ts"] == due
    assert raw["loops"][0]["max_cycles"] == 1


@pytest.mark.asyncio
async def test_scheduled_timer_rechecks_wall_clock_before_firing(svc, monkeypatch):
    """A backward clock jump must not make an absolute schedule fire early."""
    due = 2_000.0
    loop = NudgeLoop(
        id="scheduled",
        slot_key="chat-1-123",
        message="later",
        scheduled_at=due,
        next_due_ts=due,
        max_cycles=1,
    )
    svc._loops[loop.id] = loop
    arms = _capture_arms(svc)
    fired: list[str] = []

    async def no_sleep(_delay):
        return None

    async def on_fire(_loop):
        fired.append(_loop.id)
        return True

    monkeypatch.setattr("kiro_crew.autonudge.asyncio.sleep", no_sleep)
    monkeypatch.setattr("kiro_crew.autonudge.time.time", lambda: 1_000.0)
    svc._on_fire = on_fire

    await svc._timer(loop, delay=0.0)

    assert fired == []
    assert arms == [1_000.0]


@pytest.mark.asyncio
async def test_scheduled_sleep_uses_a_wall_clock_beat(svc, monkeypatch):
    due = 10_000.0
    loop = NudgeLoop(
        id="scheduled",
        slot_key="chat-1-123",
        message="later",
        scheduled_at=due,
        next_due_ts=due,
        max_cycles=1,
    )
    arms = _capture_arms(svc)
    monkeypatch.setattr("kiro_crew.autonudge.time.time", lambda: 1_000.0)

    svc._arm_from_deadline(loop)

    assert arms == [3600]


@pytest.mark.asyncio
async def test_scheduled_record_is_removed_after_its_turn_completes(svc, tmp_path):
    _capture_arms(svc)
    due = time.time() + 60
    loop = await svc.add(
        slot_key="chat-1-123",
        message="one turn",
        scheduled_at=due,
    )

    async def delivered(_loop):
        return True

    svc._on_fire = delivered
    await svc._run_fire_cycle(loop)
    assert loop.cycle_count == 1
    assert svc.get_by_slot(loop.slot_key) is loop, "exclusivity ended before the turn completed"

    svc.notify_turn_complete(loop.slot_key, turn_completed=True)
    await asyncio.gather(*tuple(svc._inflight_adds))

    assert svc.get_by_slot(loop.slot_key) is None
    raw = json.loads((tmp_path / "autonudge.json").read_text())
    assert raw["loops"] == []


@pytest.mark.asyncio
async def test_restart_removes_an_already_delivered_schedule_without_refiring(tmp_path):
    due = time.time() - 5
    (tmp_path / "autonudge.json").write_text(
        json.dumps(
            {
                "version": 1,
                "loops": [
                    {
                        "id": "scheduled",
                        "slot_key": "chat-1-123",
                        "message": "already sent",
                        "idle_secs": 15,
                        "max_cycles": 1,
                        "cycle_count": 1,
                        "active": True,
                        "scheduled_at": due,
                        "scheduled_completed": True,
                        "next_due_ts": 0.0,
                    }
                ],
            }
        )
    )
    svc = AutoNudgeService(base_dir=tmp_path)
    arms = _capture_arms(svc)

    await svc.start()

    assert arms == [0.0]
    assert svc.get_by_slot("chat-1-123") is not None
    await svc._timer(svc.get_by_slot("chat-1-123"), delay=0.0)  # type: ignore[arg-type]
    assert svc.get_by_slot("chat-1-123") is None


@pytest.mark.asyncio
async def test_restart_replays_a_dispatched_but_unfinished_schedule(tmp_path):
    due = time.time() - 5
    (tmp_path / "autonudge.json").write_text(
        json.dumps(
            {
                "version": 1,
                "loops": [
                    {
                        "id": "scheduled",
                        "slot_key": "chat-1-123",
                        "message": "try this turn again",
                        "idle_secs": 15,
                        "max_cycles": 1,
                        "cycle_count": 1,
                        "active": True,
                        "scheduled_at": due,
                        "scheduled_completed": False,
                        "next_due_ts": 0.0,
                    }
                ],
            }
        )
    )
    service = AutoNudgeService(base_dir=tmp_path)
    arms = _capture_arms(service)

    await service.start()

    recovered = service.get_by_slot("chat-1-123")
    assert recovered is not None
    assert recovered.cycle_count == 0
    assert recovered.scheduled_completed is False
    assert recovered.next_due_ts == due
    assert arms == [10.0]
    stored = json.loads((tmp_path / "autonudge.json").read_text())["loops"][0]
    assert stored["cycle_count"] == 0
    assert stored["scheduled_completed"] is False


@pytest.mark.asyncio
async def test_interrupted_scheduled_turn_is_persisted_and_rearmed(svc, tmp_path):
    arms = _capture_arms(svc)
    loop = await svc.add(
        slot_key="chat-1-123",
        message="finish me",
        scheduled_at=time.time() + 60,
    )

    async def delivered(_loop):
        return True

    svc._on_fire = delivered
    await svc._run_fire_cycle(loop)
    svc.notify_turn_complete(loop.slot_key, turn_completed=False)
    await asyncio.gather(*tuple(svc._inflight_adds))

    assert loop.cycle_count == 0
    assert loop.scheduled_completed is False
    assert loop.next_due_ts == loop.scheduled_at
    assert arms[-1] == pytest.approx(loop.scheduled_at - time.time(), abs=1)
    stored = json.loads((tmp_path / "autonudge.json").read_text())["loops"][0]
    assert stored["cycle_count"] == 0
    assert stored["scheduled_completed"] is False


@pytest.mark.asyncio
async def test_direct_service_call_refuses_a_channel_schedule(svc):
    _capture_arms(svc)
    with pytest.raises(ValueError, match="dashboard session"):
        await svc.add(
            slot_key="slack:C123:1.0",
            message="later",
            scheduled_at=time.time() + 60,
        )


@pytest.mark.asyncio
async def test_schedule_and_goal_share_the_same_slot_conflict(svc):
    _capture_arms(svc)
    await svc.add(
        slot_key="chat-1-123",
        message="later",
        scheduled_at=time.time() + 60,
        replace_existing=False,
    )
    with pytest.raises(MonitorUpdateConflict, match="session already has an automation"):
        await svc.add(
            slot_key="chat-1-123",
            message="keep working",
            replace_existing=False,
        )


@pytest.mark.asyncio
async def test_goal_blocks_a_schedule_on_the_same_slot(svc):
    _capture_arms(svc)
    await svc.add(
        slot_key="chat-1-123",
        message="keep working",
        replace_existing=False,
    )
    with pytest.raises(MonitorUpdateConflict, match="session already has an automation"):
        await svc.add(
            slot_key="chat-1-123",
            message="later",
            scheduled_at=time.time() + 60,
            replace_existing=False,
        )


@pytest.mark.asyncio
async def test_scheduled_update_moves_deadline_and_rearms(svc, tmp_path):
    arms = _capture_arms(svc)
    first = time.time() + 600
    loop = await svc.add(slot_key="chat-1-123", message="before", scheduled_at=first)
    arms.clear()
    moved = time.time() + 1200

    updated = await svc.update(loop.id, message="after", scheduled_at=moved)

    assert updated is loop
    assert loop.message == "after"
    assert loop.scheduled_at == moved
    assert loop.next_due_ts == moved
    assert loop.max_cycles == 1
    assert arms[-1] == pytest.approx(moved - time.time(), abs=1)
    stored = json.loads((tmp_path / "autonudge.json").read_text())["loops"][0]
    assert stored["message"] == "after"
    assert stored["scheduled_at"] == moved
    assert stored["next_due_ts"] == moved


@pytest.mark.asyncio
async def test_scheduled_update_preserves_deadline_when_only_message_changes(svc):
    _capture_arms(svc)
    due = time.time() + 600
    loop = await svc.add(slot_key="chat-1-123", message="before", scheduled_at=due)

    await svc.update(loop.id, message="after")

    assert loop.scheduled_at == due
    assert loop.next_due_ts == due


@pytest.mark.asyncio
async def test_scheduled_update_refuses_a_firing_or_completed_message(svc):
    _capture_arms(svc)
    loop = await svc.add(slot_key="chat-1-123", message="before", scheduled_at=time.time() + 600)
    svc._firing.add(loop.id)
    with pytest.raises(ValueError, match="already firing or completed"):
        await svc.update(loop.id, message="too late")
    svc._firing.clear()
    loop.cycle_count = 1
    with pytest.raises(ValueError, match="already firing or completed"):
        await svc.update(loop.id, message="too late")
