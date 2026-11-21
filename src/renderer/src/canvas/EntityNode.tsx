import { Component, useEffect, useId, useMemo, useState, type ErrorInfo, type ReactNode } from 'react'
import { Handle, NodeResizer, Position, useReactFlow, useStore, type Node, type NodeProps } from '@xyflow/react'
import type { CanvasNode } from '@shared/domain'
import { entityRenderers, resolveEntity } from '../entities'
import type { EntityHost, NodeStatus } from '../entities/types'
import { useSpadeStore } from '../store/hooks'
import { DetailList } from '../ui/fields'
import { MenuButton, type MenuItem } from '../ui/Menu'
import { usePrompts } from '../ui/prompts'
import { StatusBadge } from '../ui/StatusBadge'
import { useAgentChange, useCanvasActions, useCanvasInteraction, useCanvasProject } from './CanvasContext'
import { archivedEntryOf } from './model/archivedNodes'
import { canvasIndex } from './model/canvasIndex'
import { detailForZoom } from './model/levelOfDetail'
import { RelatedMenu } from './RelatedMenu'
import type { NodeView } from './viewModel'

export type EntityNodeData = { record: CanvasNode; view: NodeView }
export type EntityFlowNode = Node<EntityNodeData, 'entity'>

// React Flow starts node drags only from elements matching this selector: the header (plan §6).
export const DRAG_HANDLE_CLASS = 'spade-node__drag'
const MIN_SIZE = { width: 240, height: 140 }

