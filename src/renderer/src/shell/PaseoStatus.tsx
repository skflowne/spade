import { useId, useState } from 'react'
import type { PaseoConnectionState } from '@shared/agents'
import { useAppState } from '../store/hooks'

const LABELS: Record<PaseoConnectionState, string> = {
  connected: 'Connected',
  connecting: 'Connecting',
  reconnecting: 'Reconnecting',
  disconnected: 'Disconnected',
  disabled: 'Unavailable'
}

const TONES: Record<PaseoConnectionState, string> = {
  connected: 'success',
  connecting: 'info',
  reconnecting: 'warning',
  disconnected: 'danger',
  disabled: 'neutral'
}

// The Paseo connection, quietly. Details (URL and the last error) open on request.
export function PaseoStatus(): React.JSX.Element | null {
  const paseo = useAppState()?.paseo
  const [open, setOpen] = useState(false)
  const detailsId = useId()
  if (!paseo) return null
  const hasDetails = paseo.error !== null || paseo.url !== ''
  return (
    <div className="paseo-status" data-testid="paseo-status" data-state={paseo.state}>
      <button
        type="button"
        className="paseo-status__toggle"
        aria-expanded={hasDetails ? open : undefined}
        aria-controls={hasDetails ? detailsId : undefined}
        disabled={!hasDetails}
        onClick={() => setOpen((current) => !current)}
      >
        <span className={`status-dot status-dot--${TONES[paseo.state]}`} aria-hidden="true" />
        <span>Paseo</span>
        <span className="paseo-status__state">{LABELS[paseo.state]}</span>
      </button>
      {open && hasDetails ? (
        <div id={detailsId} className="paseo-status__details">
          {paseo.url ? <p className="mono">{paseo.url}</p> : null}
          {paseo.error ? <p>{paseo.error}</p> : null}
        </div>
      ) : null}
    </div>
  )
}
