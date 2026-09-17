import { useState } from 'react'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { renderWithProviders } from './helpers'
import { stubStripHeights } from './stripHeights'
import { SlotProvider } from '../providers/SlotContext'
import type { LegacyGoalLoop } from '../monitoring/automation'
import ChatInput from '../components/ChatInput'
import {
  defaultFireLocal,
  toFireTime,
} from '../components/ScheduleLaterPopover'

const scheduled = (over: Partial<LegacyGoalLoop> = {}): LegacyGoalLoop => ({
  kind: 'legacy_goal_loop',
  id: 'scheduled-1',
  slotKey: 'chat-1',
  message: 'follow up with the release owner',
  idleSecs: 60,
  maxCycles: 1,
  cycleCount: 0,
  active: true,
  lastFireAt: 0,
  nextDueAt: 2_000_000_000,
  scheduledAt: 2_000_000_000,
  stoppedReason: '',
  ...over,
})

function rawLoop(at: number, message: string) {
  return {
    id: 'scheduled-1',
    slot_key: 'chat-1',
    message,
    idle_secs: 60,
    max_cycles: 1,
    cycle_count: 0,
    active: true,
    last_fire_ts: 0,
    next_due_ts: at,
    scheduled_at: at,
    stopped_reason: '',
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  stubStripHeights()
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ScheduleLaterPopover time conversion', () => {
  const now = Date.parse('2026-03-05T12:00:00')

  it('reads local wall clock as epoch seconds', () => {
    expect(toFireTime('2026-03-05T13:30', now)).toBe(
      Math.floor(Date.parse('2026-03-05T13:30') / 1000),
    )
  })

  it('refuses empty, malformed, current, and past values', () => {
    expect(toFireTime('', now)).toBeNull()
    expect(toFireTime('not-a-date', now)).toBeNull()
    expect(toFireTime('2026-03-05T12:00', now)).toBeNull()
    expect(toFireTime('2026-03-05T11:59', now)).toBeNull()
  })

  it('defaults to a usable future quarter hour', () => {
    const value = defaultFireLocal(Date.parse('2026-03-05T12:07:30'))
    expect(new Date(Date.parse(value)).getMinutes() % 15).toBe(0)
    expect(toFireTime(value, Date.parse('2026-03-05T12:07:30'))).not.toBeNull()
  })

  it('explains why a past picker value cannot be scheduled', async () => {
    renderWithProviders(<Host />)

    await openSendLater()
    fireEvent.change(screen.getByTestId('schedule-later-at'), {
      target: { value: '2020-01-01T00:00' },
    })

    expect(screen.getByText('Pick a time in the future')).toBeInTheDocument()
    expect(screen.getByTestId('schedule-later-confirm')).toBeDisabled()
  })
})

function Host({
  initial = 'follow up with the release owner',
  automation = null,
  onAutomationChange = vi.fn(),
}: {
  initial?: string
  automation?: LegacyGoalLoop | null
  onAutomationChange?: ReturnType<typeof vi.fn>
}) {
  const [value, setValue] = useState(initial)
  const [automationOpen, setAutomationOpen] = useState(false)
  return (
    <SlotProvider slotId="chat-1">
      <ChatInput
        value={value}
        onChange={setValue}
        onSend={vi.fn()}
        onUploadFiles={vi.fn()}
        automation={automation}
        automationOpen={automationOpen}
        onAutomationClick={setAutomationOpen}
        automationCreationReady
        onAutomationChange={onAutomationChange}
      />
    </SlotProvider>
  )
}

async function openSendLater() {
  fireEvent.click(screen.getByRole('button', { name: 'Add files & options' }))
  const row = await screen.findByTestId('plus-menu-send-later')
  fireEvent.click(row)
  return screen.findByTestId('schedule-later-popover')
}

