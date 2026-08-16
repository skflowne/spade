import type { Node, NodeProps } from '@xyflow/react'
import type { GroupNodeData } from './canvasProjection'

type CanvasGroupFlowNode = Node<GroupNodeData, 'projectGroup' | 'workItemGroup' | 'hull'>

export function CanvasGroupNode({ data }: NodeProps<CanvasGroupFlowNode>): React.JSX.Element {
  return (
    <section
      className={`canvas-group canvas-group--${data.kind}`}
      style={{ '--group-accent': data.accent.color, '--group-tint': data.accent.tint } as React.CSSProperties}
      aria-label={`${data.label} group`}
    >
      <header>
        <strong>{data.label}</strong>
        <span>{data.meta}</span>
      </header>
    </section>
  )
}
