import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStoreApi,
  type Edge,
  type EdgeChange,
  type EdgeTypes,
  type FitViewOptions,
  type NodeChange,
  type NodeTypes,
  type OnNodeDrag
} from '@xyflow/react'
import type { CanvasCommand } from '@shared/commands'
import type { Canvas, CanvasNode, Point, Project, Rect, Size, Viewport } from '@shared/domain'
import { entities } from '../entities'
import type { SpawnRequest } from '../entities/types'
import { useCanvas, useSession, useSpadeStore } from '../store/hooks'
import { usePrompts } from '../ui/prompts'
import {
  AgentChangeContext,
  CanvasActionsContext,
  CanvasDataContext,
  CanvasInteractionContext,
  CanvasNavigationContext,
  CanvasProjectContext,
  type CanvasActions,
  type CanvasData,
  type CanvasNavigation,
  type PanelId
} from './CanvasContext'
import { REFERENCE_EDGE_TYPE, ReferenceEdge, type ReferenceEdgeData } from './edges/ReferenceEdge'
import { DRAG_HANDLE_CLASS, EntityNode, type EntityFlowNode } from './EntityNode'
import { canvasOverlays, canvasSidePanels } from './extensions'
import { useAgentChanges } from './markers/useAgentChanges'
import { canvasIndex } from './model/canvasIndex'
import { currentFocus, EMPTY_FOCUS_HISTORY, pushFocus, stepFocus, type FocusHistory } from './model/focusHistory'
import { overviewTitleScale } from './model/levelOfDetail'
import { relatedTarget } from './model/relatedNodes'
import { canvasShortcut } from './model/shortcuts'
import { focusNodeHeader, isOnNodeHeader } from './nodeFocus'
import { MINIMAP_BAND } from './overview/CanvasMiniMap'
import { MoveDialog } from './spawn/MoveDialog'
import { SpawnDialog, type SpawnDialogMode } from './spawn/SpawnDialog'
import { SpawnRequests, type SpawnEntry } from './spawn/spawnRequests'
import { Toolbar } from './Toolbar'
import { branchMoves, canvasView, type CanvasView, type EdgeView, type NodeView } from './viewModel'
import { FOCUS_MARGIN, focusViewport, type FocusMode } from './viewportMath'

const ZOOM_LIMITS = { minZoom: 0.1, maxZoom: 2 }
const FIT_PADDING = 0.08
const VIEWPORT_SAVE_DELAY_MS = 400
const nodeTypes: NodeTypes = { entity: EntityNode }
const edgeTypes: EdgeTypes = { [REFERENCE_EDGE_TYPE]: ReferenceEdge }

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

type Picking = { prompt: string; resolve(nodeId: string | null): void }
type PanelState = { id: PanelId; highlight: string | null }

function isFocusable(canvas: Canvas, nodeId: string): boolean {
  const node = canvasIndex(canvas).byId.get(nodeId)
  return node !== undefined && !node.archived
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || target.closest('input, textarea, select, [contenteditable="true"]') !== null
}

