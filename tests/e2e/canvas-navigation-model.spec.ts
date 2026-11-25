import { expect, test } from '@playwright/test'
import {
  activityItems,
  agentDirectory,
  recentAgentChanges,
  relativeTime,
  RECENT_AGENT_CHANGE_MS
} from '../../src/renderer/src/canvas/model/activityView'
import { archivedEntries, archivedEntryOf, newlyArchived } from '../../src/renderer/src/canvas/model/archivedNodes'
import { canvasIndex } from '../../src/renderer/src/canvas/model/canvasIndex'
import {
  currentFocus,
  EMPTY_FOCUS_HISTORY,
  FOCUS_HISTORY_LIMIT,
  pushFocus,
  stepFocus
} from '../../src/renderer/src/canvas/model/focusHistory'
import { detailForZoom, overviewTitleScale, PREVIEW_ZOOM_THRESHOLD } from '../../src/renderer/src/canvas/model/levelOfDetail'
import { relatedTarget } from '../../src/renderer/src/canvas/model/relatedNodes'
import { searchNodes, type SearchCandidate } from '../../src/renderer/src/canvas/model/search'
import { canvasShortcut, type KeyChord } from '../../src/renderer/src/canvas/model/shortcuts'
import type { AgentRuntime, ChildAgentInfo } from '../../src/shared/agents'
import {
  DOMAIN_RECORD_VERSION,
  createEmptyCanvas,
  type Actor,
  type Canvas,
  type CanvasActivity,
  type CanvasEdge,
  type CanvasNode
} from '../../src/shared/domain'

function node(id: string, overrides: Partial<CanvasNode> = {}): CanvasNode {
  return {
    version: DOMAIN_RECORD_VERSION,
    id,
    entityType: 'note',
    entityVersion: 1,
    title: id,
    position: { x: 0, y: 0 },
    collapsed: false,
    branchCollapsed: false,
    archived: false,
    projectId: 'project',
    groupId: null,
    workspaceId: null,
    config: { body: '' },
    resourceRef: null,
    createdAt: '2026-11-21T00:00:00.000Z',
    updatedAt: '2026-11-21T00:00:00.000Z',
    ...overrides
  }
}

function edge(from: string, to: string, relation: CanvasEdge['relation'] = 'child'): CanvasEdge {
  return {
    version: DOMAIN_RECORD_VERSION,
    id: `${from}-${relation}-${to}`,
    fromNodeId: from,
    toNodeId: to,
    relation,
    createdAt: '2026-11-21T00:00:00.000Z'
  }
}

function canvasOf(nodes: CanvasNode[], edges: CanvasEdge[] = [], activity: CanvasActivity[] = []): Canvas {
  return { ...createEmptyCanvas('project'), nodes, edges, activity }
}

function entry(id: string, at: string, actor: Actor, nodeIds: string[], summary = `change ${id}`): CanvasActivity {
  return { id, at, actor, command: 'updateNode', summary, nodeIds }
}

const agentActor = (nodeId: string): Actor => ({ kind: 'agent', nodeId, agentId: `paseo-${nodeId}` })

test.describe('canvas index', () => {
  test('gives the path from the root, the collapsing ancestors, and references in both directions', () => {
    const canvas = canvasOf(
      [node('root', { branchCollapsed: true }), node('mid', { branchCollapsed: true }), node('leaf'), node('side')],
      [edge('root', 'mid'), edge('mid', 'leaf'), edge('leaf', 'side', 'references'), edge('side', 'root', 'references')]
    )
    const index = canvasIndex(canvas)

    expect(index.pathTo('leaf')).toEqual(['root', 'mid', 'leaf'])
    expect(index.pathTo('root')).toEqual(['root'])
    expect(index.pathTo('missing')).toEqual([])
    expect(index.collapsingAncestorsOf('leaf')).toEqual(['root', 'mid'])
    expect(index.referencesOf('side').map((ref) => [ref.direction, ref.otherNodeId])).toEqual([
      ['in', 'leaf'],
      ['out', 'root']
    ])
    expect(index.referencesOf('mid')).toEqual([])
  })

  test('is built once per canvas record', () => {
    const canvas = canvasOf([node('a')])
    expect(canvasIndex(canvas)).toBe(canvasIndex(canvas))
    expect(canvasIndex({ ...canvas })).not.toBe(canvasIndex(canvas))
  })
})

