import { useId, useState } from 'react'
import type { PaseoConnection, PaseoConnectionState } from '@shared/agents'
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

// What a refresh answered, shown until the next app state push brings a newer connection.
type Refreshed = { connection: PaseoConnection; basis: PaseoConnection }

// The Paseo connection, quietly. Details (URL and the last error) open on request; Refresh re-resolves the
// daemon URL, reconnects and reconciles.
export function PaseoStatus(): React.JSX.Element | null {
  const pushed = useAppState()?.paseo
  const [open, setOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshed, setRefreshed] = useState<Refreshed | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const detailsId = useId()
  if (!pushed) return null
  const paseo = refreshed && refreshed.basis === pushed ? refreshed.connection : pushed
  const hasDetails = paseo.error !== null || paseo.url !== '' || failure !== null

  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    setFailure(null)
    const result = await window.spadeHost.agents
      .refreshConnection()
      .catch((reason: unknown) => ({ ok: false as const, error: { code: 'failed', message: String(reason) } }))
    setRefreshing(false)
    if (result.ok) setRefreshed({ connection: result.connection, basis: pushed })
    else setFailure(result.error.message)
    setOpen(true)
  }

  return (
    <div className="paseo-status" data-testid="paseo-status" data-state={paseo.state}>
      <div className="paseo-status__row">
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
          <span className="paseo-status__state">{refreshing ? 'Refreshing…' : LABELS[paseo.state]}</span>
        </button>
        <button
          type="button"
          className="cr-icon-button paseo-status__refresh"
          aria-label="Refresh the Paseo connection"
          title="Find the daemon again and reconnect"
          disabled={refreshing}
          onClick={() => void refresh()}
        >
          <span aria-hidden="true">↻</span>
        </button>
      </div>
      {open && hasDetails ? (
        <div id={detailsId} className="paseo-status__details">
          {paseo.url ? <p className="mono">{paseo.url}</p> : null}
          {paseo.error ? <p>{paseo.error}</p> : null}
          {failure ? <p role="alert">Could not refresh: {failure}</p> : null}
        </div>
      ) : null}
    </div>
  )
}
