import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  MiniMap,
  ReactFlow,
  useNodesState,
  type NodeTypes,
  type OnNodeDrag,
  type Viewport
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { applyCanvasNodePositionChanges } from './canvasNodeState'
import { CanvasGroupNode } from './CanvasGroupNode'
import {
  canonicalNodePosition,
  defaultDedicatedViewport,
  defaultGlobalViewport,
  projectCanvas,
  projectSummary,
  type NavigationMode,
  type ProjectLayout,
  type PrototypeFlowNode,
  type WorkItemGrouping
} from './canvasProjection'
import { GenericEntityNode } from './GenericEntityNode'
import { projectPrototypeRecords } from './projectPrototypeData'
import {
  projectViewport,
  rememberProjectViewport,
  type ProjectViewports
} from './projectViewportState'
import './app.css'

const nodeTypes = {
  entity: GenericEntityNode,
  projectGroup: CanvasGroupNode,
  workItemGroup: CanvasGroupNode,
  hull: CanvasGroupNode
} satisfies NodeTypes

type HullDragSession = {
  nodeId: string
  startPosition: PrototypeFlowNode['position']
  memberPositions: ReadonlyMap<string, PrototypeFlowNode['position']>
}

function measuredNodeSize(node: PrototypeFlowNode): ProjectLayout['size'] | null {
  const width = node.measured?.width ?? Number.parseFloat(String(node.style?.width ?? ''))
  const height = node.measured?.height ?? Number.parseFloat(String(node.style?.height ?? ''))
  return width > 0 && height > 0 ? { width, height } : null
}

