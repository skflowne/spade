import { DOMAIN_RECORD_VERSION, type CanvasNode } from '@shared/domain'

const canvasNodes: readonly CanvasNode[] = []

export function App(): React.JSX.Element {
  return (
    <main>
      <h1>GADE</h1>
      <p>
        Domain v{DOMAIN_RECORD_VERSION}: {canvasNodes.length} canvas nodes
      </p>
    </main>
  )
}
