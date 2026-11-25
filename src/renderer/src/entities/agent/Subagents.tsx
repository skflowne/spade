import { useState } from 'react'
import type { ProviderSubagentInfo } from '@shared/agents'
import type { EntityHost } from '../types'
import { subagentTone } from './status'

// Opens a provider-native sub-agent as a delegated child node of `nodeId` and centers it.
export async function openSubagentNode(nodeId: string, subagentId: string, host: Pick<EntityHost, 'focusNode' | 'notify'>): Promise<void> {
  const result = await window.spadeHost.agents
    .openProviderSubagent(nodeId, subagentId)
    .catch((reason: unknown) => ({ ok: false as const, error: { code: 'failed', message: String(reason) } }))
  if (result.ok) host.focusNode(result.nodeId)
  else host.notify(`Could not open the sub-agent: ${result.error.message}`)
}

type SubagentsProps = {
  subagents: readonly ProviderSubagentInfo[]
  onOpen(subagentId: string): Promise<void>
}

// Provider-native sub-agents (plan §7.1), in the agent's side pane; each opens on demand as a delegated child node.
export function Subagents({ subagents, onOpen }: SubagentsProps): React.JSX.Element | null {
  const [opening, setOpening] = useState<string | null>(null)
  if (subagents.length === 0) return null
  return (
    <section className="agents-pane__section" aria-label="Provider sub-agents">
      <h4 className="agents-pane__heading">
        Sub-agents <span className="agents-pane__count">{subagents.length}</span>
      </h4>
      <ul className="agent-children__list">
        {subagents.map((subagent) => (
          <li key={subagent.id} className="agent-child" aria-label={`Sub-agent ${subagent.title ?? subagent.id}`}>
            <div className="agent-child__line">
              <p className="agent-child__title">{subagent.title ?? 'Sub-agent'}</p>
              <span className={`cr-badge cr-badge--${subagentTone(subagent.status)}`}>{subagent.status}</span>
              <button
                type="button"
                className="cr-button agent-child__action"
                disabled={opening !== null}
                onClick={() => {
                  setOpening(subagent.id)
                  void onOpen(subagent.id).finally(() => setOpening(null))
                }}
              >
                {opening === subagent.id ? 'Opening…' : 'Open as node'}
              </button>
            </div>
            {subagent.description ? <p className="agent-child__detail">{subagent.description}</p> : null}
          </li>
        ))}
      </ul>
    </section>
  )
}
