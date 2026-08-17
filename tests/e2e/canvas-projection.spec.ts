import { expect, test } from '@playwright/test'
import { canonicalNodePosition, entityNodeSize, projectCanvas } from '../../src/renderer/src/canvasProjection'
import type { ProjectPrototypeRecords, PrototypeNodeConfig } from '../../src/renderer/src/projectPrototypeData'
import { DOMAIN_RECORD_VERSION, type CanvasNode } from '../../src/shared/domain'

const entity: CanvasNode = {
  version: DOMAIN_RECORD_VERSION,
  id: 'node-1',
  entityType: 'prototype-record',
  entityVersion: 1,
  title: 'Node',
  position: { x: 40, y: 590 },
  collapsed: false,
  projectId: 'project-1',
  workItemId: 'item-1',
  workspaceId: null,
  config: { kind: 'issue', stage: 'active', detail: 'Detail' } satisfies PrototypeNodeConfig,
  resourceRef: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
}

const records: ProjectPrototypeRecords = {
  projects: [{ version: DOMAIN_RECORD_VERSION, id: 'project-1', name: 'Project', canvasId: 'canvas-1' }],
  workItems: [{
    version: DOMAIN_RECORD_VERSION,
    id: 'item-1',
    projectId: 'project-1',
    title: 'Item',
    kind: 'github_issue',
    sourceIdentifier: '#1',
    sourceUrl: 'https://example.test/issues/1',
    status: 'active',
    rootNodeId: entity.id,
    createdAt: entity.createdAt
  }],
  workspaces: [],
  nodes: [entity],
  edges: [],
  projectAccents: { 'project-1': { color: '#fff', tint: 'transparent' } }
}

test('projects entity dimensions and work-item bounds from one geometry contract', () => {
  const projection = projectCanvas(records, 'dedicated', 'hull', 'project-1')
  const projectedEntity = projection.nodes.find(({ id }) => id === entity.id)
  const workItem = projection.nodes.find(({ id }) => id === 'work-item-item-1')

  expect(projectedEntity?.style).toMatchObject({ width: 460, height: 320 })
  expect(workItem).toMatchObject({
    position: { x: 12, y: 536 },
    style: { width: 516, height: 402 }
  })
})

test('gives realistic entities distinct footprints and keeps collapsed conversations compact', () => {
  const agent = {
    ...entity,
    id: 'agent-1',
    config: { kind: 'agent', stage: 'implementation', detail: 'Conversation' } satisfies PrototypeNodeConfig
  }
  const diff = {
    ...entity,
    id: 'diff-1',
    config: { kind: 'diff', stage: 'changed', detail: 'Changes' } satisfies PrototypeNodeConfig
  }
  const browser = {
    ...entity,
    id: 'browser-1',
    config: { kind: 'browser', stage: 'github', detail: 'Page' } satisfies PrototypeNodeConfig
  }

  expect(entityNodeSize(entity)).toEqual({ width: 460, height: 320 })
  expect(entityNodeSize(agent)).toEqual({ width: 640, height: 500 })
  expect(entityNodeSize(diff)).toEqual({ width: 640, height: 460 })
  expect(entityNodeSize(browser)).toEqual({ width: 820, height: 940 })
  expect(entityNodeSize({ ...agent, size: { width: 680, height: 860 } })).toEqual({ width: 680, height: 860 })
  expect(entityNodeSize({ ...agent, collapsed: true })).toEqual({ width: 400, height: 160 })
})

test('fits global project groups to their current node bounds', () => {
  const projection = projectCanvas(records, 'global', 'hull', 'project-1')
  const project = projection.nodes.find(({ type }) => type === 'projectGroup')

  expect(project).toMatchObject({
    position: { x: 0, y: 0 },
    style: { width: 528, height: 938 }
  })
})

test('derives canonical drag positions from the parent node type, not its identifier', () => {
  const projection = projectCanvas(records, 'dedicated', 'parent', 'project-1')
  const group = projection.nodes.find(({ type }) => type === 'workItemGroup')!
  const projectedEntity = projection.nodes.find(({ id }) => id === entity.id)!
  const renamedGroupId = 'group-with-an-independent-id-format'
  const renamedNodes = projection.nodes.map((node) => {
    if (node.id === group.id) return { ...node, id: renamedGroupId }
    if (node.id === projectedEntity.id) return { ...node, parentId: renamedGroupId }
    return node
  })
  const relativeDragPosition = { x: 50, y: 70 }

  expect(canonicalNodePosition(renamedNodes, entity.id, relativeDragPosition)).toEqual({
    x: relativeDragPosition.x + group.position.x,
    y: relativeDragPosition.y + group.position.y
  })

  const misleadingParentId = 'work-item-not-a-parent-group'
  const misleadingNodes = renamedNodes.map((node) => {
    if (node.id === renamedGroupId && node.type === 'workItemGroup') {
      return { ...node, id: misleadingParentId, type: 'hull' as const }
    }
    if (node.id === projectedEntity.id) return { ...node, parentId: misleadingParentId }
    return node
  })

  expect(canonicalNodePosition(misleadingNodes, entity.id, relativeDragPosition)).toEqual(relativeDragPosition)
})
