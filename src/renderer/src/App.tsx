import { Background, ReactFlow, type Node } from '@xyflow/react'
import {
  CORE_RECORD_VERSIONS,
  type CanvasNode
} from '../../shared/domain'

const foundationNode: CanvasNode = {
  version: CORE_RECORD_VERSIONS.canvasNode,
  id: 'foundation',
  entityType: 'foundation',
  entityVersion: 1,
  title: 'GADE foundation',
  position: { x: 0, y: 0 },
  collapsed: false,
  projectId: 'gade',
  workItemId: null,
  workspaceId: null,
  config: {},
  resourceRef: null,
  createdAt: '2026-08-16T00:00:00.000Z',
  updatedAt: '2026-08-16T00:00:00.000Z'
}

const nodes: Node[] = [
  {
    id: foundationNode.id,
    position: foundationNode.position,
    data: { label: foundationNode.title }
  }
]

export default function App() {
  return (
    <main className="app-shell" aria-label="GADE work canvas">
      <ReactFlow nodes={nodes} edges={[]} fitView>
        <Background />
      </ReactFlow>
    </main>
  )
}
