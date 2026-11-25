import { useState } from 'react'
import type { AgentPermissionRequest, PermissionBehavior } from '@shared/agents'
import type { Result } from '@shared/ipc'

// Answers one request: by node for the node's own agent, by agent for a child in its owner's list.
export type PermissionResponder = (requestId: string, behavior: PermissionBehavior) => Promise<Result>

type PermissionsProps = {
  requests: readonly AgentPermissionRequest[]
  respond: PermissionResponder
  // Why the agent cannot be answered right now; null when it can.
  blocked: string | null
}

// Pending permission requests, above the composer or in an owner's list of children. A request disappears
// when the runtime no longer lists it.
export function Permissions({ requests, respond, blocked }: PermissionsProps): React.JSX.Element | null {
  if (requests.length === 0) return null
  return (
    <section className="agent-permissions" aria-label="Permission requests">
      {requests.map((request) => (
        <PermissionRequest key={request.id} respond={respond} request={request} blocked={blocked} />
      ))}
    </section>
  )
}

function PermissionRequest({
  respond: send,
  request,
  blocked
}: {
  respond: PermissionResponder
  request: AgentPermissionRequest
  blocked: string | null
}): React.JSX.Element {
  const [sending, setSending] = useState<PermissionBehavior | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const title = request.title ?? request.name

  const respond = async (behavior: PermissionBehavior): Promise<void> => {
    setSending(behavior)
    setFailure(null)
    const result = await send(request.id, behavior).catch((reason: unknown) => ({ ok: false as const, error: { code: 'failed', message: String(reason) } }))
    if (!result.ok) {
      setSending(null)
      setFailure(result.error.message)
    }
  }

  return (
    <article className="agent-permission" aria-label={`Permission request: ${title}`}>
      <header className="agent-permission__header">
        <span className="cr-badge cr-badge--warning">Permission</span>
        <h4 className="agent-permission__title">{title}</h4>
        <span className="agent-permission__kind mono">{request.kind}</span>
      </header>
      {request.description ? <p className="agent-permission__description">{request.description}</p> : null}
      {request.detail ? <pre className="agent-permission__detail">{request.detail}</pre> : null}
      <div className="agent-permission__actions">
        {blocked ? <span className="agent-permission__blocked">{blocked}</span> : null}
        <button type="button" className="cr-button" disabled={blocked !== null || sending !== null} onClick={() => void respond('deny')}>
          {sending === 'deny' ? 'Denying…' : 'Deny'}
        </button>
        <button
          type="button"
          className="cr-button cr-button--primary"
          disabled={blocked !== null || sending !== null}
          onClick={() => void respond('allow')}
        >
          {sending === 'allow' ? 'Allowing…' : 'Allow'}
        </button>
      </div>
      {failure ? (
        <p className="agent-permission__failure" role="alert">
          Could not answer: {failure}
        </p>
      ) : null}
    </article>
  )
}
