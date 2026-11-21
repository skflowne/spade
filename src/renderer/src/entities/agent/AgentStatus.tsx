import { useEffect, useRef } from 'react'
import type { AgentConfig } from '@shared/builtinEntities'
import { useCanvasActions } from '../../canvas/CanvasContext'
import { useAgentRuntime, useSpadeStore } from '../../store/hooks'
import { StatusBadge } from '../../ui/StatusBadge'
import type { EntityStatusProps } from '../types'
import { forgetConversationState, noteTimelineChanged } from './conversationState'
import { agentNodeHandles } from './nodeHandles'
import { agentStatusOf } from './status'

// The header badge, shown even while the node is collapsed, so an agent waiting for a permission is
// visible from anywhere on the canvas. Mounted for as long as the node is on the canvas, it also looks after
// the node's remembered conversation state.
export function AgentStatus({ node, setAttention }: EntityStatusProps<AgentConfig>): React.JSX.Element | null {
  const runtime = useAgentRuntime(node.id)
  const store = useSpadeStore()
  const actions = useCanvasActions()
  const attention = runtime !== null && (runtime.pendingPermissions.length > 0 || runtime.activity === 'attention')
  const resourceState = runtime?.resourceState ?? null

  // Reconnecting to Paseo may change the conversation without a change event reaching an unmounted body.
  const previousState = useRef(resourceState)
  useEffect(() => {
    if (resourceState === 'live' && previousState.current !== 'live') noteTimelineChanged(node.id)
    previousState.current = resourceState
  }, [node.id, resourceState])

  // Unmounting while the node is still on the canvas (another project shown) keeps what the user left there.
  useEffect(
    () => () => {
      if (!actions.getCanvas().nodes.some((candidate) => candidate.id === node.id)) forgetConversationState(node.id)
    },
    [actions, node.id]
  )

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