describe('ChatInput Send later', () => {
  it('closes skill suggestions when the plus menu takes focus', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/slash-commands' || url.startsWith('/api/skills')) {
        return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }))
      }
      return Promise.resolve(new Response(null, { status: 204 }))
    }))
    renderWithProviders(<Host initial="" />)

    const input = screen.getByLabelText('Message input')
    fireEvent.change(input, { target: { value: 'use $missing' } })
    expect(await screen.findByRole('listbox')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Add files & options' }))

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(await screen.findByTestId('plus-menu-send-later')).toBeInTheDocument()
  })

  it('creates a one-shot AutoNudge record with the current draft', async () => {
    const at = Math.floor(Date.now() / 1000) + 3600
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      if (String(input) === '/api/slash-commands') {
        return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }))
      }
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, loop: rawLoop(at, 'follow up with the release owner') }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    const onAutomationChange = vi.fn()
    renderWithProviders(<Host onAutomationChange={onAutomationChange} />)

    await openSendLater()
    const local = new Date(at * 1000 - new Date(at * 1000).getTimezoneOffset() * 60000)
      .toISOString().slice(0, 16)
    fireEvent.change(screen.getByTestId('schedule-later-at'), { target: { value: local } })
    fireEvent.click(screen.getByTestId('schedule-later-confirm'))

    await waitFor(() => expect(onAutomationChange).toHaveBeenCalledTimes(1))
    const scheduledCall = fetchMock.mock.calls.find(([url]) => url === '/api/autonudge')
    expect(scheduledCall).toBeDefined()
    const [, options] = scheduledCall!
    expect(JSON.parse(options.body)).toEqual({
      slot_key: 'chat-1',
      message: 'follow up with the release owner',
      at: toFireTime(local),
    })
    expect(screen.getByLabelText('Message input')).toHaveValue('')
  })

  it('keeps the draft and shows the server conflict when a raced arm loses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: RequestInfo | URL) => {
      if (String(input) === '/api/slash-commands') {
        return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }))
      }
      return Promise.resolve(
        new Response(JSON.stringify({ error: 'session already has an automation' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    }))
    renderWithProviders(<Host />)

    await openSendLater()
    fireEvent.click(screen.getByTestId('schedule-later-confirm'))

    expect(await screen.findByText('session already has an automation')).toBeInTheDocument()
    expect(screen.getByLabelText('Message input')).toHaveValue('follow up with the release owner')
  })

  it('disables Send later while a goal already owns the session and explains why', async () => {
    renderWithProviders(<Host automation={scheduled({ scheduledAt: undefined, maxCycles: 5 })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add files & options' }))
    const sendLater = await screen.findByTestId('plus-menu-send-later')
    expect(sendLater).toBeDisabled()
    expect(sendLater).toHaveAttribute('title', 'Goal active (cycle 0)')
    expect(screen.getByText('Goal active (cycle 0)')).toBeInTheDocument()
  })

  it('shows and cancels the pending scheduled message', async () => {
    const onAutomationChange = vi.fn()
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      if (String(input) === '/api/slash-commands') {
        return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }))
      }
      return Promise.resolve(new Response(null, { status: 204 }))
    })
    vi.stubGlobal('fetch', fetchMock)
    renderWithProviders(
      <Host initial="" automation={scheduled()} onAutomationChange={onAutomationChange} />,
    )

    expect(screen.getByTestId('scheduled-message-banner')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('scheduled-message-cancel'))

    await waitFor(() => expect(onAutomationChange).toHaveBeenCalledWith(null))
    expect(screen.getByLabelText('Message input')).toHaveValue(
      'follow up with the release owner',
    )
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/autonudge/scheduled-1?intent=stop',
      { method: 'DELETE' },
    )
  })
})


it('opens the scheduled-message editor from the banner', async () => {
  renderWithProviders(<Host automation={scheduled()} />)

  fireEvent.click(screen.getByTestId('scheduled-message-edit'))

  expect(await screen.findByText('Scheduled message')).toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(
    'follow up with the release owner',
  )
  expect(screen.getByLabelText('Send later…')).toBeInTheDocument()
})