// The generic node wrapper (plan §6, container-owned behavior) around every entity body.
export function EntityNode({ id, data, selected }: NodeProps<EntityFlowNode>): React.JSX.Element {
  const { record, view } = data
  const project = useCanvasProject()
  const actions = useCanvasActions()
  const { activeNodeId, picking } = useCanvasInteraction()
  const resolved = useMemo(() => resolveEntity(entityRenderers, record), [record])
  const [status, setStatus] = useState<NodeStatus | null>(null)
  const [attention, setAttention] = useState(false)
  const store = useSpadeStore()
  // A primitive selector: the node re-renders when the zoom crosses the threshold, not on every zoom frame.
  const detail = useStore((state) => detailForZoom(state.transform[2]))
  const agentChange = useAgentChange(id)
  const titleId = useId()
  const revealOnScreen = useRevealOnScreen()
  const typeName = resolved.definition?.displayName ?? record.entityType
  const active = activeNodeId === id && !record.collapsed
  // A body's status describes the mounted body; collapsing unmounts it.
  useEffect(() => {
    if (record.collapsed) setStatus(null)
  }, [record.collapsed])

  const host = useMemo<EntityHost>(
    () => ({
      execute: actions.execute,
      requestSpawn: actions.requestSpawn,
      focusNode: (nodeId) => actions.focusNode(nodeId),
      setStatus,
      notify: (message) => store.notify(message)
    }),
    [actions, store]
  )

  const Status = resolved.kind === 'ready' ? resolved.renderer.Status : undefined
  const className = [
    'spade-node',
    selected ? 'spade-node--selected' : '',
    attention ? 'spade-node--attention' : '',
    active ? 'spade-node--active' : '',
    record.collapsed ? 'spade-node--collapsed' : '',
    picking ? 'spade-node--pickable' : '',
    detail === 'preview' ? 'spade-node--preview' : '',
    agentChange ? 'spade-node--agent-changed' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <article className={className} data-testid="canvas-node" data-node-id={id} data-detail={detail} aria-labelledby={titleId}>
      <NodeResizer
        isVisible={!record.collapsed && !picking}
        minWidth={MIN_SIZE.width}
        minHeight={MIN_SIZE.height}
        lineClassName="spade-node__resize-line"
        handleClassName="spade-node__resize-handle"
        onResizeEnd={(_event, params) => actions.finishResize(id, params)}
      />
      <Handle type="target" position={Position.Left} isConnectable={false} className="spade-node__handle" />
      <header
        className={`spade-node__header ${DRAG_HANDLE_CLASS}`}
        data-testid="node-header"
        role="group"
        aria-label={`${record.title}, ${typeName}`}
        aria-describedby={record.collapsed ? undefined : `${titleId}-hint`}
        tabIndex={0}
        onClick={() => {
          if (!picking) actions.setActiveNode(null)
        }}
        onFocus={(event) => {
          if (event.target !== event.currentTarget) return
          actions.setCurrentNode(id)
          if (event.currentTarget.matches(':focus-visible')) revealOnScreen(event.currentTarget)
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || event.key !== 'Enter' || record.collapsed || picking) return
          event.preventDefault()
          actions.setActiveNode(id)
        }}
      >
        <span className="spade-node__icon" aria-hidden="true">
          {resolved.renderer?.icon ?? '?'}
        </span>
        <div className="spade-node__titles">
          <NodeTitle id={titleId} record={record} />
          <p className="spade-node__meta">
            <span className="spade-node__type">{typeName}</span>
            {agentChange ? (
              <span
                className="spade-node__agent-change"
                data-testid="agent-change-marker"
                title={`${agentChange.summary} (${new Date(agentChange.at).toLocaleTimeString()})`}
              >
                Changed by {agentChange.agentLabel}
              </span>
            ) : null}
            {record.shortDescription ? <span className="spade-node__description"> · {record.shortDescription}</span> : null}
          </p>
          {record.collapsed ? null : (
            <span id={`${titleId}-hint`} hidden>
              Press Enter to use its content, Escape to return.
            </span>
          )}
        </div>
        <div className="spade-node__status">
          {Status && resolved.kind === 'ready' ? <Status node={record} config={resolved.config} project={project} setAttention={setAttention} /> : null}
          {status ? <StatusBadge status={status} /> : null}
        </div>
        <NodeControls record={record} view={view} host={host} resolved={resolved} />
      </header>
      {view.parentArchived ? <ParentArchived nodeId={id} /> : null}
      {record.collapsed ? null : (
        <div
          className={active ? 'spade-node__body nodrag nowheel nopan' : 'spade-node__body'}
          data-testid="node-body"
          data-active={active}
          data-detail={detail}
          onClick={() => {
            if (!picking && !active) actions.setActiveNode(id)
          }}
        >
          <div className="spade-node__content" inert={!active}>
            <BodyBoundary key={record.entityType}>
              {resolved.kind === 'ready' ? (
                <resolved.renderer.Body
                  node={record}
                  config={resolved.config}
                  project={project}
                  active={active}
                  detail={detail}
                  host={host}
                />
              ) : (
                <FallbackBody record={record} problem={resolved.problem} />
              )}
            </BodyBoundary>
          </div>
        </div>
      )}
      <Handle type="source" position={Position.Right} isConnectable={false} className="spade-node__handle" />
    </article>
  )
}

function NodeTitle({ id, record }: { id: string; record: CanvasNode }): React.JSX.Element {
  const actions = useCanvasActions()
  const [draft, setDraft] = useState<string | null>(null)

  const commit = (): void => {
    const title = draft?.trim()
    setDraft(null)
    if (title && title !== record.title) {
      void actions.execute({ type: 'updateNode', nodeId: record.id, patch: { title } })
    }
  }

  return (
    <h3 id={id} className="spade-node__title" onDoubleClick={() => setDraft(record.title)} title={record.title}>
      {draft === null ? (
        record.title
      ) : (
        <input
          className="spade-node__title-input nodrag"
          aria-label="Node title"
          value={draft}
          autoFocus
          onFocus={(event) => event.target.select()}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'Enter') commit()
            if (event.key === 'Escape') setDraft(null)
          }}
        />
      )}
    </h3>
  )
}

