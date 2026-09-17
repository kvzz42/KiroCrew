import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Clock } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useMenuKeyboard } from '../hooks/useMenuKeyboard'
import { Btn, Input } from './ui'

/** Convert a local wall-clock picker value to epoch seconds. */
export function toFireTime(localValue: string, nowMs: number = Date.now()): number | null {
  if (!localValue) return null
  const ms = Date.parse(localValue)
  if (Number.isNaN(ms)) return null
  const secs = Math.floor(ms / 1000)
  return secs > Math.floor(nowMs / 1000) ? secs : null
}

/** Convert epoch seconds to the local wall-clock shape datetime-local expects. */
export function fireTimeLocal(epochSecs: number): string {
  const date = new Date(epochSecs * 1000)
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000)
  return local.toISOString().slice(0, 16)
}

/** Start on the next quarter-hour so the initial picker value is usable. */
export function defaultFireLocal(nowMs: number = Date.now()): string {
  const d = new Date(nowMs)
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + (15 - (d.getMinutes() % 15) || 15))
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000)
  return local.toISOString().slice(0, 16)
}

export default function ScheduleLaterPopover({
  anchorRect,
  onSchedule,
  onClose,
  scheduling = false,
}: {
  anchorRect: DOMRect
  onSchedule: (atSecs: number) => void
  onClose: () => void
  scheduling?: boolean
}) {
  const { t } = useTranslation()
  const [local, setLocal] = useState(() => defaultFireLocal())
  const ref = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useMenuKeyboard({ enabled: true, containerRef: ref })

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [onClose])

  const fireTime = toFireTime(local)

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={t('components.chatInput.send_later')}
      data-testid="schedule-later-popover"
      className="fixed z-[60] w-[260px] rounded-xl border border-border bg-bg-elevated p-2 shadow-xl"
      style={{
        left: Math.max(8, Math.min(anchorRect.left, window.innerWidth - 260 - 8)),
        bottom: window.innerHeight - anchorRect.top + 8,
      }}
    >
      <div className="flex flex-col gap-2 p-0.5">
        <label
          className="flex items-center gap-1.5 text-[12px] font-medium text-text"
          htmlFor="schedule-later-at"
        >
          <Clock className="h-3.5 w-3.5 shrink-0 text-muted lucide-inline" aria-hidden />
          {t('components.chatInput.send_later')}
        </label>
        <Input
          ref={inputRef}
          id="schedule-later-at"
          type="datetime-local"
          aria-label={t('components.chatInput.send_later')}
          aria-invalid={fireTime === null}
          aria-describedby={fireTime === null ? 'schedule-later-at-error' : undefined}
          value={local}
          onChange={event => setLocal(event.target.value)}
          data-testid="schedule-later-at"
        />
        {fireTime === null ? (
          <p id="schedule-later-at-error" role="status" className="text-[11px] text-danger">
            {t('components.jobForm.pick_a_time_in_the_future')}
          </p>
        ) : null}
        <Btn
          primary
          onClick={() => {
            if (fireTime !== null) onSchedule(fireTime)
          }}
          disabled={fireTime === null || scheduling}
          data-testid="schedule-later-confirm"
        >
          {t('nav.schedule')}
        </Btn>
      </div>
    </div>,
    document.body,
  )
}
