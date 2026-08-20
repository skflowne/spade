import { expect, test } from '@playwright/test'
import {
  applyPrototypeCommand,
  createInitialLedger
} from '../../prototypes/paseo-issue-to-pr-bridge/shared/commands'
import {
  normalizeTimelineEvents,
  reconcilePaseoWorkItem,
  type PaseoAgentSnapshot,
  type PaseoAuthoritativeSnapshot,
  type PaseoWorkspaceSnapshot
} from '../../prototypes/paseo-issue-to-pr-bridge/shared/paseoReconciliation'
import {
  PASEO_TIMELINE_LIMIT,
  resourceIdentity,
  type PrototypeLedger
} from '../../prototypes/paseo-issue-to-pr-bridge/shared/model'

function createLedger(): PrototypeLedger {
  let ledger = createInitialLedger('project-1', 'Prototype project')
  ledger = applyPrototypeCommand(ledger, {
    type: 'create-work-item',
    name: 'Issue 18',
    task: 'Integrate Paseo'
  }).ledger
  return ledger
}

function agent(
  id: string,
  parentAgentId: string | null,
  workspaceId: string | null
): PaseoAgentSnapshot {
  return {
    id,
    parentAgentId,
    workspaceId,
    title: id,
    provider: 'claude',
    model: 'model-1',
    status: 'idle',
    cwd: `/opaque/display/${id}`,
    updatedAt: `2026-08-20T10:00:0${id.length}Z`
  }
}

function workspace(id: string): PaseoWorkspaceSnapshot {
  return {
    id,
    projectId: 'paseo-project-1',
    name: id,
    directory: `/opaque/display/${id}`,
    branch: `display-${id}`,
    status: 'done',
    updatedAt: '2026-08-20T10:00:00Z'
  }
}

function authoritativeSnapshot(): PaseoAuthoritativeSnapshot {
  return {
    rootAgentId: 'root',
    agentPages: [
      [agent('root', null, 'workspace-shared'), agent('child-a', 'root', 'workspace-shared')],
      [agent('child-b', 'root', 'workspace-distinct'), agent('grandchild', 'child-a', null)]
    ],
    workspacePages: [[workspace('workspace-shared')], [workspace('workspace-distinct')]],
    providerSubagents: [
      {
        id: 'child-a',
        parentAgentId: 'root',
        provider: 'claude-native',
        title: 'Native child',
        status: 'completed',
        cwd: null,
        updatedAt: '2026-08-20T10:00:05Z',
        timeline: []
      }
    ],
    timelines: [
      {
        agentId: 'root',
        epoch: 'epoch-1',
        entries: [
          {
            timestamp: '2026-08-20T10:00:00Z',
            seqStart: 1,
            seqEnd: 1,
            item: { type: 'user_message', text: 'Start' }
          }
        ]
      }
    ],
    refreshedAt: '2026-08-20T10:01:00Z'
  }
}

test('recursively reconciles paginated descendants, exact parent edges, and shared workspaces', () => {
  const first = reconcilePaseoWorkItem(createLedger(), 'work-item-1', authoritativeSnapshot())
  const second = reconcilePaseoWorkItem(first, 'work-item-1', authoritativeSnapshot())

  const managed = second.nodes.filter(({ paseo }) => paseo?.type === 'managed-agent')
  const providerNative = second.nodes.filter(({ paseo }) => paseo?.type === 'provider-subagent')
  const workspaces = second.nodes.filter(({ paseo }) => paseo?.type === 'workspace')
  expect(managed.map(({ resourceRef }) => resourceRef.id).sort()).toEqual([
    'child-a',
    'child-b',
    'grandchild',
    'root'
  ])
  expect(providerNative).toHaveLength(1)
  expect(workspaces.map(({ resourceRef }) => resourceRef.id).sort()).toEqual([
    'workspace-distinct',
    'workspace-shared'
  ])

  const managedChild = managed.find(({ resourceRef }) => resourceRef.id === 'child-a')!
  const nativeChild = providerNative[0]
  expect(resourceIdentity(managedChild.resourceRef)).not.toBe(resourceIdentity(nativeChild.resourceRef))
  expect(managedChild.id).not.toBe(nativeChild.id)

  const nodeIdByAgentId = new Map(managed.map((node) => [node.resourceRef.id, node.id]))
  const delegated = second.edges
    .filter(({ relation }) => relation === 'delegated')
    .map(({ fromNodeId, toNodeId }) => [fromNodeId, toNodeId])
  expect(delegated).toEqual(expect.arrayContaining([
    [nodeIdByAgentId.get('root'), nodeIdByAgentId.get('child-a')],
    [nodeIdByAgentId.get('root'), nodeIdByAgentId.get('child-b')],
    [nodeIdByAgentId.get('child-a'), nodeIdByAgentId.get('grandchild')],
    [nodeIdByAgentId.get('root'), nativeChild.id]
  ]))
  expect(new Set(second.nodes.map(({ id }) => id)).size).toBe(second.nodes.length)
  expect(new Set(second.edges.map(({ id }) => id)).size).toBe(second.edges.length)
})

