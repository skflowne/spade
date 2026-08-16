import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { PrototypeEntityFlowNode } from './canvasProjection'

export function GenericEntityNode({ data }: NodeProps<PrototypeEntityFlowNode>): React.JSX.Element {
  const { entity, config, workspace, workItem, accent } = data

  return (
    <article
      className="entity-node"
      data-stage={config.stage}
      style={{ '--group-accent': accent.color } as React.CSSProperties}
    >
      <Handle type="target" position={Position.Left} />
      <header className="entity-node__chrome">
        <span className="entity-node__kind" aria-hidden="true">{kindMark(config.kind)}</span>
        <div>
          <strong>{entity.title}</strong>
          <small>{config.kind} · {config.stage}</small>
        </div>
      </header>
      <div className="entity-node__body">
        <p>{config.detail}</p>
        <div className="entity-node__badges">
          <span>{workItem.sourceIdentifier ?? workItem.kind}</span>
          {workspace && <span>{workspace.role ?? 'workspace'}</span>}
          {workspace?.branch && <code>{workspace.branch}</code>}
        </div>
      </div>
      <Handle type="source" position={Position.Right} />
    </article>
  )
}

function kindMark(kind: string): string {
  const marks: Record<string, string> = {
    issue: '#',
    agent: 'A',
    workspace: 'W',
    review: 'R',
    fix: 'F',
    diff: '±',
    'pull-request': 'PR',
    task: 'T'
  }
  return marks[kind] ?? 'N'
}
