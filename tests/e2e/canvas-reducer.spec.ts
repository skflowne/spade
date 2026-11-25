import { expect, test } from '@playwright/test'
import { createBuiltinEntityRegistry } from '../../src/shared/builtinEntities'
import { applyCanvasCommand, type CanvasCommandContext } from '../../src/shared/canvasReducer'
import { CanvasCommandError, type CanvasCommand, type CanvasCommandErrorCode, type NodeSeed } from '../../src/shared/commands'
import {
  CANVAS_ACTIVITY_LIMIT,
  DOMAIN_RECORD_VERSION,
  createEmptyCanvas,
  type Actor,
  type Canvas,
  type CanvasNode,
  type Rect
} from '../../src/shared/domain'

const entities = createBuiltinEntityRegistry()
const user: Actor = { kind: 'user' }
const agent: Actor = { kind: 'agent', nodeId: 'agent-node', agentId: 'agent-1' }
const system: Actor = { kind: 'system' }
const T0 = '2026-01-01T00:00:00.000Z'
const T1 = '2026-01-01T00:05:00.000Z'

// Built-in sizes restated so expectations do not read them from the code under test.
const SIZES: Record<string, { width: number; height: number }> = {
  note: { width: 320, height: 200 },
  agent: { width: 640, height: 720 },
  image: { width: 560, height: 420 },
  webpage: { width: 960, height: 640 }
}

const note = (body = 'text', extra: Partial<NodeSeed> = {}): NodeSeed => ({ entityType: 'note', config: { body }, ...extra })
const agentSeed = (extra: Partial<NodeSeed> = {}): NodeSeed => ({
  entityType: 'agent',
  config: { provider: 'claude', model: 'opus', mode: null, prompt: 'Fix the bug' },
  ...extra
})
const imageSeed: NodeSeed = { entityType: 'image', config: { source: { kind: 'path', path: 'C:\\p\\shot.png' } } }
const pageSeed: NodeSeed = { entityType: 'webpage', config: { url: 'https://example.com' } }

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value)) deepFreeze(nested)
  }
  return value
}

// Applies commands against frozen canvases, so any mutation of an input throws.
class Session {
  canvas: Canvas
  private next = 0

  constructor(canvas: Canvas = createEmptyCanvas('project')) {
    this.canvas = deepFreeze(canvas)
  }

  context(overrides: Partial<CanvasCommandContext> = {}): CanvasCommandContext {
    return { actor: user, now: T0, entities, createId: () => `id-${++this.next}`, ...overrides }
  }

  run(command: CanvasCommand, overrides: Partial<CanvasCommandContext> = {}) {
    const result = applyCanvasCommand(this.canvas, command, this.context(overrides))
    this.canvas = deepFreeze(result.canvas)
    return result.outcome
  }

  node(id: string): CanvasNode {
    const found = this.canvas.nodes.find((candidate) => candidate.id === id)
    if (!found) throw new Error(`no node ${id}`)
    return found
  }

  root(seed: NodeSeed = note(), overrides: Partial<CanvasCommandContext> = {}): string {
    return this.run({ type: 'startTree', node: seed }, overrides).nodeId!
  }

  child(sourceNodeId: string, seed: NodeSeed = note(), extra: Partial<Extract<CanvasCommand, { type: 'spawnChild' }>> = {}) {
    return this.run({ type: 'spawnChild', sourceNodeId, node: seed, origin: 'spawned', ...extra }).nodeId!
  }

  childEdges() {
    return this.canvas.edges
      .filter((edge) => edge.relation === 'child')
      .map((edge) => `${edge.fromNodeId}>${edge.toNodeId}`)
  }
}