test('preserves durable mappings and marks missing descendants and workspaces', () => {
  const first = reconcilePaseoWorkItem(createLedger(), 'work-item-1', authoritativeSnapshot())
  const missingSnapshot: PaseoAuthoritativeSnapshot = {
    ...authoritativeSnapshot(),
    agentPages: [[agent('root', null, 'workspace-shared')]],
    workspacePages: [[workspace('workspace-shared')]],
    providerSubagents: [],
    timelines: []
  }
  const reconciled = reconcilePaseoWorkItem(first, 'work-item-1', missingSnapshot)

  expect(
    reconciled.nodes.find(({ resourceRef }) => resourceRef.id === 'child-a')?.paseo?.state
  ).toBe('missing')
  expect(
    reconciled.nodes.find(({ resourceRef }) => resourceRef.id === 'workspace-distinct')?.paseo?.state
  ).toBe('missing')
  expect(reconciled.nodes.find(({ resourceRef }) => resourceRef.id === 'child-a')).toBeDefined()
})

test('bounds normalized timelines and deduplicates sequenced and unsequenced replays', () => {
  const entries = Array.from({ length: PASEO_TIMELINE_LIMIT + 5 }, (_, index) => ({
    timestamp: `2026-08-20T10:00:${String(index).padStart(2, '0')}Z`,
    seqStart: index + 1,
    seqEnd: index + 1,
    item: { type: 'assistant_message', text: `Message ${index}` }
  }))
  entries.push(entries.at(-1)!)
  const normalized = normalizeTimelineEvents(entries, 'epoch-1')

  expect(normalized).toHaveLength(PASEO_TIMELINE_LIMIT)
  expect(normalized[0].sequenceStart).toBe(6)
  expect(new Set(normalized.map(({ id }) => id)).size).toBe(normalized.length)

  const unsequenced = normalizeTimelineEvents([
    {
      timestamp: '2026-08-20T11:00:00Z',
      item: { type: 'tool_call', name: 'read', status: 'completed', detail: { type: 'read', path: 'a' } }
    },
    {
      timestamp: '2026-08-20T11:00:00Z',
      item: { type: 'tool_call', name: 'read', status: 'completed', detail: { type: 'read', path: 'a' } }
    },
    {
      timestamp: '2026-08-20T11:00:01Z',
      item: { type: 'tool_call', name: 'read', status: 'completed', detail: { type: 'read', path: 'a' } }
    }
  ], null)
  expect(unsequenced).toHaveLength(2)
  expect(unsequenced[0].id).not.toBe(unsequenced[1].id)
  expect(unsequenced.every(({ initialExpanded }) => initialExpanded === false)).toBe(true)
})

test('exposes all supported and unavailable Paseo capability states explicitly', () => {
  const capabilities = createLedger().paseo.capabilities
  expect(capabilities).toHaveLength(8)
  expect(capabilities.find(({ name }) => name === 'timeline-fetch')?.state).toBe('available')
  expect(capabilities.find(({ name }) => name === 'provider-subagents')?.state).toBe('unavailable')
  expect(capabilities.find(({ name }) => name === 'live-timeline')?.state).toBe('unavailable')
  expect(capabilities.find(({ name }) => name === 'server-info')?.state).toBe('unavailable')
  for (const capability of capabilities) {
    expect(['available', 'unavailable', 'error']).toContain(capability.state)
  }
})