function NodeControls({
  record,
  view,
  host,
  resolved
}: {
  record: CanvasNode
  view: NodeView
  host: EntityHost
  resolved: ReturnType<typeof resolveEntity>
}): React.JSX.Element {
  const project = useCanvasProject()
  const actions = useCanvasActions()
  const store = useSpadeStore()
  const prompts = usePrompts()
  const nodeId = record.id
  const hasChildren = view.childCount > 0
  const branchHidden = record.branchCollapsed
  const run = (command: Parameters<typeof actions.execute>[0]): void => void actions.execute(command)

  // Archiving is undoable from the confirmation it shows.
  const archive = async (branch: boolean): Promise<void> => {
    const count = branch ? canvasIndex(actions.getCanvas()).tree.branchOf(nodeId).length : 1
    const response = await actions.execute({ type: branch ? 'archiveBranch' : 'archiveNode', nodeId })
    if (!response.ok) return
    const what = branch ? `the branch “${record.title}” (${count} ${count === 1 ? 'node' : 'nodes'})` : `“${record.title}”`
    store.inform(`Archived ${what}.`, {
      label: 'Undo',
      run: () => void actions.execute({ type: 'restoreNode', nodeId, ...(branch ? { branch: true } : {}) })
    })
  }

  const removeNode = async (): Promise<void> => {
    const canvas = actions.getCanvas()
    const tree = canvasIndex(canvas).tree
    const children = tree.childrenOf(nodeId).length
    const parentId = tree.parentOf(nodeId)
    const parentTitle = canvas.nodes.find((node) => node.id === parentId)?.title
    const consequence =
      children === 0
        ? 'It has no children.'
        : `Its ${children} ${children === 1 ? 'child moves' : 'children move'} up to ${parentTitle ?? 'the top level as new roots'}.`
    const confirmed = await prompts.confirm({
      title: `Remove ${record.title}?`,
      message: (
        <>
          <p>{consequence}</p>
          <p>Only SPADE's record of the node is removed. Nothing on disk or in Paseo is deleted.</p>
        </>
      ),
      confirmLabel: 'Remove node',
      danger: true
    })
    if (confirmed) run({ type: 'removeNode', nodeId })
  }

  const removeBranch = async (): Promise<void> => {
    const count = canvasIndex(actions.getCanvas()).tree.branchOf(nodeId).length
    const confirmed = await prompts.confirm({
      title: `Remove the branch ${record.title}?`,
      message: (
        <>
          <p>
            {record.title} and everything below it are removed from the canvas: {count} {count === 1 ? 'node' : 'nodes'}.
          </p>
          <p>Only SPADE's records are removed. Nothing on disk or in Paseo is deleted.</p>
        </>
      ),
      confirmLabel: 'Remove branch',
      danger: true
    })
    if (confirmed) run({ type: 'removeBranch', nodeId })
  }

  const items = (): MenuItem[] => {
    const entityItems: MenuItem[] =
      resolved.kind === 'ready' && resolved.renderer.menuActions
        ? resolved.renderer
            .menuActions({ node: record, config: resolved.config, project, host })
            .map((action) => ({ label: action.label, onSelect: action.onSelect, disabled: action.disabled, danger: action.danger }))
        : []
    return [
      ...entityItems,
      ...(entityItems.length > 0 ? (['separator'] as const) : []),
      { label: 'Spawn connected…', onSelect: () => actions.openCreate({ sourceNodeId: nodeId }) },
      { label: 'Connect existing…', onSelect: () => void actions.connectExisting(nodeId) },
      { label: 'Move to…', onSelect: () => actions.openMove(nodeId) },
      'separator',
      { label: 'Fit', onSelect: () => actions.focusNode(nodeId, 'fit') },
      { label: 'Full height', onSelect: () => actions.focusNode(nodeId, 'full-height') },
      'separator',
      record.collapsed
        ? { label: 'Expand node', onSelect: () => run({ type: 'expandNode', nodeId }) }
        : { label: 'Collapse node', onSelect: () => run({ type: 'collapseNode', nodeId }) },
      ...(hasChildren
        ? [
            branchHidden
              ? { label: 'Expand branch', onSelect: () => run({ type: 'expandBranch', nodeId }) }
              : { label: 'Collapse branch', onSelect: () => run({ type: 'collapseBranch', nodeId }) }
          ]
        : []),
      'separator',
      { label: 'Archive node', onSelect: () => void archive(false) },
      ...(hasChildren ? [{ label: 'Archive branch', onSelect: () => void archive(true) }] : []),
      { label: 'Remove node…', onSelect: () => void removeNode(), danger: true },
      ...(hasChildren ? [{ label: 'Remove branch…', onSelect: () => void removeBranch(), danger: true }] : [])
    ]
  }

  return (
    <div className="spade-node__controls nodrag">
      <RelatedMenu record={record} referenceCount={view.referenceCount} />
      {hasChildren ? (
        <button
          type="button"
          className={branchHidden ? 'cr-icon-button spade-node__branch spade-node__branch--hidden' : 'cr-icon-button spade-node__branch'}
          aria-label={branchHidden ? `Expand branch (${view.hiddenDescendantCount} hidden)` : 'Collapse branch'}
          title={branchHidden ? `Expand branch (${view.hiddenDescendantCount} hidden)` : 'Collapse branch'}
          onClick={(event) => {
            event.stopPropagation()
            run({ type: branchHidden ? 'expandBranch' : 'collapseBranch', nodeId })
          }}
        >
          {branchHidden ? `+${view.hiddenDescendantCount}` : '⊟'}
        </button>
      ) : null}
      <button
        type="button"
        className="cr-icon-button"
        aria-label={record.collapsed ? 'Expand node' : 'Collapse node'}
        title={record.collapsed ? 'Expand node' : 'Collapse node'}
        onClick={(event) => {
          event.stopPropagation()
          run({ type: record.collapsed ? 'expandNode' : 'collapseNode', nodeId })
        }}
      >
        {record.collapsed ? '▸' : '▾'}
      </button>
      <MenuButton label="Node actions" menuLabel={`Actions for ${record.title}`} className="cr-icon-button" items={items}>
        ⋯
      </MenuButton>
    </div>
  )
}