function expectError(action: () => unknown, code: CanvasCommandErrorCode) {
  let thrown: unknown
  try {
    action()
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(CanvasCommandError)
  expect((thrown as CanvasCommandError).code).toBe(code)
}

test.describe('creation', () => {
  test('startTree creates a validated root node with entity defaults and records the activity', () => {
    const session = new Session()
    const outcome = session.run({ type: 'startTree', node: note('hello') }, { nodeId: 'chosen-id' })

    expect(outcome).toEqual({ nodeId: 'chosen-id', created: true })
    expect(session.canvas.nodes).toEqual([
      {
        version: DOMAIN_RECORD_VERSION,
        id: 'chosen-id',
        entityType: 'note',
        entityVersion: 1,
        title: 'Note',
        position: { x: 0, y: 0 },
        collapsed: false,
        branchCollapsed: false,
        archived: false,
        projectId: 'project',
        groupId: null,
        workspaceId: null,
        config: { body: 'hello' },
        resourceRef: null,
        createdAt: T0,
        updatedAt: T0
      }
    ])
    expect(session.canvas.edges).toEqual([])
    expect(session.canvas.activity).toHaveLength(1)
    expect(session.canvas.activity[0]).toMatchObject({ at: T0, actor: user, command: 'startTree', nodeIds: ['chosen-id'] })
    expect(session.canvas.activity[0].summary).toContain('Note')
  })

  test('a creation command keeps the seed title, description, size, collapsed state, position, and resource', () => {
    const session = new Session()
    const id = session.root(
      agentSeed({
        title: 'Planner',
        shortDescription: 'plans',
        size: { width: 700, height: 500 },
        collapsed: true,
        position: { x: -40, y: 75 },
        resourceRef: { provider: 'paseo', kind: 'agent', id: 'p-1' }
      })
    )

    expect(session.node(id)).toMatchObject({
      title: 'Planner',
      shortDescription: 'plans',
      size: { width: 700, height: 500 },
      collapsed: true,
      position: { x: -40, y: 75 },
      resourceRef: { provider: 'paseo', kind: 'agent', id: 'p-1' },
      config: { provider: 'claude', model: 'opus', mode: null, prompt: 'Fix the bug' }
    })
    expect(session.canvas.activity[0].summary).toContain('Planner')
  })

  test('rejects unknown entity types, invalid configs, and unknown workspaces', () => {
    const session = new Session()
    expectError(() => session.root({ entityType: 'spreadsheet', config: {} }), 'unknown-entity-type')
    expectError(() => session.root({ entityType: 'webpage', config: { url: 'ftp://x' } }), 'invalid-config')
    expectError(() => session.root(note('x', { workspaceId: 'nope' })), 'unknown-workspace')
    expect(session.canvas.nodes).toEqual([])
  })

  test('rejects a node id that is already taken', () => {
    const session = new Session()
    session.root(note(), { nodeId: 'same' })
    expectError(() => session.root(note(), { nodeId: 'same' }), 'invalid-command')
  })

  test('spawnChild defaults to a child of the source, placed to its right, inheriting its workspace', () => {
    const session = new Session()
    session.run({ type: 'upsertWorkspace', workspace: { id: 'ws', cwd: 'C:\\p', name: 'p' } })
    const root = session.root(agentSeed({ workspaceId: 'ws' }))
    const outcome = session.run({
      type: 'spawnChild',
      sourceNodeId: root,
      node: imageSeed,
      origin: 'artifact',
      sourceArtifact: { kind: 'path', value: 'C:\\p\\shot.png' }
    })

    const child = session.node(outcome.nodeId!)
    expect(child.position).toEqual({ x: 640 + 160, y: 0 })
    expect(child.workspaceId).toBe('ws')
    expect(child.title).toBe('Image')
    const edge = session.canvas.edges.find((candidate) => candidate.id === outcome.edgeId)
    expect(edge).toMatchObject({
      fromNodeId: root,
      toNodeId: child.id,
      relation: 'child',
      origin: 'artifact',
      sourceArtifact: { kind: 'path', value: 'C:\\p\\shot.png' },
      createdAt: T0
    })
  })

  test('a seed workspace overrides inheritance, including an explicit null', () => {
    const session = new Session()
    session.run({ type: 'upsertWorkspace', workspace: { id: 'ws', cwd: 'C:\\p', name: 'p' } })
    session.run({ type: 'upsertWorkspace', workspace: { id: 'ws2', cwd: 'C:\\q', name: 'q' } })
    const root = session.root(note('r', { workspaceId: 'ws' }))

    expect(session.node(session.child(root, note('a', { workspaceId: null }))).workspaceId).toBeNull()
    expect(session.node(session.child(root, note('b', { workspaceId: 'ws2' }))).workspaceId).toBe('ws2')
    expectError(() => session.child(root, note('c', { workspaceId: 'missing' })), 'unknown-workspace')
  })

  test('spawn targets attach to a named node, to the root of a tree, or to no parent', () => {
    const session = new Session()
    const root = session.root()
    const mid = session.child(root)
    const leaf = session.child(mid)

    const toNode = session.child(leaf, note(), { target: { kind: 'child', parentNodeId: mid } })
    const toTree = session.child(leaf, note(), { target: { kind: 'tree', nodeId: leaf } })
    const edgesBefore = session.canvas.edges.length
    const newTree = session.child(leaf, note(), { target: { kind: 'new-tree' } })

    expect(session.childEdges()).toContain(`${mid}>${toNode}`)
    expect(session.childEdges()).toContain(`${root}>${toTree}`)
    expect(session.canvas.edges).toHaveLength(edgesBefore)
    expect(session.canvas.edges.some((edge) => edge.toNodeId === newTree)).toBe(false)
  })

  test('spawnChild rejects unknown source and target nodes', () => {
    const session = new Session()
    const root = session.root()
    expectError(() => session.child('ghost'), 'unknown-node')
    expectError(() => session.child(root, note(), { target: { kind: 'child', parentNodeId: 'ghost' } }), 'unknown-node')
    expectError(() => session.child(root, note(), { target: { kind: 'tree', nodeId: 'ghost' } }), 'unknown-node')
  })

  test('ifResourceAbsent returns the existing node, even archived, without changing the canvas', () => {
    const session = new Session()
    const resourceRef = { provider: 'paseo', kind: 'agent', id: 'p-1' }
    const root = session.root()
    const existing = session.child(root, agentSeed({ resourceRef: { ...resourceRef, revision: 'r1' } }))
    session.run({ type: 'archiveNode', nodeId: existing })
    const before = session.canvas

    const outcome = session.run({
      type: 'spawnChild',
      sourceNodeId: root,
      node: agentSeed({ resourceRef: { ...resourceRef, revision: 'r2' }, ifResourceAbsent: true }),
      origin: 'delegated'
    })

    expect(outcome).toEqual({ nodeId: existing, created: false })
    expect(session.canvas).toBe(before)

    const different = session.run({
      type: 'startTree',
      node: agentSeed({ resourceRef: { ...resourceRef, kind: 'provider-subagent' }, ifResourceAbsent: true })
    })
    expect(different.created).toBe(true)
  })
})

test.describe('dismissed resources', () => {
  const ref = (id: string) => ({ provider: 'paseo', kind: 'agent', id })
  const delegated = (sourceNodeId: string, id: string): CanvasCommand => ({
    type: 'spawnChild',
    sourceNodeId,
    node: agentSeed({ resourceRef: ref(id), ifResourceAbsent: true }),
    origin: 'delegated'
  })

  test('a new canvas has no dismissed resources', () => {
    expect(createEmptyCanvas('project').dismissedResources).toEqual([])
  })

  test('removing nodes records the resource of every removed node that has one, without its revision', () => {
    const session = new Session()
    const root = session.root()
    const lone = session.child(root, agentSeed({ resourceRef: { ...ref('p-lone'), revision: 'r7' } }))
    const branch = session.child(root, agentSeed({ resourceRef: ref('p-branch') }))
    session.child(branch, note())
    session.child(branch, agentSeed({ resourceRef: ref('p-leaf') }))

    session.run({ type: 'removeNode', nodeId: lone })
    expect(session.canvas.dismissedResources).toEqual([ref('p-lone')])

    session.run({ type: 'removeBranch', nodeId: branch })
    expect(session.canvas.dismissedResources).toEqual([ref('p-lone'), ref('p-branch'), ref('p-leaf')])

    // A node without a resource leaves the list alone.
    session.run({ type: 'removeNode', nodeId: root })
    expect(session.canvas.dismissedResources).toEqual([ref('p-lone'), ref('p-branch'), ref('p-leaf')])
  })

  test('a resource dismissed again moves to the newest end instead of repeating', () => {
    const session = new Session()
    const root = session.root()
    const first = session.child(root, agentSeed({ resourceRef: ref('p-1') }))
    const second = session.child(root, agentSeed({ resourceRef: ref('p-2') }))
    session.run({ type: 'removeNode', nodeId: first })
    session.run({ type: 'removeNode', nodeId: second })
    const again = session.child(root, agentSeed({ resourceRef: ref('p-1') }))
    session.run({ type: 'removeNode', nodeId: again })
    expect(session.canvas.dismissedResources).toEqual([ref('p-2'), ref('p-1')])
  })

  test('the dismissed list keeps only the newest 500 resources', () => {
    const older = Array.from({ length: 500 }, (_, index) => ref(`old-${index}`))
    const session = new Session({ ...createEmptyCanvas('project'), dismissedResources: older })
    const root = session.root()
    const node = session.child(root, agentSeed({ resourceRef: ref('newest') }))
    session.run({ type: 'removeNode', nodeId: node })
    expect(session.canvas.dismissedResources).toHaveLength(500)
    expect(session.canvas.dismissedResources[0]).toEqual(ref('old-1'))
    expect(session.canvas.dismissedResources.at(-1)).toEqual(ref('newest'))
  })

  test('SPADE does not add back a node for a dismissed resource, and reports that nothing was created', () => {
    const session = new Session()
    const root = session.root()
    const child = session.run(delegated(root, 'p-1'), { actor: system }).nodeId!
    session.run({ type: 'removeNode', nodeId: child })
    const before = session.canvas

    const outcome = session.run(delegated(root, 'p-1'), { actor: system })

    expect(outcome).toEqual({ created: false })
    expect(session.canvas).toBe(before)
  })

  test('a user or an agent creating a node for a dismissed resource brings it back and clears the dismissal', () => {
    for (const actor of [user, agent]) {
      const session = new Session()
      const root = session.root()
      const child = session.run(delegated(root, 'p-1'), { actor: system }).nodeId!
      session.run({ type: 'removeNode', nodeId: child })

      const outcome = session.run(delegated(root, 'p-1'), { actor })

      expect(outcome.created, actor.kind).toBe(true)
      expect(session.node(outcome.nodeId!).resourceRef).toEqual(ref('p-1'))
      expect(session.canvas.dismissedResources, actor.kind).toEqual([])
      // Once back, SPADE's own matching finds the node again.
      expect(session.run(delegated(root, 'p-1'), { actor: system })).toEqual({ nodeId: outcome.nodeId, created: false })
    }
  })

  test('a node that still shows the resource wins over a dismissal', () => {
    const session = new Session()
    const root = session.root()
    const first = session.child(root, agentSeed({ resourceRef: ref('p-1') }))
    const second = session.child(root, agentSeed({ resourceRef: ref('p-1') }))
    session.run({ type: 'removeNode', nodeId: first })
    expect(session.run(delegated(root, 'p-1'), { actor: system })).toEqual({ nodeId: second, created: false })
  })
})

test.describe('structure', () => {
  test('connectNodes adds a references edge and rejects self-references and duplicates', () => {
    const session = new Session()
    const a = session.root(note('a', { title: 'Alpha' }))
    const b = session.root(note('b', { title: 'Beta' }))
    const outcome = session.run({ type: 'connectNodes', fromNodeId: a, toNodeId: b, label: 'uses' })

    expect(session.canvas.edges).toEqual([
      {
        version: DOMAIN_RECORD_VERSION,
        id: outcome.edgeId,
        fromNodeId: a,
        toNodeId: b,
        relation: 'references',
        label: 'uses',
        createdAt: T0
      }
    ])
    expect(session.canvas.activity.at(-1)?.summary).toMatch(/Alpha.*Beta/)
    expectError(() => session.run({ type: 'connectNodes', fromNodeId: a, toNodeId: a }), 'invalid-command')
    expectError(() => session.run({ type: 'connectNodes', fromNodeId: a, toNodeId: b, label: 'uses' }), 'invalid-command')
    expectError(() => session.run({ type: 'connectNodes', fromNodeId: a, toNodeId: 'ghost' }), 'unknown-node')
  })

  test('disconnectNodes removes only references edges', () => {
    const session = new Session()
    const a = session.root()
    const b = session.child(a)
    const { edgeId } = session.run({ type: 'connectNodes', fromNodeId: b, toNodeId: a })
    const childEdge = session.canvas.edges.find((edge) => edge.relation === 'child')!

    expectError(() => session.run({ type: 'disconnectNodes', edgeId: childEdge.id }), 'invalid-command')
    expectError(() => session.run({ type: 'disconnectNodes', edgeId: 'ghost' }), 'unknown-edge')
    session.run({ type: 'disconnectNodes', edgeId: edgeId! })
    expect(session.canvas.edges).toEqual([childEdge])
  })

  test('reparent moves a branch structurally, keeping positions and the edge provenance', () => {
    const session = new Session()
    const a = session.root()
    const b = session.root()
    const moved = session.child(a, note(), { origin: 'artifact', sourceArtifact: { kind: 'url', value: 'https://x' } })
    const below = session.child(moved)
    const positions = session.canvas.nodes.map((node) => node.position)

    const outcome = session.run({ type: 'reparent', nodeId: moved, newParentId: b })

    expect(session.childEdges()).toEqual([`${moved}>${below}`, `${b}>${moved}`])
    expect(session.canvas.edges.find((edge) => edge.id === outcome.edgeId)).toMatchObject({
      fromNodeId: b,
      toNodeId: moved,
      origin: 'artifact',
      sourceArtifact: { kind: 'url', value: 'https://x' }
    })
    expect(session.canvas.nodes.map((node) => node.position)).toEqual(positions)
  })

  test('reparent to null makes a root, and a former root gets a spawned edge', () => {
    const session = new Session()
    const a = session.root()
    const b = session.child(a)
    session.run({ type: 'reparent', nodeId: b, newParentId: null })
    expect(session.childEdges()).toEqual([])

    session.run({ type: 'reparent', nodeId: a, newParentId: b })
    expect(session.canvas.edges).toMatchObject([{ fromNodeId: b, toNodeId: a, relation: 'child', origin: 'spawned' }])
  })

  test('reparent rejects cycles and unknown nodes', () => {
    const session = new Session()
    const a = session.root()
    const b = session.child(a)
    const c = session.child(b)
    expectError(() => session.run({ type: 'reparent', nodeId: a, newParentId: a }), 'cycle')
    expectError(() => session.run({ type: 'reparent', nodeId: a, newParentId: c }), 'cycle')
    expectError(() => session.run({ type: 'reparent', nodeId: 'ghost', newParentId: a }), 'unknown-node')
    expectError(() => session.run({ type: 'reparent', nodeId: b, newParentId: 'ghost' }), 'unknown-node')
  })

  test('removeNode promotes children to its parent, keeping their provenance, and drops its references', () => {
    const session = new Session()
    const a = session.root()
    const b = session.child(a)
    const c = session.child(b, note(), { origin: 'delegated' })
    const d = session.child(b)
    session.run({ type: 'connectNodes', fromNodeId: a, toNodeId: b })
    session.run({ type: 'connectNodes', fromNodeId: a, toNodeId: c })

    const outcome = session.run({ type: 'removeNode', nodeId: b })

    expect(outcome.removedNodeIds).toEqual([b])
    expect(session.canvas.nodes.map((node) => node.id)).toEqual([a, c, d])
    expect(session.childEdges()).toEqual([`${a}>${c}`, `${a}>${d}`])
    expect(session.canvas.edges.find((edge) => edge.toNodeId === c && edge.relation === 'child')?.origin).toBe('delegated')
    expect(session.canvas.edges.filter((edge) => edge.relation === 'references')).toMatchObject([
      { fromNodeId: a, toNodeId: c }
    ])
  })

  test('removing a root makes its children roots', () => {
    const session = new Session()
    const a = session.root()
    session.child(a)
    session.child(a)
    session.run({ type: 'removeNode', nodeId: a })
    expect(session.childEdges()).toEqual([])
    expect(session.canvas.nodes).toHaveLength(2)
  })

  test('removeBranch removes the node, every descendant, and every edge touching them', () => {
    const session = new Session()
    const a = session.root()
    const b = session.child(a)
    const c = session.child(b)
    const other = session.root()
    session.run({ type: 'connectNodes', fromNodeId: other, toNodeId: c })

    const outcome = session.run({ type: 'removeBranch', nodeId: b })

    expect(outcome.removedNodeIds).toEqual([b, c])
    expect(session.canvas.nodes.map((node) => node.id)).toEqual([a, other])
    expect(session.canvas.edges).toEqual([])
  })
})

test.describe('node state', () => {
  test('collapse, branch collapse, archive, and restore set their flags and updatedAt', () => {
    const session = new Session()
    const a = session.root()
    const b = session.child(a)
    const c = session.child(b)
    const flags = () =>
      session.canvas.nodes.map(({ collapsed, branchCollapsed, archived }) => ({ collapsed, branchCollapsed, archived }))
    const off = { collapsed: false, branchCollapsed: false, archived: false }

    session.run({ type: 'collapseNode', nodeId: a }, { now: T1 })
    session.run({ type: 'collapseBranch', nodeId: b }, { now: T1 })
    expect(flags()).toEqual([{ ...off, collapsed: true }, { ...off, branchCollapsed: true }, off])
    expect(session.node(a).updatedAt).toBe(T1)
    expect(session.node(c).updatedAt).toBe(T0)

    session.run({ type: 'expandNode', nodeId: a })
    session.run({ type: 'expandBranch', nodeId: b })
    session.run({ type: 'archiveBranch', nodeId: b })
    expect(flags()).toEqual([off, { ...off, archived: true }, { ...off, archived: true }])

    session.run({ type: 'restoreNode', nodeId: b })
    expect(flags()).toEqual([off, off, { ...off, archived: true }])
    session.run({ type: 'archiveNode', nodeId: b })
    session.run({ type: 'restoreNode', nodeId: b, branch: true })
    expect(flags()).toEqual([off, off, off])
  })

  test('state commands reject unknown nodes', () => {
    const session = new Session()
    for (const type of ['collapseNode', 'expandBranch', 'archiveBranch', 'removeNode', 'removeBranch'] as const) {
      expectError(() => session.run({ type, nodeId: 'ghost' }), 'unknown-node')
    }
  })

  test('moveNodes and resizeNode change only the named nodes', () => {
    const session = new Session()
    const a = session.root()
    const b = session.root()
    session.run({ type: 'moveNodes', moves: [{ nodeId: a, position: { x: 5, y: 6 } }] }, { now: T1 })
    session.run({ type: 'resizeNode', nodeId: b, size: { width: 400, height: 300 } }, { now: T1 })

    expect(session.node(a)).toMatchObject({ position: { x: 5, y: 6 }, updatedAt: T1 })
    expect(session.node(b)).toMatchObject({ position: { x: 0, y: 440 }, size: { width: 400, height: 300 } })
    expectError(() => session.run({ type: 'moveNodes', moves: [{ nodeId: 'ghost', position: { x: 0, y: 0 } }] }), 'unknown-node')
  })

  test('updateNode patches the title, description, config, and cached presentation', () => {
    const session = new Session()
    const a = session.root(note('old', { shortDescription: 'desc' }))

    session.run(
      {
        type: 'updateNode',
        nodeId: a,
        patch: { title: 'Renamed', config: { body: 'new' }, cachedPresentation: { summary: 'sum', revision: 'r' } }
      },
      { now: T1 }
    )
    expect(session.node(a)).toMatchObject({
      title: 'Renamed',
      shortDescription: 'desc',
      config: { body: 'new' },
      cachedPresentation: { summary: 'sum', revision: 'r', updatedAt: T1 },
      updatedAt: T1
    })

    session.run({ type: 'updateNode', nodeId: a, patch: { shortDescription: null, cachedPresentation: null } })
    expect('shortDescription' in session.node(a)).toBe(false)
    expect('cachedPresentation' in session.node(a)).toBe(false)

    expectError(() => session.run({ type: 'updateNode', nodeId: a, patch: { config: { body: 3 } } }), 'invalid-config')
    expectError(() => session.run({ type: 'updateNode', nodeId: 'ghost', patch: { title: 'x' } }), 'unknown-node')
  })

  test('setNodeWorkspace sets or clears membership and rejects unknown workspaces', () => {
    const session = new Session()
    session.run({ type: 'upsertWorkspace', workspace: { id: 'ws', cwd: 'C:\\p', name: 'p' } })
    const a = session.root()
    session.run({ type: 'setNodeWorkspace', nodeId: a, workspaceId: 'ws' })
    expect(session.node(a).workspaceId).toBe('ws')
    session.run({ type: 'setNodeWorkspace', nodeId: a, workspaceId: null })
    expect(session.node(a).workspaceId).toBeNull()
    expectError(() => session.run({ type: 'setNodeWorkspace', nodeId: a, workspaceId: 'nope' }), 'unknown-workspace')
  })

  test('upsertWorkspace inserts by id, then updates in place keeping its creation time', () => {
    const session = new Session()
    session.run({ type: 'upsertWorkspace', workspace: { id: 'ws', cwd: 'C:\\p', name: 'p', paseoWorkspaceId: 'pw' } })
    session.run({ type: 'upsertWorkspace', workspace: { id: 'ws', cwd: 'D:\\p', name: 'renamed' } }, { now: T1 })

    expect(session.canvas.workspaces).toEqual([
      {
        version: DOMAIN_RECORD_VERSION,
        id: 'ws',
        projectId: 'project',
        cwd: 'D:\\p',
        name: 'renamed',
        paseoWorkspaceId: 'pw',
        createdAt: T0
      }
    ])
  })

  test('setViewport stores the viewport without recording activity', () => {
    const session = new Session()
    session.run({ type: 'setViewport', viewport: { x: 1, y: 2, zoom: 0.5 } })
    expect(session.canvas.viewport).toEqual({ x: 1, y: 2, zoom: 0.5 })
    expect(session.canvas.activity).toEqual([])
  })
})

test.describe('activity', () => {
  test('records the acting agent on every structural change', () => {
    const session = new Session()
    const a = session.root(note('a', { title: 'Alpha' }), { actor: agent })
    session.child(a, note('b', { title: 'Beta' }))
    session.run({ type: 'archiveNode', nodeId: a }, { actor: agent })

    expect(session.canvas.activity.map(({ actor, command }) => [actor.kind, command])).toEqual([
      ['agent', 'startTree'],
      ['user', 'spawnChild'],
      ['agent', 'archiveNode']
    ])
    expect(session.canvas.activity[1].summary).toMatch(/Beta/)
    expect(session.canvas.activity[1].summary).toMatch(/Alpha/)
    expect(session.canvas.activity[2]).toMatchObject({ nodeIds: [a], actor: agent })
  })

  test('skips user moves and resizes, system updates, viewport changes, and no-ops', () => {
    const session = new Session()
    const a = session.root()
    const count = () => session.canvas.activity.length
    const start = count()

    session.run({ type: 'moveNodes', moves: [{ nodeId: a, position: { x: 1, y: 1 } }] })
    session.run({ type: 'resizeNode', nodeId: a, size: { width: 400, height: 400 } })
    session.run({ type: 'updateNode', nodeId: a, patch: { title: 'by system' } }, { actor: system })
    session.run({ type: 'upsertWorkspace', workspace: { id: 'ws', cwd: 'C:\\p', name: 'p' } }, { actor: system })
    session.run({ type: 'setViewport', viewport: { x: 0, y: 0, zoom: 1 } }, { actor: agent })
    session.run({ type: 'collapseNode', nodeId: a })
    const afterCollapse = session.canvas
    session.run({ type: 'collapseNode', nodeId: a })
    expect(session.canvas).toBe(afterCollapse)
    expect(count()).toBe(start + 1)

    session.run({ type: 'moveNodes', moves: [{ nodeId: a, position: { x: 2, y: 2 } }] }, { actor: agent })
    session.run({ type: 'resizeNode', nodeId: a, size: { width: 300, height: 300 } }, { actor: system })
    session.run({ type: 'updateNode', nodeId: a, patch: { title: 'by user' } })
    session.run({ type: 'upsertWorkspace', workspace: { id: 'ws2', cwd: 'C:\\q', name: 'q' } }, { actor: agent })
    expect(count()).toBe(start + 5)
  })

  test('keeps only the newest entries', () => {
    const session = new Session()
    const a = session.root()
    for (let index = 0; index < CANVAS_ACTIVITY_LIMIT + 5; index += 1) {
      session.run({ type: index % 2 ? 'collapseNode' : 'expandNode', nodeId: a }, { now: `t${index}` })
    }
    expect(session.canvas.activity).toHaveLength(CANVAS_ACTIVITY_LIMIT)
    expect(session.canvas.activity.at(-1)?.at).toBe(`t${CANVAS_ACTIVITY_LIMIT + 4}`)
  })
})

test.describe('automatic placement across many spawns', () => {
  type Placed = { id: string; parent: string | null; tree: string }

  function rectOf(node: CanvasNode): Rect {
    return { ...node.position, ...(node.size ?? SIZES[node.entityType]) }
  }

  // True when the two rectangles are at least `gap` apart on some axis.
  function separated(a: Rect, b: Rect, gap: number): boolean {
    return (
      a.x + a.width + gap <= b.x || b.x + b.width + gap <= a.x || a.y + a.height + gap <= b.y || b.y + b.height + gap <= a.y
    )
  }

  function runScript(): { session: Session; placed: Placed[]; moved: string } {
    const session = new Session()
    const placed: Placed[] = []
    const seeds = [note(), agentSeed(), imageSeed, pageSeed]

    const spawn = (parent: string | null, seedIndex: number, target?: { kind: 'tree'; nodeId: string }) => {
      const before = new Map(session.canvas.nodes.map((node) => [node.id, node.position]))
      const seed = seeds[seedIndex % seeds.length]
      let id: string
      let actualParent: string | null = parent
      if (parent === null) {
        id = session.root(seed)
      } else if (target) {
        id = session.child(parent, seed, { target })
        actualParent = placed.find((entry) => entry.id === parent)!.tree
      } else {
        id = session.child(parent, seed)
      }
      const tree = actualParent === null ? id : placed.find((entry) => entry.id === actualParent)!.tree
      placed.push({ id, parent: actualParent, tree })

      // Existing nodes never move.
      for (const [nodeId, position] of before) expect(session.node(nodeId).position).toEqual(position)

      // The new node keeps sibling spacing within its tree and tree spacing from other trees.
      const fresh = session.node(id)
      for (const other of session.canvas.nodes) {
        if (other.id === id || other.archived) continue
        const otherTree = placed.find((entry) => entry.id === other.id)!.tree
        const gap = otherTree === tree ? 96 : 240
        expect(separated(rectOf(fresh), rectOf(other), gap), `${id} vs ${other.id}`).toBe(true)
      }

      // Children start one parent spacing to the right of their parent.
      if (actualParent !== null) {
        const parentRect = rectOf(session.node(actualParent))
        expect(fresh.position.x).toBe(parentRect.x + parentRect.width + 160)
        expect(fresh.position.y).toBeGreaterThanOrEqual(parentRect.y)
      }
      return id
    }

    const t1 = spawn(null, 1)
    const t1a = spawn(t1, 0)
    const t1b = spawn(t1, 2)
    spawn(t1a, 3)
    spawn(t1a, 0)
    const t2 = spawn(null, 3)
    const t2a = spawn(t2, 1)
    spawn(t2a, 2)
    spawn(t1b, 1)
    spawn(t1a, 2, { kind: 'tree', nodeId: t1a })

    // The user drags a node away; later spawns, including its own children, never reposition it.
    const moved = t1b
    session.run({ type: 'moveNodes', moves: [{ nodeId: t1b, position: { x: 6000, y: -2000 } }] })
    spawn(t1b, 0)
    spawn(t1b, 3)
    const t3 = spawn(null, 2)
    spawn(t3, 0)
    spawn(t2, 0)
    spawn(t1, 1)
    spawn(t1a, 0)
    spawn(null, 0)
    spawn(t2a, 3)
    spawn(t3, 1)
    return { session, placed, moved }
  }

  test('twenty mixed spawns over several trees never overlap, keep spacing, and never move a user-placed node', () => {
    const { session, placed, moved } = runScript()

    expect(placed).toHaveLength(20)
    expect(new Set(placed.map((entry) => entry.tree)).size).toBe(4)
    expect(new Set(session.canvas.nodes.map((node) => node.entityType))).toEqual(
      new Set(['note', 'agent', 'image', 'webpage'])
    )
    expect(session.node(moved).position).toEqual({ x: 6000, y: -2000 })

    const nodes = session.canvas.nodes
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        expect(separated(rectOf(nodes[i]), rectOf(nodes[j]), 0), `${nodes[i].id} overlaps ${nodes[j].id}`).toBe(true)
      }
    }

    // Siblings stack downward in creation order.
    for (const parent of new Set(placed.map((entry) => entry.parent))) {
      if (parent === null) continue
      const siblings = placed.filter((entry) => entry.parent === parent).map((entry) => session.node(entry.id))
      const autoPlaced = siblings.filter((node) => node.id !== moved)
      for (let index = 1; index < autoPlaced.length; index += 1) {
        expect(autoPlaced[index].position.y).toBeGreaterThanOrEqual(
          autoPlaced[index - 1].position.y + rectOf(autoPlaced[index - 1]).height + 96
        )
      }
    }
  })

  test('placement is deterministic', () => {
    expect(runScript().session.canvas).toEqual(runScript().session.canvas)
  })
})
