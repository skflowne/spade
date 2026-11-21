import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type NodeChange,
  type NodeTypes,
  type OnNodeDrag
} from '@xyflow/react'
import type { CanvasCommand } from '@shared/commands'
import type { Canvas, CanvasNode, Point, Project, Rect, Size, Viewport } from '@shared/domain'
import { entities } from '../entities'
import type { SpawnRequest } from '../entities/types'
import { useCanvas, useSpadeStore } from '../store/hooks'
import {
  CanvasActionsContext,
  CanvasDataContext,
  CanvasInteractionContext,
  type CanvasActions,
  type CanvasData
} from './CanvasContext'
import { DRAG_HANDLE_CLASS, EntityNode, type EntityFlowNode } from './EntityNode'
import { canvasOverlays, canvasSidePanels } from './extensions'
import { MoveDialog } from './spawn/MoveDialog'
import { SpawnDialog, type SpawnDialogMode } from './spawn/SpawnDialog'
import { Toolbar } from './Toolbar'
import { branchMoves, canvasView, type CanvasView, type EdgeView, type NodeView } from './viewModel'
import { focusViewport, type FocusMode } from './viewportMath'

const ZOOM_LIMITS = { minZoom: 0.1, maxZoom: 2 }
const VIEWPORT_SAVE_DELAY_MS = 400
const nodeTypes: NodeTypes = { entity: EntityNode }

export function ProjectCanvas({ project }: { project: Project }): React.JSX.Element {
  const canvas = useCanvas(project.id)
  if (!canvas) {
    return (
      <div className="canvas-loading" role="status">
        Loading canvas…
      </div>
    )
  }
  return (
    <ReactFlowProvider>
      <CanvasSurface project={project} canvas={canvas} />
    </ReactFlowProvider>
  )
}

type SpawnState = { mode: SpawnDialogMode; resolve?: (nodeId: string | null) => void }
type Picking = { prompt: string; resolve(nodeId: string | null): void }

