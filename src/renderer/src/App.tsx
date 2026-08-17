import { useCallback, useMemo, useState } from 'react'
import {
  Background,
  MiniMap,
  ReactFlow,
  type NodeTypes,
  type OnNodeDrag,
  type Viewport
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { DOMAIN_RECORD_VERSION } from '@shared/domain'
import { applyCanvasNodePositionChanges } from './canvasNodeState'
import { CanvasGroupNode } from './CanvasGroupNode'
import {
  canonicalNodePosition,
  defaultDedicatedViewport,
  defaultGlobalViewport,
  projectCanvas,
  projectSummary,
  type NavigationMode,
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

export function App(): React.JSX.Element {
  const [navigation, setNavigation] = useState<NavigationMode>('dedicated')
  const [grouping, setGrouping] = useState<WorkItemGrouping>('hull')
  const [selectedProjectId, setSelectedProjectId] = useState(projectPrototypeRecords.projects[0].id)
  const [projectsExpanded, setProjectsExpanded] = useState(true)
  const [projectViewports, setProjectViewports] = useState<ProjectViewports>({})
  const [entities, setEntities] = useState(projectPrototypeRecords.nodes)
  const records = useMemo(
    () => ({ ...projectPrototypeRecords, nodes: entities }),
    [entities]
  )
  const projection = useMemo(
    () => projectCanvas(records, navigation, grouping, selectedProjectId),
    [records, navigation, grouping, selectedProjectId]
  )
  const selectedProject = records.projects.find(({ id }) => id === selectedProjectId) ?? records.projects[0]
  const defaultViewport = navigation === 'dedicated'
    ? projectViewport(projectViewports, selectedProjectId, defaultDedicatedViewport)
    : defaultGlobalViewport
  const flowKey = navigation === 'dedicated' ? `project-${selectedProjectId}` : 'global'

  const onNodeDragStop: OnNodeDrag<PrototypeFlowNode> = useCallback((_, node) => {
    if (node.type !== 'entity') return

    const position = canonicalNodePosition(projection.nodes, node.id, node.position)
    setEntities((current) => applyCanvasNodePositionChanges(current, [{
      id: node.id,
      type: 'position',
      position,
      dragging: false
    }]))
  }, [projection.nodes])

  const onMoveEnd = useCallback((_: MouseEvent | TouchEvent | null, viewport: Viewport) => {
    if (navigation === 'dedicated') {
      setProjectViewports((current) => rememberProjectViewport(current, selectedProjectId, viewport))
    }
  }, [navigation, selectedProjectId])

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <h1>SPADE</h1>
          <span>Project organization prototype · domain v{DOMAIN_RECORD_VERSION}</span>
        </div>
        <div className="comparison-controls" aria-label="Prototype comparison controls">
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
      </header>

      <div className="workspace-shell">
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
                const selected = navigation === 'dedicated' && project.id === selectedProjectId
                return (
                  <button
                    type="button"
                    key={project.id}
                    className="project-link"
                    aria-current={selected ? 'page' : undefined}
                    onClick={() => {
                      setSelectedProjectId(project.id)
                      setNavigation('dedicated')
                    }}
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
          <div className="prototype-note">
            <span>Shared mock records</span>
            <strong>{records.workItems.length} issues · {records.workspaces.length} workspaces</strong>
            <p>Switching views changes only the projection. No records are copied or persisted.</p>
          </div>
        </aside>

        <section className="canvas-panel">
          <div className="canvas-panel__heading">
            <div>
              <span>{navigation === 'dedicated' ? 'Dedicated canvas' : 'All projects'}</span>
              <strong>{navigation === 'dedicated' ? selectedProject.name : 'Global project canvas'}</strong>
            </div>
            <p>{navigation === 'dedicated'
              ? 'Pan or zoom, switch projects, then return to restore this viewport.'
              : 'Four project boundaries expose cross-project density and status.'}</p>
          </div>
          <section className="canvas" aria-label="SPADE canvas">
            <ReactFlow
              key={flowKey}
              nodes={projection.nodes}
              edges={projection.edges}
              nodeTypes={nodeTypes}
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
