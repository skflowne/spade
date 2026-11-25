import { expect, test } from '@playwright/test'
import { parseCanvasCommand } from '../../src/shared/commandValidation'
import { CanvasCommandError, type CanvasCommand } from '../../src/shared/commands'

function rejects(value: unknown, field: string) {
  let thrown: unknown
  try {
    parseCanvasCommand(value)
  } catch (error) {
    thrown = error
  }
  expect(thrown, JSON.stringify(value)).toBeInstanceOf(CanvasCommandError)
  expect((thrown as CanvasCommandError).code).toBe('invalid-command')
  expect((thrown as CanvasCommandError).message).toContain(field)
}

const validCommands: CanvasCommand[] = [
  {
    type: 'spawnChild',
    sourceNodeId: 'n1',
    node: {
      entityType: 'note',
      config: { body: 'x' },
      title: 'T',
      shortDescription: 'D',
      position: { x: -1.5, y: 2 },
      size: { width: 10, height: 20 },
      collapsed: true,
      workspaceId: null,
      resourceRef: { provider: 'paseo', kind: 'agent', id: 'a', revision: 'r' },
      ifResourceAbsent: true
    },
    target: { kind: 'child', parentNodeId: 'n2' },
    origin: 'artifact',
    sourceArtifact: { kind: 'path', value: 'C:\\x.png' }
  },
  { type: 'spawnChild', sourceNodeId: 'n1', node: { entityType: 'note', config: null }, origin: 'spawned' },
  {
    type: 'spawnChild',
    sourceNodeId: 'n1',
    node: { entityType: 'note', config: {} },
    target: { kind: 'tree', nodeId: 'n3' },
    origin: 'delegated'
  },
  { type: 'spawnChild', sourceNodeId: 'n1', node: { entityType: 'n', config: 1 }, target: { kind: 'new-tree' }, origin: 'spawned' },
  { type: 'startTree', node: { entityType: 'agent', config: { provider: 'p' }, workspaceId: 'w', resourceRef: null } },
  { type: 'connectNodes', fromNodeId: 'a', toNodeId: 'b', label: 'uses' },
  { type: 'connectNodes', fromNodeId: 'a', toNodeId: 'b' },
  { type: 'disconnectNodes', edgeId: 'e' },
  { type: 'moveNodes', moves: [{ nodeId: 'a', position: { x: 0, y: 0 } }, { nodeId: 'b', position: { x: 1, y: 1 } }] },
  { type: 'resizeNode', nodeId: 'a', size: { width: 1, height: 1 } },
  { type: 'reparent', nodeId: 'a', newParentId: null },
  { type: 'reparent', nodeId: 'a', newParentId: 'b' },
  { type: 'setNodeWorkspace', nodeId: 'a', workspaceId: null },
  { type: 'setNodeWorkspace', nodeId: 'a', workspaceId: 'w' },
  {
    type: 'updateNode',
    nodeId: 'a',
    patch: { title: 'x', shortDescription: null, config: { body: '' }, cachedPresentation: { summary: 's', revision: 'r' } }
  },
  { type: 'updateNode', nodeId: 'a', patch: { shortDescription: 'd', cachedPresentation: null } },
  { type: 'collapseNode', nodeId: 'a' },
  { type: 'expandNode', nodeId: 'a' },
  { type: 'collapseBranch', nodeId: 'a' },
  { type: 'expandBranch', nodeId: 'a' },
  { type: 'archiveNode', nodeId: 'a' },
  { type: 'archiveBranch', nodeId: 'a' },
  { type: 'restoreNode', nodeId: 'a' },
  { type: 'restoreNode', nodeId: 'a', branch: true },
  { type: 'removeNode', nodeId: 'a' },
  { type: 'removeBranch', nodeId: 'a' },
  { type: 'upsertWorkspace', workspace: { id: 'w', cwd: 'C:\\p', name: 'p', paseoWorkspaceId: 'pw' } },
  { type: 'upsertWorkspace', workspace: { id: 'w', cwd: '/p', name: 'p' } },
  { type: 'setViewport', viewport: { x: 0, y: -10, zoom: 0.25 } }
]

test('accepts every well-formed command unchanged, as a fresh value', () => {
  for (const command of validCommands) {
    const roundTripped = JSON.parse(JSON.stringify(command))
    const parsed = parseCanvasCommand(roundTripped)
    expect(parsed).toEqual(command)
    expect(parsed).not.toBe(roundTripped)
  }
})

