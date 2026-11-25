import { useState } from 'react'
import type { ChildAgentInfo } from '@shared/agents'
import { useFinishedAgents, useSpadeStore } from '../../store/hooks'
import { StatusBadge } from '../../ui/StatusBadge'
import type { EntityHost } from '../types'
import { childTitle } from './children'
import { ModeSelect } from './ModeSelect'
import { Permissions } from './Permissions'
import { agentStatusOf } from './status'

type ChildAgentsProps = {
  ownerNodeId: string
  children: readonly ChildAgentInfo[]
  host: Pick<EntityHost, 'focusNode' | 'notify'>
}

// The agents Paseo reports as this agent's children, in the agent's side pane. Collapsed by default: listed here
// with live status, answerable and switchable without a node of their own. A collapsed child's own children are
// listed under it, so whatever waits on the user surfaces on the nearest expanded owner.
export function ChildAgents({ ownerNodeId, children, host }: ChildAgentsProps): React.JSX.Element | null {
  if (children.length === 0) return null
  return (
    <section className="agents-pane__section" aria-label="Child agents">
      <h4 className="agents-pane__heading">
        Child agents <span className="agents-pane__count">{children.length}</span>
      </h4>
      <ul className="agent-children__list">
        {children.map((child) => (
          <ChildRow key={child.agentId} child={child} ownerNodeId={ownerNodeId} nested={false} host={host} />
        ))}
      </ul>
    </section>
  )
}

function blockReason(child: ChildAgentInfo): string | null {
  if (child.resourceState === 'missing') return 'Paseo no longer has this agent.'
  if (child.resourceState === 'stale') return 'Paseo is unreachable.'
  return null
}

function ChildRow({
  child,
  ownerNodeId,
  nested,
  host
}: {
  child: ChildAgentInfo
  ownerNodeId: string
  // A child of a collapsed child: it can only be expanded once its own owner is.
  nested: boolean
  host: ChildAgentsProps['host']
}): React.JSX.Element {
  const store = useSpadeStore()
  const finished = useFinishedAgents().has(child.agentId) && child.nodeId === null
  const [expanding, setExpanding] = useState(false)
  const title = childTitle(child)
  const blocked = blockReason(child)

  const expand = async (): Promise<void> => {
    setExpanding(true)
    const result = await window.spadeHost.agents
      .expandChild(ownerNodeId, child.agentId)
      .catch((reason: unknown) => ({ ok: false as const, error: { code: 'failed', message: String(reason) } }))
    setExpanding(false)
    if (!result.ok) {
      host.notify(`Could not expand ${title}: ${result.error.message}`)
      return
    }
    store.acknowledgeFinished(child.agentId)
    host.focusNode(result.nodeId)
  }

  return (
    <li className="agent-child" aria-label={child.title === null ? title : `Agent ${child.title}`}>
      <div className="agent-child__line">
        <p className="agent-child__title" title={title}>
          {title}
        </p>
        <StatusBadge status={agentStatusOf(child)} />
        {finished ? <span className="cr-badge cr-badge--success">finished</span> : null}
        {child.nodeId !== null ? <span className="cr-badge">expanded</span> : null}
        {finished ? (
          <button type="button" className="cr-button cr-button--ghost agent-child__action" onClick={() => store.acknowledgeFinished(child.agentId)}>
            Mark seen
          </button>
        ) : null}
        {child.nodeId !== null ? (
          <button type="button" className="cr-button agent-child__action" onClick={() => host.focusNode(child.nodeId!)}>
            Go to node
          </button>
        ) : nested ? null : (
          <button type="button" className="cr-button agent-child__action" disabled={expanding} onClick={() => void expand()}>
            {expanding ? 'Expanding…' : 'Expand'}
          </button>
        )}
      </div>
      <div className="agent-child__line">
        <span className="agent-child__detail mono">{[child.provider, child.model].filter(Boolean).join(' · ')}</span>
        <ModeSelect
          agentId={child.agentId}
          provider={child.provider}
          mode={child.mode}
          label={`Mode of ${title}`}
          blocked={blocked}
          notify={host.notify}
        />
      </div>
      {child.lastError ? <p className="agent-child__error">{child.lastError}</p> : null}
      {child.nodeId === null ? (
        <Permissions
          requests={child.pendingPermissions}
          blocked={blocked}
          respond={(requestId, behavior) => window.spadeHost.agents.respondToAgentPermission(child.agentId, requestId, behavior)}
        />
      ) : null}
      {child.nodeId === null && child.children.length > 0 ? (
        <ul className="agent-children__list agent-children__list--nested" aria-label={`Children of ${title}`}>
          {child.children.map((grandchild) => (
            <ChildRow key={grandchild.agentId} child={grandchild} ownerNodeId={ownerNodeId} nested host={host} />
          ))}
        </ul>
      ) : null}
    </li>
  )
}
