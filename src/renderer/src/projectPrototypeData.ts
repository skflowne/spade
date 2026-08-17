import {
  DOMAIN_RECORD_VERSION,
  type CanvasEdge,
  type CanvasEdgeRelation,
  type CanvasNode,
  type Project,
  type WorkItem,
  type WorkItemStatus,
  type Workspace,
  type WorkspaceRole
} from '@shared/domain'

const createdAt = '2026-08-14T09:00:00.000Z'
const projectContentTop = 80

export type PrototypeNodeConfig = {
  kind: 'issue' | 'agent' | 'workspace' | 'review' | 'fix' | 'diff' | 'pull-request' | 'task'
  stage: string
  detail: string
}

export type ProjectAccent = {
  color: string
  tint: string
}

export type ProjectPrototypeRecords = {
  projects: readonly Project[]
  workItems: readonly WorkItem[]
  workspaces: readonly Workspace[]
  nodes: readonly CanvasNode[]
  edges: readonly CanvasEdge[]
  projectAccents: Readonly<Record<string, ProjectAccent>>
}

const projects = [
  project('spade', 'SPADE', 'spade-canvas'),
  project('paseo', 'Paseo', 'paseo-canvas'),
  project('atlas', 'Atlas', 'atlas-canvas'),
  project('relay', 'Relay', 'relay-canvas')
]

const workItems = [
  workItem('spade-10', 'spade', '[SPADE-10] Project management prototype', 'done', '#10'),
  workItem('spade-12', 'spade', '[SPADE-12] Browser composition spike', 'active', '#12'),
  workItem('spade-8', 'spade', '[SPADE-8] Canvas focus history', 'blocked', '#8'),
  workItem('paseo-41', 'paseo', '[PASEO-41] Durable agent recovery', 'active', '#41'),
  workItem('paseo-38', 'paseo', '[PASEO-38] Workspace cleanup', 'done', '#38'),
  workItem('paseo-44', 'paseo', '[PASEO-44] Review queue telemetry', 'review', '#44'),
  workItem('atlas-7', 'atlas', '[ATLAS-7] Repository map refresh', 'active', '#7'),
  workItem('atlas-9', 'atlas', '[ATLAS-9] Search result ranking', 'review', '#9'),
  workItem('relay-15', 'relay', '[RELAY-15] Notification batching', 'blocked', '#15'),
  workItem('relay-18', 'relay', '[RELAY-18] Delivery audit trail', 'done', '#18')
]

const workspaces = [
  workspace('ws-spade-10-main', 'spade', 'spade-10', 'spade-10-integrator', 'integrator', 'spade-10-project-management-prototype'),
  workspace('ws-spade-10-r1', 'spade', 'spade-10', 'spade-10-review-1', 'review', 'review/spade-10-r1'),
  workspace('ws-spade-10-f1', 'spade', 'spade-10', 'spade-10-fix-1', 'fix', 'fix/spade-10-f1'),
  workspace('ws-spade-10-r2', 'spade', 'spade-10', 'spade-10-review-2', 'review', 'review/spade-10-r2'),
  workspace('ws-spade-10-f2', 'spade', 'spade-10', 'spade-10-fix-2', 'fix', 'fix/spade-10-f2'),
  workspace('ws-spade-12', 'spade', 'spade-12', 'spade-12-browser', 'exploration', 'spike/browser-composition'),
  workspace('ws-paseo-41-main', 'paseo', 'paseo-41', 'paseo-41-author', 'integrator', 'issue/41-recovery'),
  workspace('ws-paseo-41-test', 'paseo', 'paseo-41', 'paseo-41-test', 'review', 'review/41-recovery'),
  workspace('ws-paseo-38', 'paseo', 'paseo-38', 'paseo-38-cleanup', 'integrator', 'issue/38-cleanup'),
  workspace('ws-paseo-44', 'paseo', 'paseo-44', 'paseo-44-telemetry', 'integrator', 'issue/44-telemetry'),
  workspace('ws-atlas-7', 'atlas', 'atlas-7', 'atlas-7-map', 'integrator', 'issue/7-map-refresh'),
  workspace('ws-atlas-9-main', 'atlas', 'atlas-9', 'atlas-9-ranking', 'integrator', 'issue/9-ranking'),
  workspace('ws-atlas-9-review', 'atlas', 'atlas-9', 'atlas-9-review', 'review', 'review/9-ranking'),
  workspace('ws-relay-15', 'relay', 'relay-15', 'relay-15-batching', 'integrator', 'issue/15-batching'),
  workspace('ws-relay-18', 'relay', 'relay-18', 'relay-18-audit', 'integrator', 'issue/18-audit')
]

