import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { PrototypeEntityFlowNode } from './canvasProjection'
import type { PrototypeNodeConfig } from './projectPrototypeData'

export function GenericEntityNode({ data }: NodeProps<PrototypeEntityFlowNode>): React.JSX.Element {
  const { entity, config, workspace, workItem, accent } = data
  const preview = entity.collapsed ? [] : previewEntries(config.kind, config.stage, config.detail)

  return (
    <article
      className="entity-node"
      data-kind={config.kind}
      data-stage={config.stage}
      data-collapsed={entity.collapsed || undefined}
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
        {preview.length > 0 && (
          <div className="entity-node__preview" aria-label={`${config.kind} preview`}>
            {preview.map(({ label, text }, index) => (
              <div key={`${label}-${index}`}>
                <small>{label}</small>
                <span>{text}</span>
              </div>
            ))}
          </div>
        )}
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

type PreviewEntry = { label: string; text: string }

function previewEntries(kind: PrototypeNodeConfig['kind'], stage: string, detail: string): PreviewEntry[] {
  if (kind === 'agent' || kind === 'review' || kind === 'fix') {
    return [
      { label: 'You', text: `Continue the ${stage} work and report concrete results.` },
      { label: kind === 'agent' ? 'Agent' : kind === 'review' ? 'Reviewer' : 'Fix agent', text: detail },
      { label: 'Tool', text: 'Repository context loaded · workspace state synchronized' },
      { label: 'Agent', text: `Working through the ${stage} stage; the conversation remains live.` }
    ]
  }

  if (kind === 'diff') {
    return [
      { label: 'M', text: 'src/renderer/src/App.tsx  +124  −38' },
      { label: 'M', text: 'src/renderer/src/canvasProjection.ts  +86  −17' },
      { label: 'A', text: 'tests/e2e/project-organization.spec.ts  +142' },
      { label: 'Σ', text: detail }
    ]
  }

  if (kind === 'pull-request') {
    return [
      { label: 'Checks', text: 'Typecheck, lint, unit and end-to-end checks passed' },
      { label: 'Review', text: 'Independent review complete · ready for human review' },
      { label: 'Timeline', text: detail }
    ]
  }

  if (kind === 'issue' || kind === 'task') {
    return [
      { label: 'Status', text: stage },
      { label: 'Objective', text: detail },
      { label: 'Context', text: 'Linked resources and implementation activity remain attached' }
    ]
  }

  return [
    { label: 'Status', text: stage },
    { label: 'Activity', text: detail }
  ]
}

function kindMark(kind: PrototypeNodeConfig['kind']): string {
  const marks: Record<PrototypeNodeConfig['kind'], string> = {
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
