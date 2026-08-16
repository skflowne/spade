import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import type { CanvasNode } from '@shared/domain'

export type EntityFlowNode = Node<{ entity: CanvasNode }, 'entity'>

export function GenericEntityNode({ data }: NodeProps<EntityFlowNode>): React.JSX.Element {
  const { entity } = data

  return (
    <article className="entity-node">
      <Handle type="target" position={Position.Left} />
      <header className="entity-node__chrome">
        <div>
          <strong>{entity.title}</strong>
          <small>{entity.entityType}</small>
        </div>
      </header>
      <div className="entity-node__body">
        {entity.shortDescription && <p>{entity.shortDescription}</p>}
        <button type="button" className="nodrag">
          Interactive node content
        </button>
      </div>
      <Handle type="source" position={Position.Right} />
    </article>
  )
}