const nodes = [
  node('spade-10-issue', 'spade', 'spade-10', null, 'GitHub issue #10', 40, 70, 'issue', 'intake', 'Implement selected from a mocked issue browser'),
  node('spade-10-agent', 'spade', 'spade-10', 'ws-spade-10-main', 'Integrator agent', 320, 70, 'agent', 'implementation', 'Owns the complete prototype change'),
  node('spade-10-review-1', 'spade', 'spade-10', 'ws-spade-10-r1', 'Review round 1', 600, 30, 'review', 'review', 'Independent correctness pass'),
  node('spade-10-fix-1', 'spade', 'spade-10', 'ws-spade-10-f1', 'Fix workspace 1', 880, 30, 'fix', 'fix', 'Resolves navigation findings'),
  node('spade-10-review-2', 'spade', 'spade-10', 'ws-spade-10-r2', 'Review round 2', 600, 178, 'review', 'review', 'Follow-up verification'),
  node('spade-10-fix-2', 'spade', 'spade-10', 'ws-spade-10-f2', 'Fix workspace 2', 880, 178, 'fix', 'fix', 'Resolves grouping findings'),
  node('spade-10-subagents', 'spade', 'spade-10', 'ws-spade-10-main', 'Delegated scouts · 3', 320, 218, 'agent', 'collapsed', 'Retired delegated stages remain discoverable'),
  node('spade-10-diff', 'spade', 'spade-10', 'ws-spade-10-main', 'Working diff', 600, 326, 'diff', 'changed', 'src/ +842 −64 · docs/ +22 −4'),
  node('spade-10-pr', 'spade', 'spade-10', 'ws-spade-10-main', 'Pull request #14', 880, 326, 'pull-request', 'done', 'active → review → done · open for human review'),

  node('spade-12-issue', 'spade', 'spade-12', null, 'Browser composition', 40, 560, 'issue', 'active', 'Compare webview and native overlay'),
  node('spade-12-agent', 'spade', 'spade-12', 'ws-spade-12', 'Exploration agent', 320, 560, 'agent', 'exploration', 'Running interaction checks'),
  node('spade-8-issue', 'spade', 'spade-8', null, 'Focus history', 640, 560, 'task', 'blocked', 'Waiting for navigation direction'),

  node('paseo-41-issue', 'paseo', 'paseo-41', null, 'Durable recovery', 40, 70, 'issue', 'active', 'Restore interrupted sessions'),
  node('paseo-41-agent', 'paseo', 'paseo-41', 'ws-paseo-41-main', 'Recovery author', 320, 70, 'agent', 'implementation', 'Checkpoint protocol in progress'),
  node('paseo-41-review', 'paseo', 'paseo-41', 'ws-paseo-41-test', 'Recovery review', 600, 70, 'review', 'queued', 'Failure scenarios queued'),
  node('paseo-38-issue', 'paseo', 'paseo-38', null, 'Workspace cleanup', 40, 310, 'issue', 'done', 'Archive lifecycle shipped'),
  node('paseo-38-pr', 'paseo', 'paseo-38', 'ws-paseo-38', 'Merged pull request', 320, 310, 'pull-request', 'done', 'Cleanup verified'),
  node('paseo-44-issue', 'paseo', 'paseo-44', null, 'Review telemetry', 640, 310, 'issue', 'review', 'Expose queue latency'),
  node('paseo-44-diff', 'paseo', 'paseo-44', 'ws-paseo-44', 'Telemetry diff', 900, 310, 'diff', 'review', 'events/ +184 −21'),

  node('atlas-7-issue', 'atlas', 'atlas-7', null, 'Repository map refresh', 40, 70, 'issue', 'active', 'Incremental graph indexing'),
  node('atlas-7-agent', 'atlas', 'atlas-7', 'ws-atlas-7', 'Map refresh agent', 320, 70, 'agent', 'implementation', 'Scanning changed packages'),
  node('atlas-9-issue', 'atlas', 'atlas-9', null, 'Search result ranking', 40, 350, 'issue', 'review', 'Tune symbol relevance'),
  node('atlas-9-agent', 'atlas', 'atlas-9', 'ws-atlas-9-main', 'Ranking author', 320, 350, 'agent', 'implementation', 'Evaluation set complete'),
  node('atlas-9-review', 'atlas', 'atlas-9', 'ws-atlas-9-review', 'Ranking review', 600, 350, 'review', 'review', 'Precision checks running'),

  node('relay-15-issue', 'relay', 'relay-15', null, 'Notification batching', 40, 70, 'issue', 'blocked', 'Awaiting delivery limits'),
  node('relay-15-agent', 'relay', 'relay-15', 'ws-relay-15', 'Batching author', 320, 70, 'agent', 'paused', 'Implementation paused safely'),
  node('relay-18-issue', 'relay', 'relay-18', null, 'Delivery audit trail', 40, 350, 'issue', 'done', 'Immutable delivery history'),
  node('relay-18-pr', 'relay', 'relay-18', 'ws-relay-18', 'Merged audit PR', 320, 350, 'pull-request', 'done', 'Released to production')
]