test.describe('search', () => {
  const candidates: SearchCandidate[] = [
    { nodeId: '1', title: 'Release notes', typeLabel: 'Note', status: null },
    { nodeId: '2', title: 'Notes', typeLabel: 'Note', status: null },
    { nodeId: '3', title: 'Refactor the parser', typeLabel: 'Agent', status: 'running' },
    { nodeId: '4', title: 'Parser review', typeLabel: 'Agent', status: 'attention' },
    { nodeId: '5', title: 'Screenshot', typeLabel: 'Image', status: null }
  ]
  const ids = (query: string): string[] => searchNodes(candidates, query).map((result) => result.nodeId)

  test('ranks an exact title over a title prefix over a word prefix over a substring', () => {
    expect(ids('notes')).toEqual(['2', '1'])
    expect(ids('parser')).toEqual(['4', '3'])
    expect(ids('arse')).toEqual(['3', '4'])
  })

  test('finds nodes by type and by agent status, below title matches', () => {
    expect(ids('image')).toEqual(['5'])
    expect(ids('running')).toEqual(['3'])
    expect(ids('note')).toEqual(['2', '1'])
  })

  test('requires every word to match somewhere and ignores case', () => {
    expect(ids('AGENT attention')).toEqual(['4'])
    expect(ids('parser running')).toEqual(['3'])
    expect(ids('parser image')).toEqual([])
  })

  test('finds nothing for an empty query and stops at the limit', () => {
    expect(ids('   ')).toEqual([])
    expect(searchNodes(candidates, 'e', 2)).toHaveLength(2)
  })
})

test.describe('focus history', () => {
  test('pushes explicit focus moves, ignores refocusing the current node, and drops the forward entries', () => {
    let history = pushFocus(pushFocus(pushFocus(EMPTY_FOCUS_HISTORY, 'a'), 'b'), 'b')
    expect(history.entries).toEqual(['a', 'b'])
    history = pushFocus(history, 'c')
    const back = stepFocus(history, -1, () => true)!
    expect(currentFocus(back)).toBe('b')
    const branched = pushFocus(back, 'd')
    expect(branched.entries).toEqual(['a', 'b', 'd'])
    expect(stepFocus(branched, 1, () => true)).toBeNull()
  })

  test('steps over entries whose node can no longer be focused, and reports the edges of the history', () => {
    const history = ['a', 'b', 'c', 'd'].reduce(pushFocus, EMPTY_FOCUS_HISTORY)
    const back = stepFocus(history, -1, (id) => id !== 'c')!
    expect(currentFocus(back)).toBe('b')
    expect(currentFocus(stepFocus(back, 1, (id) => id !== 'c')!)).toBe('d')
    expect(stepFocus(history, -1, () => false)).toBeNull()
    expect(stepFocus(EMPTY_FOCUS_HISTORY, -1, () => true)).toBeNull()
    expect(currentFocus(EMPTY_FOCUS_HISTORY)).toBeNull()
  })

  test('keeps a bounded number of entries', () => {
    let history = EMPTY_FOCUS_HISTORY
    for (let i = 0; i < FOCUS_HISTORY_LIMIT + 10; i += 1) history = pushFocus(history, `n${i}`)
    expect(history.entries).toHaveLength(FOCUS_HISTORY_LIMIT)
    expect(currentFocus(history)).toBe(`n${FOCUS_HISTORY_LIMIT + 9}`)
  })
})

