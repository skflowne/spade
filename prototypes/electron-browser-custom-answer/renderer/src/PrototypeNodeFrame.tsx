import { Handle, NodeResizer, Position } from '@xyflow/react'
import type { ReactNode } from 'react'

type PrototypeNodeFrameProps = {
  title: string
  kind: string
  children: ReactNode
  resizable?: boolean
}

export function PrototypeNodeFrame({
  title,
  kind,
  children,
  resizable = false
}: PrototypeNodeFrameProps): React.JSX.Element {
  return (
    <article className="prototype-node">
      {resizable && <NodeResizer minWidth={320} minHeight={260} />}
      <Handle type="target" position={Position.Left} />
      <header className="prototype-node__chrome">
        <div>
          <strong>{title}</strong>
          <small>{kind}</small>
        </div>
        <span>drag chrome</span>
      </header>
      <div className="prototype-node__body nodrag nopan nowheel">{children}</div>
      <Handle type="source" position={Position.Right} />
    </article>
  )
}