function CanvasSurface({ project, canvas }: { project: Project; canvas: Canvas }): React.JSX.Element {
  const store = useSpadeStore()
  const prompts = usePrompts()
  const flow = useReactFlow()
  const flowStore = useStoreApi()
  const container = useRef<HTMLDivElement>(null)
  // Only the nodes and edges shape what is drawn: a viewport or activity push leaves the view and the nodes alone.
  // The store keeps unchanged records (and lists) identical across pushes, which is what these dependencies rely on.
  const view = useMemo(() => canvasView(canvas, entities), [canvas.nodes, canvas.edges])
  const records = useMemo(() => canvasIndex(canvas).byId, [canvas.nodes])

  // Alt+drag moves the whole branch: the node and every descendant.
  const branchDrag = useRef<{ nodeId: string; origins: Map<string, Point> } | null>(null)
  // Positions and sizes the user just changed, shown until the record catches up or the command fails.
  const pending = useRef({ positions: new Map<string, Point>(), sizes: new Map<string, Size>() })
  const [nodes, setNodes] = useState<EntityFlowNode[]>(() => syncNodes([], view, records, pending.current, null))
  const [resync, setResync] = useState(0)
  useEffect(
    () => setNodes((previous) => syncNodes(previous, view, records, pending.current, branchDrag.current?.origins ?? null)),
    [view, records, resync]
  )
  // Only reference edges are selectable; the selection is the one piece of edge state React Flow changes.
  const [selectedEdges, setSelectedEdges] = useState<ReadonlySet<string>>(() => new Set())
  const edges = useMemo(() => view.edges.map((edge) => toFlowEdge(edge, selectedEdges.has(edge.id))), [view, selectedEdges])
  const onEdgesChange = useCallback((changes: EdgeChange<Edge>[]) => {
    const selections = changes.filter((change) => change.type === 'select')
    if (selections.length === 0) return
    setSelectedEdges((current) => {
      const next = new Set(current)
      for (const change of selections) {
        if (change.selected) next.add(change.id)
        else next.delete(change.id)
      }
      return next
    })
  }, [])

  const [initialViewport] = useState(canvas.viewport)
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null)
  const [picking, setPicking] = useState<Picking | null>(null)
  const [spawn, setSpawn] = useState<SpawnEntry<SpawnDialogMode> | null>(null)
  // Set once navigation exists below; a node created from the dialog still shown is focused.
  const focusCreated = useRef<(nodeId: string) => void>(() => {})
  const [spawns] = useState(
    () => new SpawnRequests<SpawnDialogMode>({ show: setSpawn, focusCreated: (nodeId) => focusCreated.current(nodeId) })
  )
  const [moving, setMoving] = useState<string | null>(null)
  const [history, setHistory] = useState<FocusHistory>(EMPTY_FOCUS_HISTORY)
  const [currentNodeId, setCurrentNodeId] = useState<string | null>(null)
  const [panel, setPanel] = useState<PanelState | null>(null)

  const latest = useRef({ view, canvas, picking, history, activeNodeId, currentNodeId })
  latest.current = { view, canvas, picking, history, activeNodeId, currentNodeId }

  useEffect(() => {
    if (activeNodeId !== null && !view.nodes.some((node) => node.id === activeNodeId)) setActiveNodeId(null)
  }, [view, activeNodeId])

  const agentChanges = useAgentChanges(canvas)

  // The overview title scale follows the zoom through a CSS variable, so zooming never re-renders nodes.
  useEffect(() => {
    let zoom = flowStore.getState().transform[2]
    const apply = (): void => container.current?.style.setProperty('--spade-overview-scale', String(overviewTitleScale(zoom)))
    apply()
    return flowStore.subscribe((state) => {
      if (state.transform[2] === zoom) return
      zoom = state.transform[2]
      apply()
    })
  }, [flowStore])

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
    const byId = canvasIndex(latest.current.canvas).byId
    const changed = moves
      .map((move) => ({ nodeId: move.nodeId, position: { x: Math.round(move.position.x), y: Math.round(move.position.y) } }))
      .filter((move) => {
        const record = byId.get(move.nodeId)
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

  const selectNode = useCallback((nodeId: string) => {
    setNodes((current) =>
      current.map((node) => ((node.id === nodeId) === Boolean(node.selected) ? node : { ...node, selected: node.id === nodeId }))
    )
  }, [])

  // Fitting frames the nodes in the canvas area the minimap leaves free.
  const { minimap } = useSession()
  const fitViewOptions = useMemo<FitViewOptions>(
    () => ({
      padding: { x: FIT_PADDING, top: FIT_PADDING, bottom: minimap ? `${MINIMAP_BAND + FOCUS_MARGIN}px` : FIT_PADDING },
      maxZoom: 1
    }),
    [minimap]
  )

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
    selectNode(node.id)
  }, [focusRect, selectNode])
  useEffect(tryFocus, [view, tryFocus])

  // Every focus move goes through here; only explicit moves (not back/forward) are recorded in the history.
  const navigate = useCallback(
    (nodeId: string, mode: FocusMode, record: boolean) => {
      const index = canvasIndex(latest.current.canvas)
      const node = index.byId.get(nodeId)
      if (node?.archived) return
      if (node) {
        for (const ancestor of index.collapsingAncestorsOf(nodeId)) void execute({ type: 'expandBranch', nodeId: ancestor })
      }
      pendingFocus.current = { nodeId, mode }
      setCurrentNodeId(nodeId)
      if (record) setHistory((current) => pushFocus(current, nodeId))
      tryFocus()
    },
    [execute, tryFocus]
  )

  focusCreated.current = (nodeId) => navigate(nodeId, 'readable', true)

  const stepHistory = useCallback(
    (step: -1 | 1) => {
      const next = stepFocus(latest.current.history, step, (id) => isFocusable(latest.current.canvas, id))
      if (!next) return
      latest.current.history = next
      setHistory(next)
      navigate(currentFocus(next)!, 'readable', false)
    },
    [navigate]
  )

  // --- Picking, activation, and keyboard navigation ---

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return
      if (event.key === 'Escape') {
        const current = latest.current.picking
        if (current) {
          // Otherwise the same Escape would also cancel the dialog that reopens when picking ends.
          event.preventDefault()
          setPicking(null)
          current.resolve(null)
        } else if (latest.current.activeNodeId !== null) {
          const nodeId = latest.current.activeNodeId
          setActiveNodeId(null)
          focusNodeHeader(nodeId)
        }
        return
      }
      const shortcut = canvasShortcut(event)
      if (!shortcut || shortcut.kind === 'search') return
      if (latest.current.picking || latest.current.activeNodeId !== null || isEditable(event.target)) return
      if (document.querySelector('dialog[open]')) return
      event.preventDefault()
      if (shortcut.kind === 'history') {
        stepHistory(shortcut.step)
        return
      }
      const from = latest.current.currentNodeId
      if (from === null) return
      const target = relatedTarget(canvasIndex(latest.current.canvas), from, shortcut.direction)
      if (target === null) return
      const onHeader = isOnNodeHeader(document.activeElement)
      navigate(target, 'readable', true)
      if (onHeader) focusNodeHeader(target)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [navigate, stepHistory])

  // --- Actions shared with nodes, dialogs, the toolbar, and extensions ---

  const actions = useMemo<CanvasActions>(() => {
    const pickNode = (prompt: string): Promise<string | null> =>
      new Promise<string | null>((resolve) => {
        latest.current.picking?.resolve(null)
        setPicking({ prompt, resolve })
      })
    return {
      getCanvas: () => latest.current.canvas,
      execute,
      focusNode(nodeId, mode = 'readable') {
        navigate(nodeId, mode, true)
      },
      focusRect,
      fitAll() {
        void flow.fitView({ ...fitViewOptions, minZoom: ZOOM_LIMITS.minZoom })
      },
      goBack: () => stepHistory(-1),
      goForward: () => stepHistory(1),
      setCurrentNode: setCurrentNodeId,
      togglePanel(id) {
        setPanel((current) => (current?.id === id ? null : { id, highlight: null }))
      },
      openPanel(id, highlight) {
        setPanel({ id, highlight: highlight ?? null })
      },
      closePanel: () => setPanel(null),
      async connectExisting(nodeId) {
        const from = canvasIndex(latest.current.canvas).byId.get(nodeId)
        if (!from) return
        const target = await pickNode(`Click the node ${from.title} should reference.`)
        if (target === null) return
        if (target === nodeId) {
          store.notify('A node cannot reference itself.')
          return
        }
        const to = canvasIndex(latest.current.canvas).byId.get(target)
        const label = await prompts.promptText({
          title: `Reference ${to?.title ?? 'node'} from ${from.title}`,
          label: 'Label',
          initialValue: '',
          confirmLabel: 'Connect',
          optional: true,
          hint: 'Optional. Says what the reference is for, e.g. "spec" or "uses".'
        })
        if (label === null) return
        await execute({ type: 'connectNodes', fromNodeId: nodeId, toNodeId: target, ...(label ? { label } : {}) })
      },
      openCreate({ entityType, sourceNodeId }) {
        spawns.open({ kind: 'create', entityType: entityType ?? null, sourceNodeId: sourceNodeId ?? null })
      },
      requestSpawn(request: SpawnRequest) {
        return spawns.open({ kind: 'seeded', request }).result
      },
      openMove: setMoving,
      pickNode,
      setActiveNode: setActiveNodeId,
      finishResize(nodeId, rect) {
        const record = canvasIndex(latest.current.canvas).byId.get(nodeId)
        if (!record) return
        const size = { width: Math.round(rect.width), height: Math.round(rect.height) }
        pending.current.sizes.set(nodeId, size)
        void execute({ type: 'resizeNode', nodeId, size }).then((response) => {
          if (!response.ok) clearPending([nodeId])
        })
        void commitMoves([{ nodeId, position: { x: rect.x, y: rect.y } }])
      }
    }
    // commitMoves and clearPending only touch refs and stable setters.
  }, [execute, focusRect, navigate, stepHistory, flow, fitViewOptions, spawns, store, prompts])

  // --- Dragging ---

  const onNodeDragStart: OnNodeDrag<EntityFlowNode> = (event, node, dragged) => {
    setActiveNodeId(null)
    branchDrag.current = null
    if (!event.altKey || dragged.length !== 1) return
    const record = canvasIndex(latest.current.canvas).byId.get(node.id)
    if (!record) return
    const moves = branchMoves(latest.current.canvas, node.id, record.position)
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
  const navigation = useMemo<CanvasNavigation>(() => {
    const available = (id: string): boolean => isFocusable(canvas, id)
    return {
      panel: panel?.id ?? null,
      panelHighlight: panel?.highlight ?? null,
      currentNodeId: currentNodeId !== null && canvasIndex(canvas).byId.has(currentNodeId) ? currentNodeId : null,
      canGoBack: stepFocus(history, -1, available) !== null,
      canGoForward: stepFocus(history, 1, available) !== null
    }
  }, [panel, currentNodeId, history, canvas])

  const OpenPanel = panel ? canvasSidePanels.find((candidate) => candidate.id === panel.id)?.Panel : undefined

  return (
    <CanvasProjectContext.Provider value={project}>
      <CanvasDataContext.Provider value={data}>
        <CanvasActionsContext.Provider value={actions}>
          <CanvasNavigationContext.Provider value={navigation}>
            <AgentChangeContext.Provider value={agentChanges}>
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
                        edgeTypes={edgeTypes}
                        onNodesChange={onNodesChange}
                        onEdgesChange={onEdgesChange}
                        onNodeDragStart={onNodeDragStart}
                        onNodeDrag={onNodeDrag}
                        onNodeDragStop={onNodeDragStop}
                        onNodeClick={(_event, node) => {
                          const current = latest.current.picking
                          if (!current) {
                            setCurrentNodeId(node.id)
                            return
                          }
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
                        fitViewOptions={fitViewOptions}
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
                    {OpenPanel ? (
                      <aside className="canvas-side-panels" aria-label="Canvas panels">
                        <OpenPanel />
                      </aside>
                    ) : null}
                  </div>
                </div>
                {spawn ? (
                  <SpawnDialog
                    key={spawn.id}
                    mode={spawn.mode}
                    open={picking === null}
                    // Both bound to this dialog's own request, whatever is shown by the time they run.
                    onCreate={(command) => spawns.create(spawn, () => execute(command))}
                    onCancel={() => spawns.dismiss(spawn)}
                  />
                ) : null}
                {moving ? <MoveDialog key={moving} nodeId={moving} open={picking === null} onDone={() => setMoving(null)} /> : null}
              </CanvasInteractionContext.Provider>
            </AgentChangeContext.Provider>
          </CanvasNavigationContext.Provider>
        </CanvasActionsContext.Provider>
      </CanvasDataContext.Provider>
    </CanvasProjectContext.Provider>
  )
}

function sameNodeView(a: NodeView, b: NodeView): boolean {
  return (
    a.position.x === b.position.x &&
    a.position.y === b.position.y &&
    a.size.width === b.size.width &&
    a.size.height === b.size.height &&
    a.hiddenDescendantCount === b.hiddenDescendantCount &&
    a.childCount === b.childCount &&
    a.parentArchived === b.parentArchived &&
    a.referenceCount === b.referenceCount
  )
}

// Rebuilds React Flow's nodes from the records, keeping what React Flow owns (selection, measurements) and
// what the user is changing right now (a drag or resize in progress, a branch carried along by an Alt+drag,
// or a change whose command has not landed).
function syncNodes(
  previous: EntityFlowNode[],
  view: CanvasView,
  records: ReadonlyMap<string, CanvasNode>,
  pending: { positions: Map<string, Point>; sizes: Map<string, Size> },
  carried: ReadonlyMap<string, Point> | null
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

    if (old && (old.dragging || old.resizing || carried?.has(entry.id))) return { ...old, data: { record, view: entry } }
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

function toFlowEdge(edge: EdgeView, selected: boolean): Edge {
  const shared = { id: edge.id, source: edge.source, target: edge.target, className: `spade-edge spade-edge--${edge.relation}` }
  if (edge.relation === 'references') {
    const data: ReferenceEdgeData = { label: edge.label ?? null }
    return {
      ...shared,
      type: REFERENCE_EDGE_TYPE,
      selectable: true,
      focusable: true,
      selected,
      ariaLabel: edge.label === undefined ? 'Reference' : `Reference: ${edge.label}`,
      data
    }
  }
  return {
    ...shared,
    type: 'default',
    selectable: false,
    focusable: false,
    markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--faint)', width: 18, height: 18 },
    ...(edge.label === undefined ? {} : { label: edge.label })
  }
}
