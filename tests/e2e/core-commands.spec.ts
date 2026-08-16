import { expect, test } from '@playwright/test'
import {
  connectNodes,
  createNode,
  spawnConnectedNode,
  type CanvasState,
  type NodeCommandEnvironment
} from '../../src/shared/canvasCommands'
import { EntityRegistry, createDeterministicMockAdapter } from '../../src/shared/entities'

const timestamp = '2026-01-01T00:00:00.000Z'

type NoteConfig = { body: string }

function createFixture(): { registry: EntityRegistry; environment: NodeCommandEnvironment } {
  const registry = new EntityRegistry()
  registry.register<NoteConfig>({
    type: 'note',
    version: 1,
    displayName: 'Note',
    adapter: createDeterministicMockAdapter('note')
  })

  let nextNode = 1
  let nextEdge = 1

  return {
    registry,
    environment: {
      registry,
      createNodeId: () => `node-${nextNode++}`,
      createEdgeId: () => `edge-${nextEdge++}`,
      now: () => timestamp
    }
  }
}

const placement = {
  position: { x: 40, y: 60 },
  projectId: 'project-1',
  workItemId: 'work-item-1',
  workspaceId: 'workspace-1'
}

test('registers and resolves entity definitions by type', () => {
  const { registry } = createFixture()

  expect(registry.resolve<NoteConfig>('note').displayName).toBe('Note')
  expect(() => registry.resolve('missing')).toThrow('Unknown entity type: missing')
  expect(() =>
    registry.register({
      type: 'note',
      version: 2,
      displayName: 'Duplicate note',
      adapter: createDeterministicMockAdapter('note')
    })
  ).toThrow('Entity type already registered: note')
})

test('createNode uses its registered definition and deterministic mock adapter', () => {
  const { environment } = createFixture()

  const node = createNode(environment, {
    type: 'note',
    config: { body: 'Deterministic content' },
    placement
  })

  expect(node).toMatchObject({
    id: 'node-1',
    entityType: 'note',
    entityVersion: 1,
    title: 'Note',
    config: { body: 'Deterministic content' },
    resourceRef: { provider: 'mock', kind: 'note', id: 'node-1' },
    createdAt: timestamp,
    updatedAt: timestamp,
    ...placement
  })
  expect(() =>
    createNode(environment, {
      type: 'missing',
      config: {},
      placement
    })
  ).toThrow('Unknown entity type: missing')
})

test('spawnConnectedNode creates a registered node and an edge from its source', () => {
  const { environment } = createFixture()
  const source = createNode(environment, {
    type: 'note',
    config: { body: 'Source' },
    placement
  })
  const state: CanvasState = { nodes: [source], edges: [] }

  const { node, edge } = spawnConnectedNode(environment, state, {
    sourceNodeId: source.id,
    type: 'note',
    config: { body: 'Spawned' },
    relation: 'spawned',
    position: { x: 320, y: 60 }
  })

  expect(node.id).toBe('node-2')
  expect(node.projectId).toBe(source.projectId)
  expect(node.workItemId).toBe(source.workItemId)
  expect(node.workspaceId).toBe(source.workspaceId)
  expect(edge).toMatchObject({
    id: 'edge-1',
    fromNodeId: source.id,
    toNodeId: node.id,
    relation: 'spawned',
    createdAt: timestamp
  })
})

test('connectNodes links existing nodes and rejects a missing endpoint', () => {
  const { environment } = createFixture()
  const first = createNode(environment, {
    type: 'note',
    config: { body: 'First' },
    placement
  })
  const second = createNode(environment, {
    type: 'note',
    config: { body: 'Second' },
    placement: { ...placement, position: { x: 320, y: 60 } }
  })
  const state: CanvasState = { nodes: [first, second], edges: [] }

  expect(
    connectNodes(environment, state, {
      fromNodeId: first.id,
      toNodeId: second.id,
      relation: 'references'
    })
  ).toMatchObject({
    fromNodeId: first.id,
    toNodeId: second.id,
    relation: 'references'
  })
  expect(() =>
    connectNodes(environment, state, {
      fromNodeId: first.id,
      toNodeId: 'missing',
      relation: 'references'
    })
  ).toThrow('Unknown canvas node: missing')
})
