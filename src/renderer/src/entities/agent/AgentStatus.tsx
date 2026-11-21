import { useEffect } from 'react'
import type { AgentConfig } from '@shared/builtinEntities'
import { useAgentRuntime, useSpadeStore } from '../../store/hooks'
import { StatusBadge } from '../../ui/StatusBadge'
import type { EntityStatusProps } from '../types'
import { agentNodeHandles } from './nodeHandles'
import { agentStatusOf } from './status'

// The header badge, shown even while the node is collapsed, so an agent waiting for a permission is
// visible from anywhere on the canvas.
export function AgentStatus({ node, setAttention }: EntityStatusProps<AgentConfig>): React.JSX.Element | null {
  const runtime = useAgentRuntime(node.id)
  const store = useSpadeStore()
  const attention = runtime !== null && (runtime.pendingPermissions.length > 0 || runtime.activity === 'attention')

  useEffect(() => {
    agentNodeHandles.set(node.id, { runtime, notify: (message) => store.notify(message) })
  }, [node.id, runtime, store])
  useEffect(() => () => void agentNodeHandles.delete(node.id), [node.id])

  useEffect(() => {
    setAttention(attention)
  }, [attention, setAttention])
  useEffect(() => () => setAttention(false), [setAttention])

  if (!runtime) return null
  const status = agentStatusOf(runtime)
  const permissions = runtime.pendingPermissions.length
  return (
    <span className="agent-status" data-testid="agent-status">
      <StatusBadge status={status} />
      {permissions > 0 ? (
        <span className="cr-badge cr-badge--warning" title={`${permissions} pending permission ${permissions === 1 ? 'request' : 'requests'}`}>
          {permissions} {permissions === 1 ? 'request' : 'requests'}
        </span>
      ) : null}
    </span>
  )
}
