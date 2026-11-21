import {
  DOMAIN_RECORD_VERSION,
  createEmptyCanvas,
  type Canvas,
  type CanvasActivity,
  type CanvasEdge,
  type CanvasNode,
  type Project,
  type Workspace
} from '../src/shared/domain'

const createdAt = '2026-01-01T00:00:00.000Z'

const project = {
  version: DOMAIN_RECORD_VERSION,
  id: 'project-opaque-id',
  name: 'Framework',
  rootPath: 'C:\\work\\framework',
  createdAt
} satisfies Project

const workspace = {
  version: DOMAIN_RECORD_VERSION,
  id: 'workspace-opaque-id',
  projectId: project.id,
  cwd: project.rootPath,
  paseoWorkspaceId: 'wks_opaque',
  name: 'framework',
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
  branchCollapsed: false,
  archived: false,
  projectId: project.id,
  groupId: null,
  workspaceId: workspace.id,
  config: {},
  resourceRef: null,
  createdAt,
  updatedAt: createdAt
} satisfies CanvasNode

const childEdge = {
  version: DOMAIN_RECORD_VERSION,
  id: 'edge-opaque-id',
  fromNodeId: canvasNode.id,
  toNodeId: 'node-child-id',
  relation: 'child',
  origin: 'artifact',
  sourceArtifact: { kind: 'path', value: 'C:\\work\\framework\\shot.png' },
  createdAt
} satisfies CanvasEdge

const activity = {
  id: 'activity-opaque-id',
  at: createdAt,
  actor: { kind: 'agent', nodeId: canvasNode.id, agentId: 'agent-opaque-id' },
  command: 'spawnChild',
  summary: 'Spawned Note',
  nodeIds: [canvasNode.id]
} satisfies CanvasActivity

const canvas: Canvas = {
  ...createEmptyCanvas(project.id),
  nodes: [canvasNode],
  edges: [childEdge],
  workspaces: [workspace],
  activity: [activity]
}

void canvas