const edges = [
  edge('spade-10-issue', 'spade-10-agent', 'spawned'),
  edge('spade-10-agent', 'spade-10-review-1', 'delegated'),
  edge('spade-10-review-1', 'spade-10-fix-1', 'derived'),
  edge('spade-10-fix-1', 'spade-10-review-2', 'derived'),
  edge('spade-10-review-2', 'spade-10-fix-2', 'derived'),
  edge('spade-10-agent', 'spade-10-subagents', 'delegated'),
  edge('spade-10-fix-2', 'spade-10-diff', 'derived'),
  edge('spade-10-diff', 'spade-10-pr', 'derived'),
  edge('spade-12-issue', 'spade-12-agent', 'spawned'),
  edge('paseo-41-issue', 'paseo-41-agent', 'spawned'),
  edge('paseo-41-agent', 'paseo-41-review', 'delegated'),
  edge('paseo-38-issue', 'paseo-38-pr', 'derived'),
  edge('paseo-44-issue', 'paseo-44-diff', 'derived'),
  edge('atlas-7-issue', 'atlas-7-agent', 'spawned'),
  edge('atlas-9-issue', 'atlas-9-agent', 'spawned'),
  edge('atlas-9-agent', 'atlas-9-review', 'delegated'),
  edge('relay-15-issue', 'relay-15-agent', 'spawned'),
  edge('relay-18-issue', 'relay-18-pr', 'derived')
]

export const projectPrototypeRecords: ProjectPrototypeRecords = {
  projects,
  workItems,
  workspaces,
  nodes,
  edges,
  projectAccents: {
    spade: { color: 'var(--cr-project-1-color)', tint: 'var(--cr-project-1-tint)' },
    paseo: { color: 'var(--cr-project-2-color)', tint: 'var(--cr-project-2-tint)' },
    atlas: { color: 'var(--cr-project-3-color)', tint: 'var(--cr-project-3-tint)' },
    relay: { color: 'var(--cr-project-4-color)', tint: 'var(--cr-project-4-tint)' }
  }
}

function project(id: string, name: string, canvasId: string): Project {
  return { version: DOMAIN_RECORD_VERSION, id, name, canvasId }
}

function workItem(
  id: string,
  projectId: string,
  title: string,
  status: WorkItemStatus,
  sourceIdentifier: string
): WorkItem {
  return {
    version: DOMAIN_RECORD_VERSION,
    id,
    projectId,
    title,
    kind: 'github_issue',
    sourceIdentifier,
    sourceUrl: `https://github.com/mock/${projectId}/issues/${sourceIdentifier.slice(1)}`,
    status,
    rootNodeId: `${id}-issue`,
    createdAt
  }
}

function workspace(
  id: string,
  projectId: string,
  workItemId: string,
  name: string,
  role: WorkspaceRole,
  branch: string
): Workspace {
  return {
    version: DOMAIN_RECORD_VERSION,
    id,
    projectId,
    workItemId,
    cwd: `/worktrees/${name}`,
    worktreeRoot: `/worktrees/${name}`,
    mainRepoRoot: `/projects/${projectId}`,
    baseRef: 'origin/main',
    baseRevision: '228c34f',
    branch,
    name,
    role,
    createdAt
  }
}

function node(
  id: string,
  projectId: string,
  workItemId: string,
  workspaceId: string | null,
  title: string,
  x: number,
  y: number,
  kind: PrototypeNodeConfig['kind'],
  stage: string,
  detail: string
): CanvasNode {
  return {
    version: DOMAIN_RECORD_VERSION,
    id,
    entityType: 'prototype-record',
    entityVersion: 1,
    title,
    shortDescription: detail,
    position: { x, y: y + projectContentTop },
    collapsed: stage === 'collapsed',
    projectId,
    workItemId,
    workspaceId,
    config: { kind, stage, detail } satisfies PrototypeNodeConfig,
    resourceRef: kind === 'issue' || kind === 'pull-request'
      ? { provider: 'mock-github', kind, id }
      : { provider: 'mock-paseo', kind, id },
    createdAt,
    updatedAt: createdAt
  }
}

function edge(fromNodeId: string, toNodeId: string, relation: CanvasEdgeRelation): CanvasEdge {
  return {
    version: DOMAIN_RECORD_VERSION,
    id: `edge-${fromNodeId}-${toNodeId}`,
    fromNodeId,
    toNodeId,
    relation,
    createdAt
  }
}
