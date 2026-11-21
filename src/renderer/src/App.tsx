import { Background, ReactFlow } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './app.css'

export function App(): React.JSX.Element {
  return (
    <main className="app-shell">
      <header className="app-header">
        <h1>SPADE</h1>
      </header>
      <section className="canvas" aria-label="SPADE canvas">
        <ReactFlow nodes={[]} edges={[]} nodesConnectable={false}>
          <Background />
        </ReactFlow>
      </section>
    </main>
  )
}