test.describe('activity presentation', () => {
  const canvas = canvasOf(
    [node('lead', { entityType: 'agent', title: 'Lead agent' }), node('doc'), node('old', { archived: true })],
    [],
    [
      entry('1', '2026-11-21T10:00:00.000Z', { kind: 'user' }, ['doc']),
      entry('2', '2026-11-21T10:01:00.000Z', agentActor('lead'), ['old', 'doc']),
      entry('3', '2026-11-21T10:02:00.000Z', { kind: 'system' }, ['old']),
      entry('4', '2026-11-21T10:03:00.000Z', agentActor('removed-agent'), ['gone'])
    ]
  )

  test('lists the newest first with who acted and the first affected node that can still be shown', () => {
    const items = activityItems(canvas)
    expect(items.map((item) => [item.id, item.actor.label, item.targetNodeId])).toEqual([
      ['4', 'Agent paseo-removed-agent', null],
      ['3', 'SPADE', null],
      ['2', 'Lead agent', 'doc'],
      ['1', 'You', 'doc']
    ])
    expect(items[2].actor).toEqual({ kind: 'agent', label: 'Lead agent', agentId: 'paseo-lead', nodeId: 'lead', entityType: 'agent', exists: true })
    expect(items[0].actor).toMatchObject({ kind: 'agent', exists: false })
  })

  test('filters to agent changes', () => {
    expect(activityItems(canvas, { agentsOnly: true }).map((item) => item.id)).toEqual(['4', '2'])
  })

  test('marks the nodes an agent changed recently, newest change first, until the marker expires', () => {
    const at = Date.parse('2026-11-21T10:01:00.000Z')
    const withNewer = canvasOf(canvas.nodes, [], [
      ...canvas.activity,
      entry('5', '2026-11-21T10:04:00.000Z', agentActor('lead'), ['doc'], 'Renamed doc')
    ])
    const { changes, expiresAt } = recentAgentChanges(withNewer, at + 60_000)
    expect([...changes.keys()].sort()).toEqual(['doc', 'old'])
    expect(changes.get('doc')).toEqual({
      agentId: 'paseo-lead',
      agentNodeId: 'lead',
      agentLabel: 'Lead agent',
      at: '2026-11-21T10:04:00.000Z',
      summary: 'Renamed doc'
    })
    expect(expiresAt).toBe(at + RECENT_AGENT_CHANGE_MS)

    expect(recentAgentChanges(withNewer, at + RECENT_AGENT_CHANGE_MS + 4 * 60_000).changes.size).toBe(0)
  })

  test('never marks an agent as changed by itself when its own node is the source of its change', () => {
    const at = Date.parse('2026-11-21T10:05:00.000Z')
    const spawned = canvasOf(canvas.nodes, [], [
      entry('6', '2026-11-21T10:05:00.000Z', agentActor('lead'), ['doc', 'lead'], 'Spawned doc under Lead agent')
    ])
    expect([...recentAgentChanges(spawned, at).changes.keys()]).toEqual(['doc'])
  })

  test('shows an agent acting while collapsed by the agent, and marks what it changed but not its owner', () => {
    const child = (agentId: string, title: string | null, children: ChildAgentInfo[] = []): ChildAgentInfo => ({
      agentId,
      title,
      provider: 'claude',
      model: null,
      mode: null,
      status: 'running',
      activity: 'running',
      resourceState: 'live',
      pendingPermissions: [],
      lastError: null,
      updatedAt: '2026-11-21T10:00:00.000Z',
      nodeId: null,
      children
    })
    const runtime = (nodeId: string, agentId: string, title: string | null, children: ChildAgentInfo[], projectId = 'project'): AgentRuntime => ({
      projectId,
      nodeId,
      agentId,
      resourceState: 'live',
      parentAgentId: null,
      provider: 'claude',
      model: null,
      mode: null,
      title,
      status: 'idle',
      activity: 'idle',
      cwd: null,
      pendingPermissions: [],
      providerSubagents: [],
      children,
      lastError: null,
      updatedAt: '2026-11-21T10:00:00.000Z'
    })
    const agents = agentDirectory(
      [
        runtime('lead', 'paseo-lead', 'Lead', [child('worker', 'Worker', [child('helper', null)]), child('anon', null)]),
        runtime('other', 'paseo-other', 'Elsewhere', [child('foreign', 'Foreign')], 'another-project')
      ],
      'project'
    )
    expect([...agents.titles]).toEqual([['paseo-lead', 'Lead'], ['worker', 'Worker']])
    expect([...agents.owners]).toEqual([['worker', 'lead'], ['helper', 'lead'], ['anon', 'lead']])

    const collapsed = (agentId: string): Actor => ({ kind: 'agent', nodeId: null, agentId })
    const log = canvasOf(canvas.nodes, [], [
      entry('7', '2026-11-21T10:05:00.000Z', collapsed('worker'), ['doc', 'lead'], 'Spawned doc under Lead agent'),
      entry('8', '2026-11-21T10:06:00.000Z', collapsed('helper'), ['old']),
      entry('9', '2026-11-21T10:07:00.000Z', collapsed('unknown'), ['doc'])
    ])
    const items = activityItems(log, { agents })
    expect(items.map((item) => [item.id, item.actor.label, item.targetNodeId])).toEqual([
      ['9', 'Agent unknown', 'doc'],
      ['8', 'Agent helper', null],
      ['7', 'Worker', 'doc']
    ])
    expect(items[2].actor).toEqual({ kind: 'agent', label: 'Worker', agentId: 'worker', nodeId: null, entityType: null, exists: false })
    // Without the directory, the log still reads.
    expect(activityItems(log)[2].actor.label).toBe('Agent worker')

    const { changes } = recentAgentChanges(log, Date.parse('2026-11-21T10:08:00.000Z'), agents)
    expect([...changes.keys()].sort()).toEqual(['doc', 'old'])
    expect(changes.get('doc')).toMatchObject({ agentId: 'unknown', agentNodeId: null, agentLabel: 'Agent unknown' })
    expect(changes.get('old')).toMatchObject({ agentId: 'helper', agentLabel: 'Agent helper' })
  })

  test('finds a collapsed agent that was expanded since by its node', () => {
    const expanded = canvasOf(
      [...canvas.nodes, node('worker-node', { entityType: 'agent', title: 'Worker node', resourceRef: { provider: 'paseo', kind: 'agent', id: 'worker' } })],
      [],
      [entry('10', '2026-11-21T10:05:00.000Z', { kind: 'agent', nodeId: null, agentId: 'worker' }, ['doc'])]
    )
    expect(activityItems(expanded)[0].actor).toEqual({
      kind: 'agent',
      label: 'Worker node',
      agentId: 'worker',
      nodeId: 'worker-node',
      entityType: 'agent',
      exists: true
    })
  })

  test('describes how long ago something happened', () => {
    const now = Date.parse('2026-11-21T12:00:00.000Z')
    expect(relativeTime('2026-11-21T11:59:40.000Z', now)).toBe('just now')
    expect(relativeTime('2026-11-21T11:55:00.000Z', now)).toBe('5 min ago')
    expect(relativeTime('2026-11-21T09:00:00.000Z', now)).toBe('3 h ago')
    expect(relativeTime('2026-11-19T12:00:00.000Z', now)).toBe('2 d ago')
  })
})

