import { Component, useEffect, useId, useMemo, useState, type ErrorInfo, type ReactNode } from 'react'
import { Handle, NodeResizer, Position, type Node, type NodeProps } from '@xyflow/react'
import type { CanvasNode } from '@shared/domain'
import { indexTree } from '@shared/tree'
import { entityRenderers, resolveEntity } from '../entities'
import type { EntityHost, NodeStatus } from '../entities/types'
import { DetailList } from '../ui/fields'
import { MenuButton, type MenuItem } from '../ui/Menu'
import { usePrompts } from '../ui/prompts'
import { StatusBadge } from '../ui/StatusBadge'
import { useCanvasActions, useCanvasData, useCanvasInteraction } from './CanvasContext'
import type { NodeView } from './viewModel'

export type EntityNodeData = { record: CanvasNode; view: NodeView }
export type EntityFlowNode = Node<EntityNodeData, 'entity'>

// React Flow starts node drags only from elements matching this selector: the header (plan §6).
export const DRAG_HANDLE_CLASS = 'spade-node__drag'
const MIN_SIZE = { width: 240, height: 140 }

// The generic node wrapper (plan §6, container-owned behavior) around every entity body.
export function EntityNode({ id, data, selected }: NodeProps<EntityFlowNode>): React.JSX.Element {
  const { record, view } = data
  const { project } = useCanvasData()
  const actions = useCanvasActions()
  const { activeNodeId, picking } = useCanvasInteraction()
  const resolved = useMemo(() => resolveEntity(entityRenderers, record), [record])
  const [status, setStatus] = useState<NodeStatus | null>(null)
  const titleId = useId()
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
      setStatus
    }),
    [actions]
  )

  const Status = resolved.kind === 'ready' ? resolved.renderer.Status : undefined
  const className = [
    'spade-node',
    selected ? 'spade-node--selected' : '',
    active ? 'spade-node--active' : '',
    record.collapsed ? 'spade-node--collapsed' : '',
    picking ? 'spade-node--pickable' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <article className={className} data-testid="canvas-node" data-node-id={id} aria-labelledby={titleId}>
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
        onClick={() => {
          if (!picking) actions.setActiveNode(null)
        }}
      >
        <span className="spade-node__icon" aria-hidden="true">
          {resolved.renderer?.icon ?? '?'}
        </span>
        <div className="spade-node__titles">
          <NodeTitle id={titleId} record={record} />
          <p className="spade-node__meta">
            <span className="spade-node__type">{resolved.definition?.displayName ?? record.entityType}</span>
            {record.shortDescription ? <span className="spade-node__description"> · {record.shortDescription}</span> : null}
          </p>
        </div>
        <div className="spade-node__status">
          {Status && resolved.kind === 'ready' ? <Status node={record} config={resolved.config} project={project} /> : null}
          {status ? <StatusBadge status={status} /> : null}
        </div>
        <NodeControls record={record} view={view} host={host} resolved={resolved} />
      </header>
      {record.collapsed ? null : (
        <div
          className={active ? 'spade-node__body nodrag nowheel nopan' : 'spade-node__body'}
          data-testid="node-body"
          data-active={active}
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
                  detail="full"
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
  const { canvas, project } = useCanvasData()
  const actions = useCanvasActions()
  const prompts = usePrompts()
  const nodeId = record.id
  const hasChildren = view.childCount > 0
  const branchHidden = record.branchCollapsed
  const run = (command: Parameters<typeof actions.execute>[0]): void => void actions.execute(command)

  const removeNode = async (): Promise<void> => {
    const tree = indexTree(canvas)
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
    const count = indexTree(canvas).branchOf(nodeId).length
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
      { label: 'Archive node', onSelect: () => run({ type: 'archiveNode', nodeId }) },
      ...(hasChildren ? [{ label: 'Archive branch', onSelect: () => run({ type: 'archiveBranch', nodeId }) }] : []),
      { label: 'Remove node…', onSelect: () => void removeNode(), danger: true },
      ...(hasChildren ? [{ label: 'Remove branch…', onSelect: () => void removeBranch(), danger: true }] : [])
    ]
  }

  return (
    <div className="spade-node__controls nodrag">
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
