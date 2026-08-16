import { Background, ReactFlow, type Edge, type Node } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { DOMAIN_RECORD_VERSION, type CanvasEdge, type CanvasNode } from '@shared/domain'
import './app.css'

const canvasNodes: readonly CanvasNode[] = []
const canvasEdges: readonly CanvasEdge[] = []

const flowNodes: Node[] = canvasNodes.map((node) => ({
  id: node.id,
  position: node.position,
  data: { label: node.title }
}))

const flowEdges: Edge[] = canvasEdges.map((edge) => ({
  id: edge.id,
  source: edge.fromNodeId,
  target: edge.toNodeId,
  label: edge.label
}))

export function App(): React.JSX.Element {
  return (
    <main className="app-shell">
      <header className="app-header">
        <h1>GADE</h1>
        <span>Core canvas · domain v{DOMAIN_RECORD_VERSION}</span>
      </header>
      <section className="canvas" aria-label="GADE canvas">
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodesConnectable={false}
          nodesDraggable={false}
          elementsSelectable={false}
        >
          <Background />
        </ReactFlow>
      </section>
    </main>
  )
}