test.describe('archived nodes', () => {
  test('lists the top of each archived stretch with what restoring or removing its branch touches', () => {
    const canvas = canvasOf(
      [
        node('root'),
        node('a', { archived: true, updatedAt: '2026-11-21T10:00:00.000Z' }),
        node('a1', { archived: true }),
        node('a2'),
        node('a2x', { archived: true, updatedAt: '2026-11-21T11:00:00.000Z' }),
        node('loose', { archived: true, updatedAt: '2026-11-21T09:00:00.000Z' })
      ],
      [edge('root', 'a'), edge('a', 'a1'), edge('a', 'a2'), edge('a2', 'a2x')]
    )
    const index = canvasIndex(canvas)

    expect(archivedEntries(index).map((item) => [item.nodeId, item.archivedInBranch, item.descendantCount])).toEqual([
      ['a2x', 1, 0],
      ['a', 3, 3],
      ['loose', 1, 0]
    ])
    expect(archivedEntryOf(index, 'a1')).toBe('a')
    expect(archivedEntryOf(index, 'a2x')).toBe('a2x')
    expect(archivedEntryOf(index, 'a2')).toBeNull()
  })

  test('names exactly the nodes an archive would newly archive, leaving those archived before', () => {
    const canvas = canvasOf(
      [node('parent'), node('child', { archived: true }), node('sibling'), node('grandchild'), node('other')],
      [edge('parent', 'child'), edge('parent', 'sibling'), edge('child', 'grandchild')]
    )
    const index = canvasIndex(canvas)
    expect(newlyArchived(index, 'parent', true).sort()).toEqual(['grandchild', 'parent', 'sibling'])
    expect(newlyArchived(index, 'parent', false)).toEqual(['parent'])
    expect(newlyArchived(index, 'child', false)).toEqual([])
    expect(newlyArchived(index, 'missing', true)).toEqual([])
  })
})

