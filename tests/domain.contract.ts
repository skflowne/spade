import {
  DOMAIN_RECORD_VERSION,
  type CanvasEdge,
  type CanvasNode,
  type Project,
  type WorkItem,
  type Workspace
} from '../src/shared/domain'

const createdAt = '2026-01-01T00:00:00.000Z'

const project = {
  version: DOMAIN_RECORD_VERSION,
  id: 'project-opaque-id',
  name: 'SPADE',
  canvasId: 'canvas-opaque-id'
} satisfies Project

const workItem = {
  version: DOMAIN_RECORD_VERSION,
  id: 'work-item-opaque-id',
  projectId: project.id,
  title: 'Create the core foundation',
  kind: 'github_issue',
  status: 'active',
  createdAt
} satisfies WorkItem

const workspace = {
  version: DOMAIN_RECORD_VERSION,
  id: 'workspace-opaque-id',
  projectId: project.id,
  workItemId: workItem.id,
  cwd: '/worktrees/foundation',
  branch: 'issue/1-core-foundation-clean',
  name: 'foundation',
  role: 'integrator',
  createdAt
} satisfies Workspace

const canvasNode = {
  version: DOMAIN_RECORD_VERSION,
  id: 'node-opaque-id',
  entityType: 'note',
  entityVersion: 1,
  title: 'Foundation',
  position: { x: 0, y: 0 },
  collapsed: false,
  projectId: project.id,
  workItemId: workItem.id,
  workspaceId: workspace.id,
  config: {},
  resourceRef: null,
  createdAt,
  updatedAt: createdAt
} satisfies CanvasNode

const canvasEdge = {
  version: DOMAIN_RECORD_VERSION,
  id: 'edge-opaque-id',
  fromNodeId: canvasNode.id,
  toNodeId: 'node-context-id',
  relation: 'references',
  createdAt
} satisfies CanvasEdge

void [project, workItem, workspace, canvasNode, canvasEdge]
