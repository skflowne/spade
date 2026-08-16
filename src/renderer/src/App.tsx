import { useCallback, useMemo, useState } from 'react'
import { Background, ReactFlow, type Edge, type NodeChange, type NodeTypes } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { createNode, spawnConnectedNode } from '@shared/canvasCommands'
import { DOMAIN_RECORD_VERSION, type CanvasNode } from '@shared/domain'
import { EntityRegistry, createDeterministicMockAdapter } from '@shared/entities'
import { applyCanvasNodePositionChanges } from './canvasNodeState'
import { GenericEntityNode, type EntityFlowNode } from './GenericEntityNode'
import './app.css'

const registry = new EntityRegistry()
registry.register({
  type: 'note',
  version: 1,
  displayName: 'Note',
  adapter: createDeterministicMockAdapter<{ body: string }>('note')
})

let nextNodeId = 1
let nextEdgeId = 1
const commandEnvironment = {
  registry,
  createNodeId: () => `node-${nextNodeId++}`,
  createEdgeId: () => `edge-${nextEdgeId++}`,
  now: () => '2026-01-01T00:00:00.000Z'
}

const sourceNode = createNode(commandEnvironment, {
  type: 'note',
  config: { body: 'Issue foundation' },
  placement: {
    position: { x: 120, y: 140 },
    projectId: 'mock-project',
    workItemId: 'mock-work-item',
    workspaceId: null
  },
  title: 'Issue #4',
  shortDescription: 'Canvas-node foundation'
})
const spawned = spawnConnectedNode(commandEnvironment, { nodes: [sourceNode], edges: [] }, {
  sourceNodeId: sourceNode.id,
  type: 'note',
  config: { body: 'Connected node' },
  relation: 'spawned',
  position: { x: 440, y: 140 },
  title: 'Connected node'
})

const initialEntities: readonly CanvasNode[] = [sourceNode, spawned.node]

function toFlowNode(entity: CanvasNode): EntityFlowNode {
  registry.resolve(entity.entityType)

  return {
    id: entity.id,
    type: 'entity',
    position: entity.position,
    dragHandle: '.entity-node__chrome',
    data: { entity }
  }
}

const flowEdges: Edge[] = [spawned.edge].map((edge) => ({
  id: edge.id,
  source: edge.fromNodeId,
  target: edge.toNodeId,
  label: edge.label
}))

const nodeTypes = { entity: GenericEntityNode } satisfies NodeTypes

export function App(): React.JSX.Element {
  const [entities, setEntities] = useState(initialEntities)
  const nodes = useMemo(() => entities.map(toFlowNode), [entities])
  const onNodesChange = useCallback((changes: NodeChange<EntityFlowNode>[]) => {
    setEntities((current) => applyCanvasNodePositionChanges(current, changes))
  }, [])

  return (
    <main className="app-shell">
      <header className="app-header">
        <h1>GADE</h1>
        <span>Core canvas · domain v{DOMAIN_RECORD_VERSION}</span>
      </header>
      <section className="canvas" aria-label="GADE canvas">
        <ReactFlow
          nodes={nodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          nodesConnectable={false}
          elementsSelectable={false}
        >
          <Background />
        </ReactFlow>
      </section>
    </main>
  )
}
