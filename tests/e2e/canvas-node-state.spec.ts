import { expect, test } from '@playwright/test'
import type { NodeChange } from '@xyflow/react'
import { applyCanvasNodePositionChanges } from '../../src/renderer/src/canvasNodeState'
import { DOMAIN_RECORD_VERSION, type CanvasNode } from '../../src/shared/domain'

const node: CanvasNode = {
  version: DOMAIN_RECORD_VERSION,
  id: 'node-1',
  entityType: 'note',
  entityVersion: 1,
  title: 'Note',
  position: { x: 40, y: 60 },
  collapsed: false,
  projectId: 'project-1',
  workItemId: 'work-item-1',
  workspaceId: null,
  config: {},
  resourceRef: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
}

test('applies React Flow position changes to the canonical canvas node', () => {
  const changes: NodeChange[] = [
    {
      id: node.id,
      type: 'position',
      position: { x: 140, y: 120 },
      dragging: false
    }
  ]

  const [updated] = applyCanvasNodePositionChanges([node], changes)

  expect(updated.position).toEqual({ x: 140, y: 120 })
  expect(node.position).toEqual({ x: 40, y: 60 })
})
