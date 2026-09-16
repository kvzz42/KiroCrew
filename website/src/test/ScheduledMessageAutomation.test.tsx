import { fireEvent, screen, waitFor } from '@testing-library/react'
import { renderWithProviders } from './helpers'
import { normalizeAutomationRecord, type LegacyGoalLoop } from '../monitoring/automation'
import SessionAutomationPopover from '../components/SessionAutomationPopover'

const raw = {
  id: 'scheduled-1',
  slot_key: 'chat-1',
  message: 'follow up with the release owner',
  idle_secs: 60,
  max_cycles: 1,
  cycle_count: 0,
  active: true,
  last_fire_ts: 0,
  next_due_ts: 2_000_000_000,
  scheduled_at: 2_000_000_000,
  stopped_reason: '',
}

const scheduled = normalizeAutomationRecord(raw) as LegacyGoalLoop

afterEach(() => {
  vi.unstubAllGlobals()
})

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
})

describe('scheduled AutoNudge records', () => {
  it('normalizes the absolute scheduled time without changing the automation family', () => {
    expect(scheduled).toMatchObject({
      kind: 'legacy_goal_loop',
      scheduledAt: 2_000_000_000,
      nextDueAt: 2_000_000_000,
      maxCycles: 1,
    })
  })

  it('keeps ordinary goal loops free of a scheduled marker', () => {
    const goal = normalizeAutomationRecord({ ...raw, scheduled_at: 0 }) as LegacyGoalLoop
    expect(goal.scheduledAt).toBeUndefined()
  })

  it('renders scheduled details instead of the Set a Goal editor', () => {
    renderWithProviders(
      <SessionAutomationPopover
        slotKey="chat-1"
        automation={scheduled}
        open
        onOpenChange={vi.fn()}
        onChange={vi.fn()}
      />,
    )

    expect(screen.getByText('Scheduled message')).toBeInTheDocument()
    expect(screen.getByText('follow up with the release owner')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Goal description' })).not.toBeInTheDocument()
    expect(document.querySelector('.lucide-clock')).toBeTruthy()
  })

  it('cancels through the existing AutoNudge delete route', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const onChange = vi.fn()
    const onOpenChange = vi.fn()
    renderWithProviders(
      <SessionAutomationPopover
        slotKey="chat-1"
        automation={scheduled}
        open
        onOpenChange={onOpenChange}
        onChange={onChange}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(null))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/autonudge/scheduled-1?intent=stop',
      { method: 'DELETE' },
    )
  })
})


describe('scheduled AutoNudge editing', () => {
  it('saves an edited prompt without truncating unchanged scheduled seconds', async () => {
    const withSeconds = normalizeAutomationRecord({ ...raw, scheduled_at: 2_000_000_037 }) as LegacyGoalLoop
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({
      ok: true,
      loop: { ...raw, message: 'updated prompt', scheduled_at: 2_000_000_037 },
    })))
    vi.stubGlobal('fetch', fetchMock)
    const onChange = vi.fn()
    renderWithProviders(
      <SessionAutomationPopover
        slotKey="chat-1"
        automation={withSeconds}
        open
        onOpenChange={vi.fn()}
        onChange={onChange}
      />,
    )

    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
      target: { value: 'updated prompt' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1))
    const scheduledCall = fetchMock.mock.calls.find(([url]) => url === '/api/autonudge/scheduled-1')
    expect(scheduledCall).toBeDefined()
    expect(JSON.parse(scheduledCall![1].body)).toEqual({ message: 'updated prompt' })
  })

  it('sends at when the Run once control changes', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({
      ok: true,
      loop: { ...raw, scheduled_at: 2_000_003_600 },
    })))
    vi.stubGlobal('fetch', fetchMock)
    renderWithProviders(
      <SessionAutomationPopover
        slotKey="chat-1"
        automation={scheduled}
        open
        onOpenChange={vi.fn()}
        onChange={vi.fn()}
      />,
    )
    const moved = new Date(2_000_003_600 * 1000)
    const local = new Date(moved.getTime() - moved.getTimezoneOffset() * 60_000)
      .toISOString().slice(0, 16)

    fireEvent.change(screen.getByLabelText('Run once'), { target: { value: local } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const scheduledCall = fetchMock.mock.calls.find(([url]) => url === '/api/autonudge/scheduled-1')
    expect(scheduledCall).toBeDefined()
    expect(JSON.parse(scheduledCall![1].body)).toEqual({
      message: 'follow up with the release owner',
      at: Math.floor(2_000_003_600 / 60) * 60,
    })
  })

  it('keeps edits visible when save fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(
      { error: 'schedule changed elsewhere' },
      409,
    ))))
    renderWithProviders(
      <SessionAutomationPopover
        slotKey="chat-1"
        automation={scheduled}
        open
        onOpenChange={vi.fn()}
        onChange={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
      target: { value: 'keep this draft' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('schedule changed elsewhere')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('keep this draft')
  })
})
