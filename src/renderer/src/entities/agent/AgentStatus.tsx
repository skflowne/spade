import { useEffect, useMemo, useRef } from 'react'
import type { AgentConfig } from '@shared/builtinEntities'
import { useCanvasActions } from '../../canvas/CanvasContext'
import { useAgentRuntime, useFinishedAgents, useSpadeStore } from '../../store/hooks'
import { StatusBadge } from '../../ui/StatusBadge'
import type { EntityStatusProps } from '../types'
import { childAttention, needsUser } from './children'
import { forgetConversationState, noteTimelineChanged } from './conversationState'
import { agentNodeHandles } from './nodeHandles'
import { agentStatusOf } from './status'

// The header badge, shown even while the node is collapsed, so an agent waiting for a permission is
// visible from anywhere on the canvas, and so is anything its collapsed Paseo children wait on. It also toggles
// the agents pane. Mounted for as long as the node is on the canvas, it looks after the node's remembered
// conversation state.
export function AgentStatus({ node, setAttention, drawerOpen, setDrawerOpen }: EntityStatusProps<AgentConfig>): React.JSX.Element | null {
  const runtime = useAgentRuntime(node.id)
  const store = useSpadeStore()
  const actions = useCanvasActions()
  const finished = useFinishedAgents()
  const children = runtime?.children
  const fromChildren = useMemo(() => childAttention(children ?? [], finished), [children, finished])
  const attention =
    runtime !== null && (runtime.pendingPermissions.length > 0 || runtime.activity === 'attention' || needsUser(fromChildren))
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
    agentNodeHandles.set(node.id, { runtime, notify: (message) => store.notify(message), getCanvas: actions.getCanvas })
  }, [node.id, runtime, store, actions])
  useEffect(() => () => void agentNodeHandles.delete(node.id), [node.id])

  useEffect(() => {
    setAttention(attention)
  }, [attention, setAttention])
  useEffect(() => () => setAttention(false), [setAttention])

  if (!runtime) return null
  const status = agentStatusOf(runtime)
  const permissions = runtime.pendingPermissions.length
  const agentCount = runtime.children.length + runtime.providerSubagents.length
  const openPane = (): void => setDrawerOpen(true)
  return (
    <span className="agent-status" data-testid="agent-status">
      <StatusBadge status={status} />
      {permissions > 0 ? (
        <span className="cr-badge cr-badge--warning" title={`${permissions} pending permission ${permissions === 1 ? 'request' : 'requests'}`}>
          {permissions} {permissions === 1 ? 'request' : 'requests'}
        </span>
      ) : null}
      {fromChildren.permissions > 0 ? (
        <ChildBadge tone="warning" title="Permission requests from collapsed child agents" onOpen={openPane}>
          {fromChildren.permissions} child {fromChildren.permissions === 1 ? 'request' : 'requests'}
        </ChildBadge>
      ) : null}
      {fromChildren.errors > 0 ? (
        <ChildBadge tone="danger" title="Collapsed child agents in error" onOpen={openPane}>
          {fromChildren.errors} child {fromChildren.errors === 1 ? 'error' : 'errors'}
        </ChildBadge>
      ) : null}
      {fromChildren.finished > 0 ? (
        <ChildBadge tone="success" title="Collapsed child agents that finished a run you have not seen" onOpen={openPane}>
          {fromChildren.finished} {fromChildren.finished === 1 ? 'child' : 'children'} finished
        </ChildBadge>
      ) : null}
      {agentCount > 0 ? (
        <button
          type="button"
          className={`agents-toggle nodrag${needsUser(fromChildren) ? ' agents-toggle--attention' : ''}`}
          aria-expanded={drawerOpen}
          title={drawerOpen ? 'Close the agents pane' : 'Open the agents pane'}
          onClick={() => setDrawerOpen(!drawerOpen)}
        >
          Agents <span className="agents-toggle__count">{agentCount}</span>
        </button>
      ) : null}
    </span>
  )
}

// A header badge for what collapsed children wait on; it opens the agents pane where they can be answered.
function ChildBadge({
  tone,
  title,
  onOpen,
  children
}: {
  tone: 'warning' | 'danger' | 'success'
  title: string
  onOpen(): void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button type="button" className={`cr-badge cr-badge--${tone} agent-status__badge nodrag`} title={`${title}. Open the agents pane.`} onClick={onOpen}>
      {children}
    </button>
  )
}
