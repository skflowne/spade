import { useState } from 'react'
import { modeLabel } from './children'
import { useProviderModes } from './providerModes'

type ModeSelectProps = {
  // The Paseo agent whose mode this is.
  agentId: string
  provider: string
  mode: string | null
  // Accessible name, e.g. "Mode" on the agent's own node, "Mode of Worker" in an owner's list.
  label: string
  // Why the mode cannot be changed right now; null when it can.
  blocked: string | null
  notify(message: string): void
}

// An agent's permission mode, changed on the running agent. Modes are opaque provider ids with Paseo's labels;
// with no list from Paseo, the current mode is shown as text.
export function ModeSelect({ agentId, provider, mode, label, blocked, notify }: ModeSelectProps): React.JSX.Element | null {
  const modes = useProviderModes(provider)
  const [pending, setPending] = useState<string | null>(null)
  if (modes === null) {
    return mode === null ? null : (
      <span className="agent-mode agent-mode--text mono" aria-label={label}>
        {mode}
      </span>
    )
  }
  const options = mode !== null && !modes.some((entry) => entry.id === mode) ? [...modes, { id: mode, label: mode }] : modes

  const change = async (modeId: string): Promise<void> => {
    setPending(modeId)
    const result = await window.spadeHost.agents
      .setMode(agentId, modeId)
      .catch((reason: unknown) => ({ ok: false as const, error: { code: 'failed', message: String(reason) } }))
    setPending(null)
    if (!result.ok) notify(`Could not change the mode to ${modeLabel(modeId, modes)}: ${result.error.message}`)
  }

  return (
    <select
      className="cr-input agent-mode"
      aria-label={label}
      title={blocked ?? (pending !== null ? 'Changing the mode…' : label)}
      value={pending ?? mode ?? ''}
      disabled={blocked !== null || pending !== null}
      onChange={(event) => void change(event.target.value)}
    >
      {mode === null ? (
        <option value="" disabled>
          No mode
        </option>
      ) : null}
      {options.map((entry) => (
        <option key={entry.id} value={entry.id}>
          {entry.label}
        </option>
      ))}
    </select>
  )
}
