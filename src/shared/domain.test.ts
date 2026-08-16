import { describe, expect, it } from 'vitest'
import {
  CORE_RECORD_VERSIONS,
  type CanvasEdge,
  type CanvasNode,
  type Project,
  type WorkItem,
  type Workspace
} from './domain'

const createdAt = '2026-08-16T00:00:00.000Z'

const project: Project = {
  version: CORE_RECORD_VERSIONS.project,
  id: 'project-1',
  name: 'GADE',
  canvasId: 'canvas-1'
}

const workItem: WorkItem = {
  version: CORE_RECORD_VERSIONS.workItem,
  id: 'work-item-1',
  projectId: project.id,
  title: 'Create the core foundation',
  kind: 'github_issue',
  status: 'active',
  createdAt
}

const workspace: Workspace = {
  version: CORE_RECORD_VERSIONS.workspace,
  id: 'workspace-1',
  projectId: project.id,
  workItemId: workItem.id,
  cwd: '/workspaces/gade',
  name: 'Core foundation',
  createdAt
}

const canvasNode: CanvasNode = {
  version: CORE_RECORD_VERSIONS.canvasNode,
  id: 'node-1',
  entityType: 'foundation',
  entityVersion: 1,
  title: 'GADE foundation',
  position: { x: 0, y: 0 },
  collapsed: false,
  projectId: project.id,
  workItemId: workItem.id,
  workspaceId: workspace.id,
  config: {},
  resourceRef: null,
  createdAt,
  updatedAt: createdAt
}

const canvasEdge: CanvasEdge = {
  version: CORE_RECORD_VERSIONS.canvasEdge,
  id: 'edge-1',
  fromNodeId: canvasNode.id,
  toNodeId: 'node-2',
  relation: 'derived',
  createdAt
}

describe('core domain records', () => {
  it('use the version owned by the shared domain module', () => {
    expect({
      canvasNode: canvasNode.version,
      canvasEdge: canvasEdge.version,
      project: project.version,
      workItem: workItem.version,
      workspace: workspace.version
    }).toEqual(CORE_RECORD_VERSIONS)
  })
})