function CanvasSurface({ project, canvas }: { project: Project; canvas: Canvas }): React.JSX.Element {
  const store = useSpadeStore()
  const flow = useReactFlow()
  const container = useRef<HTMLDivElement>(null)
  const view = useMemo(() => canvasView(canvas, entities), [canvas])
  const records = useMemo(() => new Map(canvas.nodes.map((node) => [node.id, node])), [canvas])

  // Positions and sizes the user just changed, shown until the record catches up or the command fails.
  const pending = useRef({ positions: new Map<string, Point>(), sizes: new Map<string, Size>() })
  const [nodes, setNodes] = useState<EntityFlowNode[]>(() => syncNodes([], view, records, pending.current))
  const [resync, setResync] = useState(0)
  useEffect(() => setNodes((previous) => syncNodes(previous, view, records, pending.current)), [view, records, resync])
  const edges = useMemo(() => view.edges.map(toFlowEdge), [view])

  const [initialViewport] = useState(canvas.viewport)
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null)
  const [picking, setPicking] = useState<Picking | null>(null)
  const [spawn, setSpawnState] = useState<SpawnState | null>(null)
  const spawnRef = useRef<SpawnState | null>(null)
  // One spawn dialog at a time: a newer request cancels the pending one, whose caller gets null.
  const setSpawn = useCallback((next: SpawnState | null) => {
    const previous = spawnRef.current
    spawnRef.current = next
    setSpawnState(next)
    if (previous && previous !== next) previous.resolve?.(null)
  }, [])
  const [moving, setMoving] = useState<string | null>(null)

  const latest = useRef({ view, canvas, picking })
  latest.current = { view, canvas, picking }

  useEffect(() => {
    if (activeNodeId !== null && !view.nodes.some((node) => node.id === activeNodeId)) setActiveNodeId(null)
  }, [view, activeNodeId])

  // --- Commands ---

  const execute = useCallback((command: CanvasCommand) => store.execute(project.id, command), [store, project.id])

  const clearPending = (ids: Iterable<string>): void => {
    for (const id of ids) {
      pending.current.positions.delete(id)
      pending.current.sizes.delete(id)
    }
    setResync((count) => count + 1)
  }

  const commitMoves = async (moves: Array<{ nodeId: string; position: Point }>): Promise<void> => {
    const changed = moves
      .map((move) => ({ nodeId: move.nodeId, position: { x: Math.round(move.position.x), y: Math.round(move.position.y) } }))
      .filter((move) => {
        const record = latest.current.canvas.nodes.find((node) => node.id === move.nodeId)
        return record && (record.position.x !== move.position.x || record.position.y !== move.position.y)
      })
    if (changed.length === 0) return
    for (const move of changed) pending.current.positions.set(move.nodeId, move.position)
    const response = await execute({ type: 'moveNodes', moves: changed })
    if (!response.ok) clearPending(changed.map((move) => move.nodeId))
  }

  // --- Viewport ---

  const pendingViewport = useRef<{ viewport: Viewport; timer: ReturnType<typeof setTimeout> } | null>(null)
  const flushViewport = useCallback(() => {
    const queued = pendingViewport.current
    if (!queued) return
    clearTimeout(queued.timer)
    pendingViewport.current = null
    const stored = latest.current.canvas.viewport
    const { viewport } = queued
    if (stored && stored.x === viewport.x && stored.y === viewport.y && stored.zoom === viewport.zoom) return
    void store.execute(project.id, { type: 'setViewport', viewport })
  }, [store, project.id])
  useEffect(() => flushViewport, [flushViewport])

  const pendingFocus = useRef<{ nodeId: string; mode: FocusMode } | null>(null)
  const focusRect = useCallback(
    (rect: Rect, mode: FocusMode = 'readable') => {
      const element = container.current
      if (!element) return
      const screen = { width: element.clientWidth, height: element.clientHeight }
      void flow.setViewport(focusViewport(rect, screen, mode, ZOOM_LIMITS))
    },
    [flow]
  )
  const tryFocus = useCallback(() => {
    const target = pendingFocus.current
    if (!target) return
    const node = latest.current.view.nodes.find((candidate) => candidate.id === target.nodeId)
    if (!node) return
    pendingFocus.current = null
    focusRect({ ...node.position, ...node.size }, target.mode)
  }, [focusRect])
  useEffect(tryFocus, [view, tryFocus])

  // --- Picking and activation ---

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const current = latest.current.picking
      if (current) {
        // Otherwise the same Escape would also cancel the dialog that reopens when picking ends.
        event.preventDefault()
        setPicking(null)
        current.resolve(null)
      } else {
        setActiveNodeId(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // --- Actions shared with nodes, dialogs, the toolbar, and extensions ---

  const actions = useMemo<CanvasActions>(
    () => ({
      execute,
      focusNode(nodeId, mode = 'readable') {
        pendingFocus.current = { nodeId, mode }
        tryFocus()
      },
      focusRect,
      fitAll() {
        void flow.fitView({ padding: 0.08, maxZoom: 1, minZoom: ZOOM_LIMITS.minZoom })
      },
      openCreate({ entityType, sourceNodeId }) {
        setSpawn({ mode: { kind: 'create', entityType: entityType ?? null, sourceNodeId: sourceNodeId ?? null } })
      },
      requestSpawn(request: SpawnRequest) {
        return new Promise<string | null>((resolve) => setSpawn({ mode: { kind: 'seeded', request }, resolve }))
      },
      openMove: setMoving,
      pickNode(prompt) {
        return new Promise<string | null>((resolve) => {
          latest.current.picking?.resolve(null)
          setPicking({ prompt, resolve })
        })
      },
      setActiveNode: setActiveNodeId,
      finishResize(nodeId, rect) {
        const record = latest.current.canvas.nodes.find((node) => node.id === nodeId)
        if (!record) return
        const size = { width: Math.round(rect.width), height: Math.round(rect.height) }
        pending.current.sizes.set(nodeId, size)
        void execute({ type: 'resizeNode', nodeId, size }).then((response) => {
          if (!response.ok) clearPending([nodeId])
        })
        void commitMoves([{ nodeId, position: { x: rect.x, y: rect.y } }])
      }
    }),
    // commitMoves and clearPending only touch refs and stable setters.
    [execute, focusRect, tryFocus, flow, setSpawn]
  )

  const finishSpawn = (nodeId: string | null): void => {
    const current = spawnRef.current
    spawnRef.current = null
    setSpawnState(null)
    if (nodeId !== null) actions.focusNode(nodeId)
    current?.resolve?.(nodeId)
  }

  // --- Dragging ---

  // Alt+drag moves the whole branch: the node and every descendant.
  const branchDrag = useRef<{ nodeId: string; origins: Map<string, Point> } | null>(null)

  const onNodeDragStart: OnNodeDrag<EntityFlowNode> = (event, node, dragged) => {
    setActiveNodeId(null)
    branchDrag.current = null
    if (!event.altKey || dragged.length !== 1) return
    const moves = branchMoves(latest.current.canvas, node.id, latest.current.canvas.nodes.find((n) => n.id === node.id)!.position)
    branchDrag.current = { nodeId: node.id, origins: new Map(moves.map((move) => [move.nodeId, move.position])) }
  }

  const onNodeDrag: OnNodeDrag<EntityFlowNode> = (_event, node) => {
    const drag = branchDrag.current
    if (!drag || drag.nodeId !== node.id) return
    const origin = drag.origins.get(node.id)!
    const dx = node.position.x - origin.x
    const dy = node.position.y - origin.y
    setNodes((current) =>
      current.map((candidate) => {
        const start = candidate.id === node.id ? undefined : drag.origins.get(candidate.id)
        return start ? { ...candidate, position: { x: start.x + dx, y: start.y + dy } } : candidate
      })
    )
  }

  const onNodeDragStop: OnNodeDrag<EntityFlowNode> = (_event, node, dragged) => {
    const drag = branchDrag.current
    branchDrag.current = null
    if (drag && drag.nodeId === node.id) {
      void commitMoves(branchMoves(latest.current.canvas, node.id, node.position))
    } else {
      void commitMoves(dragged.map((candidate) => ({ nodeId: candidate.id, position: candidate.position })))
    }
  }

  const onNodesChange = useCallback((changes: NodeChange<EntityFlowNode>[]) => {
    setNodes((current) => applyNodeChanges(changes.filter((change) => change.type !== 'remove'), current))
  }, [])

  const data = useMemo<CanvasData>(() => ({ project, canvas }), [project, canvas])
  const interaction = useMemo(() => ({ activeNodeId, picking: picking !== null }), [activeNodeId, picking])

  return (
    <CanvasDataContext.Provider value={data}>
      <CanvasActionsContext.Provider value={actions}>
        <CanvasInteractionContext.Provider value={interaction}>
          <div className="canvas-frame">
            <Toolbar />
            <div className="canvas-stage">
              <div
                ref={container}
                className={picking ? 'canvas canvas--picking' : 'canvas'}
                data-testid="canvas"
                aria-label={`Canvas of ${project.name}`}
                role="region"
              >
                <ReactFlow<EntityFlowNode, Edge>
                  nodes={nodes}
                  edges={edges}
                  nodeTypes={nodeTypes}
                  onNodesChange={onNodesChange}
                  onNodeDragStart={onNodeDragStart}
                  onNodeDrag={onNodeDrag}
                  onNodeDragStop={onNodeDragStop}
                  onNodeClick={(_event, node) => {
                    const current = latest.current.picking
                    if (!current) return
                    setPicking(null)
                    current.resolve(node.id)
                  }}
                  onPaneClick={() => {
                    if (!latest.current.picking) setActiveNodeId(null)
                  }}
                  onMoveEnd={(_event, viewport) => {
                    if (pendingViewport.current) clearTimeout(pendingViewport.current.timer)
                    pendingViewport.current = { viewport, timer: setTimeout(flushViewport, VIEWPORT_SAVE_DELAY_MS) }
                  }}
                  defaultViewport={initialViewport ?? undefined}
                  fitView={initialViewport === null && canvas.nodes.length > 0}
                  fitViewOptions={{ padding: 0.08, maxZoom: 1 }}
                  minZoom={ZOOM_LIMITS.minZoom}
                  maxZoom={ZOOM_LIMITS.maxZoom}
                  nodesConnectable={false}
                  nodesFocusable={false}
                  edgesFocusable={false}
                  deleteKeyCode={null}
                  zoomOnDoubleClick={false}
                  onlyRenderVisibleElements={false}
                  proOptions={{ hideAttribution: true }}
                  colorMode="dark"
                >
                  <Background variant={BackgroundVariant.Dots} gap={19} size={1} />
                  {canvasOverlays.map((Overlay, index) => (
                    <Overlay key={index} />
                  ))}
                </ReactFlow>
                {picking ? (
                  <div className="picking-banner" data-testid="picking-banner" role="status">
                    <span>{picking.prompt}</span>
                    <kbd>Esc</kbd>
                    <span>to cancel</span>
                  </div>
                ) : null}
              </div>
              {canvasSidePanels.length > 0 ? (
                <aside className="canvas-side-panels" aria-label="Canvas panels">
                  {canvasSidePanels.map((Panel, index) => (
                    <Panel key={index} />
                  ))}
                </aside>
              ) : null}
            </div>
          </div>
          {spawn ? <SpawnDialog key={spawnKey(spawn)} mode={spawn.mode} open={picking === null} onDone={finishSpawn} /> : null}
          {moving ? <MoveDialog key={moving} nodeId={moving} open={picking === null} onDone={() => setMoving(null)} /> : null}
        </CanvasInteractionContext.Provider>
      </CanvasActionsContext.Provider>
    </CanvasDataContext.Provider>
  )
}

function spawnKey(spawn: SpawnState): string {
  return spawn.mode.kind === 'seeded'
    ? `seeded:${spawn.mode.request.sourceNodeId}`
    : `create:${spawn.mode.entityType}:${spawn.mode.sourceNodeId}`
}

function sameNodeView(a: NodeView, b: NodeView): boolean {
  return (
    a.position.x === b.position.x &&
    a.position.y === b.position.y &&
    a.size.width === b.size.width &&
    a.size.height === b.size.height &&
    a.hiddenDescendantCount === b.hiddenDescendantCount &&
    a.childCount === b.childCount
  )
}

// Rebuilds React Flow's nodes from the records, keeping what React Flow owns (selection, measurements) and
// what the user is changing right now (a drag or resize in progress, or one whose command has not landed).
function syncNodes(
  previous: EntityFlowNode[],
  view: CanvasView,
  records: Map<string, CanvasNode>,
  pending: { positions: Map<string, Point>; sizes: Map<string, Size> }
): EntityFlowNode[] {
  const before = new Map(previous.map((node) => [node.id, node]))
  return view.nodes.map((entry) => {
    const record = records.get(entry.id)!
    const old = before.get(entry.id)

    const pendingPosition = pending.positions.get(entry.id)
    if (pendingPosition && pendingPosition.x === record.position.x && pendingPosition.y === record.position.y) {
      pending.positions.delete(entry.id)
    }
    const pendingSize = pending.sizes.get(entry.id)
    if (pendingSize && pendingSize.width === record.size?.width && pendingSize.height === record.size?.height) {
      pending.sizes.delete(entry.id)
    }

    if (old && (old.dragging || old.resizing)) return { ...old, data: { record, view: entry } }
    if (old && old.data.record === record && sameNodeView(old.data.view, entry) && !pending.positions.has(entry.id)) {
      return old
    }
    const position = pending.positions.get(entry.id) ?? entry.position
    const size = record.collapsed ? entry.size : (pending.sizes.get(entry.id) ?? entry.size)
    return {
      id: entry.id,
      type: 'entity',
      position,
      width: size.width,
      height: size.height,
      data: { record, view: entry },
      dragHandle: `.${DRAG_HANDLE_CLASS}`,
      selected: old?.selected ?? false
    }
  })
}

function toFlowEdge(edge: EdgeView): Edge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: 'default',
    className: `spade-edge spade-edge--${edge.relation}`,
    selectable: false,
    focusable: false,
    ...(edge.label === undefined ? {} : { label: edge.label })
  }
}
