import { expect, test } from '@playwright/test'
import { SpawnRequests, type SpawnEntry } from '../../src/renderer/src/canvas/spawn/spawnRequests'
import { agentAnchorOf, spawnCommand, type TargetChoice } from '../../src/renderer/src/canvas/spawn/spawnCommand'
import { createBuiltinEntityRegistry } from '../../src/shared/builtinEntities'
import type { CanvasCommand, CanvasCommandResponse, NodeSeed } from '../../src/shared/commands'
import { DOMAIN_RECORD_VERSION, createEmptyCanvas, type Canvas, type CanvasEdge, type CanvasNode } from '../../src/shared/domain'
import { TREE_SPACING } from '../../src/shared/layout'

type Deferred = { promise: Promise<CanvasCommandResponse>; finish(response: CanvasCommandResponse): void }

function deferred(): Deferred {
  let finish!: (response: CanvasCommandResponse) => void
  const promise = new Promise<CanvasCommandResponse>((resolve) => (finish = resolve))
  return { promise, finish }
}

function harness() {
  const shown: Array<SpawnEntry<string> | null> = []
  const focused: string[] = []
  const requests = new SpawnRequests<string>({ show: (entry) => shown.push(entry), focusCreated: (nodeId) => focused.push(nodeId) })
  const outcome = (entry: SpawnEntry<string>): Promise<string | null | 'pending'> =>
    Promise.race([entry.result, new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 10))])
  return { requests, shown, focused, outcome }
}

test.describe('spawn requests', () => {
  test('close the dialog, focus the created node, and answer the request that created it', async () => {
    const { requests, shown, focused, outcome } = harness()
    const entry = requests.open('note')
    expect(shown).toEqual([entry])
    await requests.create(entry, async () => ({ ok: true, nodeId: 'n1' }))
    expect(shown.at(-1)).toBeNull()
    expect(focused).toEqual(['n1'])
    expect(await outcome(entry)).toBe('n1')
  })

  test('answer null when the user cancels before creating, or when a newer request replaces the dialog', async () => {
    const { requests, outcome } = harness()
    const cancelled = requests.open('first')
    requests.dismiss(cancelled)
    expect(await outcome(cancelled)).toBeNull()
    const replaced = requests.open('second')
    requests.open('third')
    expect(await outcome(replaced)).toBeNull()
  })

  test('keep a failed creation open for another try', async () => {
    const { requests, shown, focused, outcome } = harness()
    const entry = requests.open('note')
    await requests.create(entry, async () => ({ ok: false, error: { code: 'internal', message: 'No' } }))
    expect(shown.at(-1)).toBe(entry)
    expect(focused).toEqual([])
    expect(await outcome(entry)).toBe('pending')
  })

  test('let a creation closed mid-way finish without touching a later dialog, its request, or the view', async () => {
    const { requests, shown, focused, outcome } = harness()
    const slow = requests.open('agent')
    const pending = deferred()
    const created = requests.create(slow, () => pending.promise)
    requests.dismiss(slow)
    expect(shown.at(-1)).toBeNull()
    // Still being created: the request has no answer yet.
    expect(await outcome(slow)).toBe('pending')

    const later = requests.open('note')
    pending.finish({ ok: true, nodeId: 'slow-node' })
    await created
    expect(shown.at(-1)).toBe(later)
    expect(requests.current).toBe(later)
    expect(focused).toEqual([])
    expect(await outcome(slow)).toBe('slow-node')
    expect(await outcome(later)).toBe('pending')

    await requests.create(later, async () => ({ ok: true, nodeId: 'later-node' }))
    expect(focused).toEqual(['later-node'])
    expect(await outcome(later)).toBe('later-node')
  })

  test('answer null for a creation closed mid-way that then fails', async () => {
    const { requests, outcome } = harness()
    const entry = requests.open('agent')
    const pending = deferred()
    const created = requests.create(entry, () => pending.promise)
    requests.open('note')
    pending.finish({ ok: false, error: { code: 'entity-create-failed', message: 'No' } })
    await created
    expect(await outcome(entry)).toBeNull()
  })
})

