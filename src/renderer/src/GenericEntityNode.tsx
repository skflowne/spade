import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { PrototypeEntityFlowNode } from './canvasProjection'
import type { PrototypeNodeConfig } from './projectPrototypeData'

export function GenericEntityNode({ data }: NodeProps<PrototypeEntityFlowNode>): React.JSX.Element {
  const { entity, config, workspace, workItem, accent } = data
  const preview = entity.collapsed || config.kind === 'browser'
    ? []
    : previewEntries(config.kind, config.stage, config.detail)

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
        {config.kind === 'browser' && <BrowserPage variant={config.stage} />}
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

function BrowserPage({ variant }: { variant: string }): React.JSX.Element {
  const dashboard = variant === 'dashboard'

  return (
    <div className="browser-page" aria-label={dashboard ? 'Fake telemetry dashboard' : 'Fake GitHub issue page'}>
      <div className="browser-page__toolbar">
        <span aria-hidden="true">● ● ●</span>
        <code>{dashboard ? 'telemetry.paseo.dev/d/review-queue' : 'github.com/skflowne/spade/issues/12'}</code>
        <span aria-hidden="true">↻</span>
      </div>
      <div className="browser-page__document">
        <aside>
          <strong>{dashboard ? 'PASEO' : 'SPADE'}</strong>
          <span>Overview</span>
          <span>{dashboard ? 'Agent queues' : 'Issues'}</span>
          <span>{dashboard ? 'Review health' : 'Pull requests'}</span>
          <span>{dashboard ? 'Failures' : 'Actions'}</span>
        </aside>
        <section>
          <small>{dashboard ? 'LIVE DASHBOARD · LAST 6 HOURS' : 'OPEN ISSUE · #12'}</small>
          <h3>{dashboard ? 'Review queue telemetry' : 'Browser composition spike'}</h3>
          <p>{dashboard
            ? 'Queue latency is stable while active review volume increases.'
            : 'Compare embedded webview behavior with a selected-node overlay under canvas transforms.'}</p>
          <div className="browser-page__metrics">
            <span><b>{dashboard ? '42s' : '14'}</b>{dashboard ? 'p95 wait' : 'comments'}</span>
            <span><b>{dashboard ? '18' : '3'}</b>{dashboard ? 'active' : 'branches'}</span>
            <span><b>{dashboard ? '99.2%' : '6'}</b>{dashboard ? 'success' : 'checks'}</span>
          </div>
          <div className="browser-page__activity">
            <strong>{dashboard ? 'Recent queue activity' : 'Latest discussion'}</strong>
            <p>{dashboard ? 'Review agent completed correctness pass' : 'Interaction matrix updated with zoom and focus results'}</p>
            <p>{dashboard ? 'Two workspaces waiting for final validation' : 'Prototype branch linked to the issue timeline'}</p>
            <p>{dashboard ? 'No stalled sessions detected' : 'All browser lifecycle checks are passing'}</p>
          </div>
        </section>
      </div>
    </div>
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
    task: 'T',
    browser: '◎'
  }
  return marks[kind] ?? 'N'
}