test.describe('related nodes', () => {
  const canvas = canvasOf(
    [node('r1'), node('c1'), node('c2', { archived: true }), node('c3'), node('g1'), node('r2'), node('r3')],
    [edge('r1', 'c1'), edge('r1', 'c2'), edge('r1', 'c3'), edge('c3', 'g1')]
  )
  const index = canvasIndex(canvas)

  test('goes to the parent and the first child, never to an archived node', () => {
    expect(relatedTarget(index, 'g1', 'parent')).toBe('c3')
    expect(relatedTarget(index, 'r1', 'parent')).toBeNull()
    expect(relatedTarget(index, 'r1', 'first-child')).toBe('c1')
    expect(relatedTarget(index, 'g1', 'first-child')).toBeNull()
  })

  test('steps through siblings, or through roots for a root, without wrapping', () => {
    expect(relatedTarget(index, 'c1', 'next-sibling')).toBe('c3')
    expect(relatedTarget(index, 'c3', 'previous-sibling')).toBe('c1')
    expect(relatedTarget(index, 'c3', 'next-sibling')).toBeNull()
    expect(relatedTarget(index, 'r1', 'next-sibling')).toBe('r2')
    expect(relatedTarget(index, 'r3', 'previous-sibling')).toBe('r2')
    expect(relatedTarget(index, 'missing', 'parent')).toBeNull()
  })
})

test.describe('keyboard shortcuts', () => {
  const chord = (overrides: Partial<KeyChord>): KeyChord => ({
    key: '',
    code: '',
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...overrides
  })

  test('maps search, history, and related-node chords', () => {
    expect(canvasShortcut(chord({ key: 'k', ctrlKey: true }))).toEqual({ kind: 'search' })
    expect(canvasShortcut(chord({ key: 'F', ctrlKey: true }))).toEqual({ kind: 'search' })
    expect(canvasShortcut(chord({ code: 'ArrowLeft', altKey: true }))).toEqual({ kind: 'history', step: -1 })
    expect(canvasShortcut(chord({ code: 'ArrowRight', altKey: true }))).toEqual({ kind: 'history', step: 1 })
    expect(canvasShortcut(chord({ code: 'ArrowUp', altKey: true }))).toEqual({ kind: 'related', direction: 'parent' })
    expect(canvasShortcut(chord({ code: 'ArrowDown', altKey: true }))).toEqual({ kind: 'related', direction: 'first-child' })
    expect(canvasShortcut(chord({ code: 'BracketLeft', key: '^', altKey: true }))).toEqual({
      kind: 'related',
      direction: 'previous-sibling'
    })
    expect(canvasShortcut(chord({ code: 'BracketRight', altKey: true }))).toEqual({ kind: 'related', direction: 'next-sibling' })
  })

  test('leaves plain, shifted, and other modified keys to text editing', () => {
    expect(canvasShortcut(chord({ code: 'ArrowLeft' }))).toBeNull()
    expect(canvasShortcut(chord({ code: 'ArrowLeft', altKey: true, shiftKey: true }))).toBeNull()
    expect(canvasShortcut(chord({ code: 'ArrowUp', altKey: true, ctrlKey: true }))).toBeNull()
    expect(canvasShortcut(chord({ key: 'k', ctrlKey: true, shiftKey: true }))).toBeNull()
    expect(canvasShortcut(chord({ key: 'k' }))).toBeNull()
  })
})

test.describe('level of detail', () => {
  test('switches to previews below the threshold zoom only', () => {
    expect(detailForZoom(1)).toBe('full')
    expect(detailForZoom(PREVIEW_ZOOM_THRESHOLD)).toBe('full')
    expect(detailForZoom(PREVIEW_ZOOM_THRESHOLD - 0.01)).toBe('preview')
    expect(detailForZoom(0.1)).toBe('preview')
  })

  test('grows the overview title as the canvas zooms out, within bounds', () => {
    expect(overviewTitleScale(1)).toBe(1)
    expect(overviewTitleScale(0.4)).toBeGreaterThan(overviewTitleScale(0.45))
    expect(overviewTitleScale(0.01)).toBe(overviewTitleScale(0.05))
  })
})