test.describe('spawn commands', () => {
  const registry = createBuiltinEntityRegistry()
  const at = '2026-11-21T00:00:00.000Z'
  const node = (id: string, entityType: string, position: { x: number; y: number }, workspaceId: string | null = null): CanvasNode => ({
    version: DOMAIN_RECORD_VERSION,
    id,
    entityType,
    entityVersion: 1,
    title: id,
    position,
    collapsed: false,
    branchCollapsed: false,
    archived: false,
    projectId: 'project',
    groupId: null,
    workspaceId,
    config: {},
    resourceRef: null,
    createdAt: at,
    updatedAt: at
  })
  const child = (from: string, to: string): CanvasEdge => ({
    version: DOMAIN_RECORD_VERSION,
    id: `${from}-${to}`,
    fromNodeId: from,
    toNodeId: to,
    relation: 'child',
    origin: 'spawned',
    createdAt: at
  })
  // Lead (an agent, 640×720) at the origin with a note child (320×200) to its right; Root is a note tree below.
  const canvas: Canvas = {
    ...createEmptyCanvas('project'),
    nodes: [node('lead', 'agent', { x: 0, y: 0 }, 'ws'), node('spec', 'note', { x: 800, y: 0 }), node('root', 'note', { x: 0, y: 2000 })],
    edges: [child('lead', 'spec')]
  }
  const agentSeed = { entityType: 'agent', config: { provider: 'claude', model: null, mode: null, prompt: 'Go' } }
  const noteSeed = { entityType: 'note', config: { body: '' } }
  const build = (seed: NodeSeed, sourceNodeId: string | null, choice: TargetChoice): CanvasCommand | null =>
    spawnCommand({ canvas, entities: registry, seed, sourceNodeId, choice, origin: 'spawned' })
  // Beside Lead at the spacing between trees, moved down past the note child it would otherwise touch.
  const besideLead = { x: 640 + TREE_SPACING, y: 200 + TREE_SPACING }

  test('an agent started from an agent node is placed next to it, unconnected, in its workspace', () => {
    expect(build(agentSeed, 'lead', { kind: 'source' })).toEqual({
      type: 'startTree',
      node: { ...agentSeed, workspaceId: 'ws', position: besideLead }
    })
  })

  test('an agent attached to an agent picked on the canvas, or to an agent rooted tree, is placed next to that agent', () => {
    for (const choice of [
      { kind: 'pick', nodeId: 'lead', attach: 'node' },
      { kind: 'pick', nodeId: 'spec', attach: 'root' }
    ] as const) {
      // The workspace still comes from the node the gesture started from, as for any spawn.
      expect(build(agentSeed, 'root', choice)).toEqual({ type: 'startTree', node: { ...agentSeed, position: besideLead } })
    }
    expect(agentAnchorOf(canvas, 'agent', { kind: 'tree', nodeId: 'spec' })?.id).toBe('lead')
    expect(agentAnchorOf(canvas, 'note', { kind: 'child', parentNodeId: 'lead' })).toBeNull()
  })

  test('an agent under a note, and notes under an agent, keep their tree targets', () => {
    expect(build(agentSeed, 'root', { kind: 'source' })).toEqual({
      type: 'spawnChild',
      sourceNodeId: 'root',
      node: agentSeed,
      target: { kind: 'child', parentNodeId: 'root' },
      origin: 'spawned'
    })
    expect(build(noteSeed, 'lead', { kind: 'source' })).toEqual({
      type: 'spawnChild',
      sourceNodeId: 'lead',
      node: noteSeed,
      target: { kind: 'child', parentNodeId: 'lead' },
      origin: 'spawned'
    })
    expect(build(agentSeed, 'lead', { kind: 'new-tree' })).toEqual({
      type: 'spawnChild',
      sourceNodeId: 'lead',
      node: agentSeed,
      target: { kind: 'new-tree' },
      origin: 'spawned'
    })
    expect(build(noteSeed, null, { kind: 'new-tree' })).toEqual({ type: 'startTree', node: noteSeed })
    expect(build(noteSeed, null, { kind: 'pick', nodeId: null, attach: 'node' })).toBeNull()
  })
})