export function App(): React.JSX.Element {
  const [navigation, setNavigation] = useState<NavigationMode>('dedicated')
  const [grouping, setGrouping] = useState<WorkItemGrouping>('hull')
  const [selectedProjectId, setSelectedProjectId] = useState(projectPrototypeRecords.projects[0].id)
  const [projectsExpanded, setProjectsExpanded] = useState(true)
  const [controlsOpen, setControlsOpen] = useState(false)
  const [projectViewports, setProjectViewports] = useState<ProjectViewports>({})
  const [projectLayouts, setProjectLayouts] = useState<Record<string, ProjectLayout>>({})
  const [entities, setEntities] = useState(projectPrototypeRecords.nodes)
  const hullDrag = useRef<HullDragSession | null>(null)
  const records = useMemo(
    () => ({ ...projectPrototypeRecords, nodes: entities }),
    [entities]
  )
  const projection = useMemo(
    () => projectCanvas(records, navigation, grouping, selectedProjectId, projectLayouts),
    [records, navigation, grouping, selectedProjectId, projectLayouts]
  )
  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState<PrototypeFlowNode>(projection.nodes)
  const defaultViewport = navigation === 'dedicated'
    ? projectViewport(projectViewports, selectedProjectId, defaultDedicatedViewport)
    : defaultGlobalViewport
  const flowKey = navigation === 'dedicated' ? `project-${selectedProjectId}` : 'global'

  useLayoutEffect(() => setFlowNodes(projection.nodes), [projection.nodes, setFlowNodes])

  const onNodeDragStart: OnNodeDrag<PrototypeFlowNode> = useCallback((_, node) => {
    const parent = node.parentId ? flowNodes.find(({ id }) => id === node.parentId) : undefined
    if (parent?.type === 'projectGroup') {
      setFlowNodes((current) => current.map((candidate) => candidate.id === node.id
        ? { ...candidate, expandParent: true }
        : candidate))
    }

    if (node.type === 'hull' && node.data.workItemId) {
      hullDrag.current = {
        nodeId: node.id,
        startPosition: node.position,
        memberPositions: new Map(flowNodes
          .filter((candidate) => candidate.type === 'entity' && candidate.data.entity.workItemId === node.data.workItemId)
          .map((candidate) => [candidate.id, candidate.position]))
      }
    }
  }, [flowNodes, setFlowNodes])

  const onNodeDrag: OnNodeDrag<PrototypeFlowNode> = useCallback((_, node) => {
    const drag = hullDrag.current
    if (!drag || drag.nodeId !== node.id) return

    const delta = {
      x: node.position.x - drag.startPosition.x,
      y: node.position.y - drag.startPosition.y
    }
    setFlowNodes((current) => current.map((candidate) => {
      const startPosition = drag.memberPositions.get(candidate.id)
      return startPosition
        ? { ...candidate, position: { x: startPosition.x + delta.x, y: startPosition.y + delta.y } }
        : candidate
    }))
  }, [setFlowNodes])

  const onNodeDragStop: OnNodeDrag<PrototypeFlowNode> = useCallback((_, node) => {
    hullDrag.current = null
    const finalFlowNodes = flowNodes.map((candidate) => candidate.id === node.id ? node : candidate)
    const visibleProjectLayouts = finalFlowNodes.flatMap((candidate) => {
      if (candidate.type !== 'projectGroup') return []
      const size = measuredNodeSize(candidate)
      return size ? [[candidate.data.projectId, { position: candidate.position, size }] as const] : []
    })

    if (visibleProjectLayouts.length > 0) {
      setProjectLayouts((current) => ({ ...current, ...Object.fromEntries(visibleProjectLayouts) }))
    }

    const positionChanges = finalFlowNodes.flatMap((candidate) => candidate.type === 'entity'
      ? [{
          id: candidate.id,
          type: 'position' as const,
          position: canonicalNodePosition(finalFlowNodes, candidate.id, candidate.position),
          dragging: false
        }]
      : [])
    setEntities((current) => applyCanvasNodePositionChanges(current, positionChanges))
  }, [flowNodes])

  const onMoveEnd = useCallback((_: MouseEvent | TouchEvent | null, viewport: Viewport) => {
    if (navigation === 'dedicated') {
      setProjectViewports((current) => rememberProjectViewport(current, selectedProjectId, viewport))
    }
  }, [navigation, selectedProjectId])

  return (
    <main className="app-shell">
      <div className={`workspace-shell workspace-shell--${navigation}`}>
        {navigation === 'dedicated' && (
          <aside className="project-sidebar" aria-label="Projects">
            <button
              type="button"
              className="project-sidebar__heading"
              aria-expanded={projectsExpanded}
              onClick={() => setProjectsExpanded((expanded) => !expanded)}
            >
              <span>Projects</span>
              <span>{records.projects.length} {projectsExpanded ? '−' : '+'}</span>
            </button>
            {projectsExpanded && (
              <nav aria-label="Project canvases">
                {records.projects.map((project) => {
                  const accent = records.projectAccents[project.id]
                  const selected = project.id === selectedProjectId
                  return (
                    <button
                      type="button"
                      key={project.id}
                      className="project-link"
                      aria-current={selected ? 'page' : undefined}
                      onClick={() => setSelectedProjectId(project.id)}
                    >
                      <i style={{ background: accent.color }} />
                      <span><strong>{project.name}</strong><small>{projectSummary(records, project.id)}</small></span>
                      {projectViewports[project.id] && (
                        <code aria-label={`${project.name} saved zoom`}>
                          {Math.round(projectViewports[project.id].zoom * 100)}%
                        </code>
                      )}
                    </button>
                  )
                })}
              </nav>
            )}
          </aside>
        )}

        <section className="canvas-panel">
          <section className="canvas" aria-label="SPADE canvas">
            <ReactFlow
              key={flowKey}
              nodes={flowNodes}
              edges={projection.edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onNodeDragStart={onNodeDragStart}
              onNodeDrag={onNodeDrag}
              onNodeDragStop={onNodeDragStop}
              onMoveEnd={onMoveEnd}
              defaultViewport={defaultViewport}
              minZoom={0.2}
              maxZoom={1.5}
              nodesConnectable={false}
              elementsSelectable
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={24} size={1} />
              <MiniMap pannable zoomable nodeStrokeWidth={2} />
            </ReactFlow>
          </section>
        </section>
      </div>

      <div className="prototype-controls">
        <button
          type="button"
          className="prototype-controls__trigger"
          aria-expanded={controlsOpen}
          aria-controls="prototype-controls-panel"
          onClick={() => setControlsOpen((open) => !open)}
        >
          Prototype controls
        </button>
        {controlsOpen && (
          <div
            id="prototype-controls-panel"
            className="comparison-controls"
            aria-label="Prototype comparison controls"
          >
            <ToggleGroup label="Navigation">
              <ToggleButton active={navigation === 'dedicated'} onClick={() => setNavigation('dedicated')}>
                Project canvases
              </ToggleButton>
              <ToggleButton active={navigation === 'global'} onClick={() => setNavigation('global')}>
                Global canvas
              </ToggleButton>
            </ToggleGroup>
            <ToggleGroup label="Work-item grouping">
              <ToggleButton active={grouping === 'hull'} onClick={() => setGrouping('hull')}>
                Visual hull
              </ToggleButton>
              <ToggleButton active={grouping === 'parent'} onClick={() => setGrouping('parent')}>
                Parent groups
              </ToggleButton>
            </ToggleGroup>
          </div>
        )}
      </div>
    </main>
  )
}

function ToggleGroup({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return <div className="toggle-group"><span>{label}</span><div>{children}</div></div>
}

function ToggleButton({
  active,
  onClick,
  children
}: {
  active: boolean
  onClick(): void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button type="button" aria-pressed={active} onClick={onClick}>
      {children}
    </button>
  )
}
