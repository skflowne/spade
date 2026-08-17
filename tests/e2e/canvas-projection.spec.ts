import { expect, test } from '@playwright/test'
import { canonicalNodePosition, projectCanvas } from '../../src/renderer/src/canvasProjection'
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

  expect(projectedEntity?.style).toMatchObject({ width: 240, height: 132 })
  expect(workItem).toMatchObject({
    position: { x: 12, y: 536 },
    style: { width: 296, height: 214 }
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
