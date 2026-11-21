import { useId, useState } from 'react'
import type { ProviderSubagentInfo } from '@shared/agents'
import { subagentTone } from './status'

type SubagentsProps = {
  subagents: readonly ProviderSubagentInfo[]
  onOpen(subagentId: string): Promise<void>
}

// Provider-native sub-agents (plan §7.1): listed inside the parent node; each opens on demand as a
// delegated child node.
export function Subagents({ subagents, onOpen }: SubagentsProps): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  const [opening, setOpening] = useState<string | null>(null)
  const listId = useId()
  if (subagents.length === 0) return null
  return (
    <section className="agent-subagents" aria-label="Provider sub-agents">
      <button
        type="button"
        className="agent-subagents__toggle"
        aria-expanded={expanded}
        aria-controls={listId}
        onClick={() => setExpanded(!expanded)}
      >
        <span className="agent-pane__chevron" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
        <span className="agent-pane__label">Sub-agents</span>
        <span className="agent-subagents__count">{subagents.length}</span>
      </button>
      {expanded ? (
        <ul id={listId} className="agent-subagents__list">
          {subagents.map((subagent) => (
            <li key={subagent.id} className="agent-subagent" aria-label={`Sub-agent ${subagent.title ?? subagent.id}`}>
              <div className="agent-subagent__text">
                <p className="agent-subagent__title">{subagent.title ?? 'Sub-agent'}</p>
                {subagent.description ? <p className="agent-subagent__description">{subagent.description}</p> : null}
              </div>
              <span className={`cr-badge cr-badge--${subagentTone(subagent.status)}`}>{subagent.status}</span>
              <button
                type="button"
                className="cr-button"
                disabled={opening !== null}
                onClick={() => {
                  setOpening(subagent.id)
                  void onOpen(subagent.id).finally(() => setOpening(null))
                }}
              >
                {opening === subagent.id ? 'Opening…' : 'Open as node'}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