test('rejects values that are not command objects', () => {
  rejects(null, 'command')
  rejects('moveNodes', 'command')
  rejects([], 'command')
  rejects({}, 'type')
  rejects({ type: 'deleteEverything' }, 'type')
  rejects({ type: 'toString', nodeId: 'a' }, 'type')
})

test('rejects unknown keys at the top level and inside known shapes', () => {
  rejects({ type: 'collapseNode', nodeId: 'a', force: true }, 'force')
  rejects({ type: 'setViewport', viewport: { x: 0, y: 0, zoom: 1, w: 2 } }, 'viewport.w')
  rejects({ type: 'startTree', node: { entityType: 'note', config: {}, extra: 1 } }, 'node.extra')
})

test('rejects missing or mistyped required fields, naming the field', () => {
  rejects({ type: 'collapseNode' }, 'nodeId')
  rejects({ type: 'collapseNode', nodeId: '' }, 'nodeId')
  rejects({ type: 'collapseNode', nodeId: 7 }, 'nodeId')
  rejects({ type: 'startTree', node: { config: {} } }, 'node.entityType')
  rejects({ type: 'startTree', node: { entityType: 'note' } }, 'node.config')
  rejects({ type: 'startTree' }, 'node')
  rejects({ type: 'startTree', node: { entityType: 'note', config: {}, title: '' } }, 'node.title')
  rejects({ type: 'startTree', node: { entityType: 'note', config: {}, collapsed: 'yes' } }, 'node.collapsed')
  rejects({ type: 'startTree', node: { entityType: 'note', config: {}, resourceRef: { provider: 'p', kind: 'k' } } }, 'node.resourceRef.id')
  rejects({ type: 'spawnChild', sourceNodeId: 'a', node: { entityType: 'n', config: {} } }, 'origin')
  rejects({ type: 'spawnChild', sourceNodeId: 'a', node: { entityType: 'n', config: {} }, origin: 'magic' }, 'origin')
  rejects(
    { type: 'spawnChild', sourceNodeId: 'a', node: { entityType: 'n', config: {} }, origin: 'spawned', target: { kind: 'sideways' } },
    'target.kind'
  )
  rejects(
    { type: 'spawnChild', sourceNodeId: 'a', node: { entityType: 'n', config: {} }, origin: 'spawned', target: { kind: 'child' } },
    'target.parentNodeId'
  )
  rejects({ type: 'reparent', nodeId: 'a' }, 'newParentId')
  rejects({ type: 'setNodeWorkspace', nodeId: 'a' }, 'workspaceId')
  rejects({ type: 'restoreNode', nodeId: 'a', branch: 1 }, 'branch')
  rejects({ type: 'updateNode', nodeId: 'a', patch: { title: 3 } }, 'patch.title')
  rejects({ type: 'updateNode', nodeId: 'a', patch: { cachedPresentation: { summary: 1 } } }, 'patch.cachedPresentation.summary')
  rejects({ type: 'upsertWorkspace', workspace: { id: 'w', name: 'p' } }, 'workspace.cwd')
  rejects({ type: 'connectNodes', fromNodeId: 'a', toNodeId: 'b', label: 5 }, 'label')
})

test('rejects non-finite numbers and non-positive sizes', () => {
  rejects({ type: 'moveNodes', moves: [{ nodeId: 'a', position: { x: Number.NaN, y: 0 } }] }, 'moves[0].position.x')
  rejects({ type: 'moveNodes', moves: [{ nodeId: 'a', position: { x: 0, y: Infinity } }] }, 'moves[0].position.y')
  rejects({ type: 'moveNodes', moves: [{ nodeId: 'a', position: { x: '1', y: 0 } }] }, 'moves[0].position.x')
  rejects({ type: 'moveNodes', moves: [] }, 'moves')
  rejects({ type: 'moveNodes', moves: {} }, 'moves')
  rejects({ type: 'resizeNode', nodeId: 'a', size: { width: 0, height: 10 } }, 'size.width')
  rejects({ type: 'resizeNode', nodeId: 'a', size: { width: 10, height: -1 } }, 'size.height')
  rejects({ type: 'startTree', node: { entityType: 'n', config: {}, size: { width: 1, height: Infinity } } }, 'node.size.height')
  rejects({ type: 'setViewport', viewport: { x: 0, y: 0, zoom: 0 } }, 'viewport.zoom')
})