// A node whose parent is archived has no edge to it; this says why and leads to the archived parent.
function ParentArchived({ nodeId }: { nodeId: string }): React.JSX.Element {
  const actions = useCanvasActions()
  return (
    <button
      type="button"
      className="spade-node__orphan nodrag"
      data-testid="parent-archived"
      onClick={(event) => {
        event.stopPropagation()
        const index = canvasIndex(actions.getCanvas())
        const parent = index.tree.parentOf(nodeId)
        actions.openPanel('archived', (parent && archivedEntryOf(index, parent)) ?? undefined)
      }}
    >
      Parent archived · Show
    </button>
  )
}

// Keyboard focus on a node outside the screen pans the canvas to it, at the current zoom.
function useRevealOnScreen(): (element: HTMLElement) => void {
  const flow = useReactFlow()
  return (element) => {
    const pane = element.closest('.react-flow')?.getBoundingClientRect()
    const node = element.closest('.react-flow__node')?.getBoundingClientRect()
    if (!pane || !node) return
    const inside = node.left >= pane.left && node.top >= pane.top && node.left < pane.right && node.top < pane.bottom
    if (inside) return
    const { x, y, zoom } = flow.getViewport()
    void flow.setViewport({
      zoom,
      x: x + (pane.left + pane.width / 2) - (node.left + Math.min(node.width, pane.width) / 2),
      y: y + (pane.top + pane.height / 2) - (node.top + Math.min(node.height, pane.height) / 2)
    })
  }
}

function FallbackBody({ record, problem }: { record: CanvasNode; problem: string }): React.JSX.Element {
  return (
    <div className="entity-summary entity-summary--fallback">
      <p className="entity-summary__problem">{problem}</p>
      <DetailList
        rows={[
          ['Type', <span className="mono">{record.entityType}</span>],
          ['Settings', <pre className="mono entity-summary__json">{JSON.stringify(record.config, null, 2)}</pre>]
        ]}
      />
    </div>
  )
}

// One failing entity renderer must never take down the canvas.
class BodyBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('An entity renderer failed', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="entity-summary entity-summary--fallback">
          <p className="entity-summary__problem">This node's content could not be shown: {this.state.error.message}</p>
        </div>
      )
    }
    return this.props.children
  }
}
