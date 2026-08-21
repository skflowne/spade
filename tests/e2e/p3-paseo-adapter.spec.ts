import { expect, test } from '@playwright/test'
import type { PaseoClient } from '@getpaseo/client'
import {
  applyPrototypeCommand,
  createInitialLedger
} from '../../prototypes/paseo-issue-to-pr-bridge/shared/commands'
import {
  PrototypeCommandService,
  type PaseoAdapterPort
} from '../../prototypes/paseo-issue-to-pr-bridge/main/commandService'
import { createConfiguredPaseoAdapter } from '../../prototypes/paseo-issue-to-pr-bridge/main/paseoComposition'
import { registerSnapshotPublication } from '../../prototypes/paseo-issue-to-pr-bridge/main/snapshotPublication'
import {
  SpadePaseoAdapter,
  type PaseoAdapterNotification
} from '../../prototypes/paseo-issue-to-pr-bridge/main/SpadePaseoAdapter'
import type {
  PaseoAgentSnapshot,
  PaseoAuthoritativeSnapshot,
  PaseoWorkspaceSnapshot
} from '../../prototypes/paseo-issue-to-pr-bridge/shared/paseoReconciliation'
import type { PrototypeLedger } from '../../prototypes/paseo-issue-to-pr-bridge/shared/model'

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
    cwd: `/opaque/${id}`,
    updatedAt: '2026-08-20T10:00:00Z'
  }
}

function workspace(id: string): PaseoWorkspaceSnapshot {
  return {
    id,
    projectId: 'project-1',
    name: id,
    directory: `/opaque/${id}`,
    branch: null,
    status: 'done',
    updatedAt: '2026-08-20T10:00:00Z'
  }
}

function publicAgent(snapshot: PaseoAgentSnapshot): Record<string, unknown> {
  return {
    id: snapshot.id,
    provider: snapshot.provider,
    cwd: snapshot.cwd,
    workspaceId: snapshot.workspaceId ?? undefined,
    model: snapshot.model,
    createdAt: snapshot.updatedAt,
    updatedAt: snapshot.updatedAt,
    lastUserMessageAt: null,
    status: snapshot.status,
    capabilities: {},
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: snapshot.title,
    labels: snapshot.parentAgentId
      ? { 'paseo.parent-agent-id': snapshot.parentAgentId }
      : {}
  }
}

function publicWorkspace(snapshot: PaseoWorkspaceSnapshot): Record<string, unknown> {
  return {
    id: snapshot.id,
    projectId: snapshot.projectId,
    projectDisplayName: snapshot.projectId,
    projectRootPath: snapshot.directory,
    workspaceDirectory: snapshot.directory ?? undefined,
    projectKind: 'git',
    workspaceKind: 'checkout',
    name: snapshot.name,
    status: snapshot.status,
    statusEnteredAt: snapshot.updatedAt,
    activityAt: snapshot.updatedAt,
    scripts: [],
    gitRuntime: { currentBranch: snapshot.branch },
    githubRuntime: null
  }
}

test('uses one public client while exhausting pages and refetching exact opaque references', async () => {
  const calls = {
    connect: 0,
    agentLists: [] as unknown[],
    workspaceLists: [] as unknown[],
    agentRefreshes: [] as string[],
    agentArchives: [] as string[],
    workspaceRefreshes: [] as string[],
    timelines: [] as string[],
    providerReadyCwds: [] as string[],
    spawnOptions: [] as unknown[]
  }
  const agents = [agent('root', null, 'workspace-a'), agent('child', 'root', 'workspace-b')]
  const createdAgent = agent('created', null, 'workspace-a')
  const workspaces = [workspace('workspace-a'), workspace('workspace-b')]
  const agentSubscribers: Array<() => void> = []
  const workspaceSubscribers: Array<() => void> = []
  const providerSubscribers: Array<() => void> = []
  const fake = {
    connect: async () => { calls.connect += 1 },
    close: async () => undefined,
    getConnectionState: () => ({ status: 'connected' as const }),
    ensureConnected: () => undefined,
    agents: {
      subscribe: (listener: () => void) => {
        agentSubscribers.push(listener)
        return () => undefined
      },
      list: async (options: { page?: { cursor?: string } }) => {
        calls.agentLists.push(options)
        const second = options.page?.cursor === 'agents-2'
        return {
          requestId: 'agents',
          subscriptionId: second ? null : 'agent-subscription',
          entries: [{ agent: publicAgent(agents[second ? 1 : 0]), project: {} }],
          pageInfo: {
            nextCursor: second ? null : 'agents-2',
            prevCursor: null,
            hasMore: !second
          }
        }
      },
      ref: (id: string) => ({
        refresh: async () => {
          calls.agentRefreshes.push(id)
          const snapshot = [...agents, createdAgent].find((candidate) => candidate.id === id)
          return snapshot ? { agent: publicAgent(snapshot), project: null } : null
        },
        archive: async () => {
          calls.agentArchives.push(id)
          return { archivedAt: '2026-08-20T10:02:00Z' }
        },
        timeline: {
          refetch: async () => {
            calls.timelines.push(id)
            return {
              agentId: id,
              epoch: 'epoch-1',
              entries: [{
                timestamp: '2026-08-20T10:00:00Z',
                seqStart: 1,
                seqEnd: 1,
                item: { type: 'assistant_message', text: id }
              }],
              error: null
            }
          }
        }
      }),
      create: async (options: unknown) => {
        calls.spawnOptions.push(options)
        return {
          current: () => publicAgent(createdAgent),
          refresh: async () => ({ agent: publicAgent(createdAgent), project: null })
        }
      }
    },
    workspaces: {
      subscribe: (listener: () => void) => {
        workspaceSubscribers.push(listener)
        return () => undefined
      },
      list: async (options: { page?: { cursor?: string } }) => {
        calls.workspaceLists.push(options)
        const second = options.page?.cursor === 'workspaces-2'
        return {
          requestId: 'workspaces',
          subscriptionId: second ? null : 'workspace-subscription',
          entries: [publicWorkspace(workspaces[second ? 1 : 0])],
          pageInfo: {
            nextCursor: second ? null : 'workspaces-2',
            prevCursor: null,
            hasMore: !second
          }
        }
      },
      ref: (id: string) => ({
        refresh: async () => {
          calls.workspaceRefreshes.push(id)
          return publicWorkspace(workspaces.find((candidate) => candidate.id === id)!)
        },
        agents: {
          create: async (options: unknown) => {
            calls.spawnOptions.push(options)
            return {
              current: () => publicAgent(createdAgent),
              refresh: async () => ({ agent: publicAgent(createdAgent), project: null })
            }
          }
        }
      }),
      open: async () => ({
        current: () => publicWorkspace(workspaces[0]),
        refresh: async () => publicWorkspace(workspaces[0])
      }),
      create: async () => ({
        current: () => publicWorkspace(workspaces[1]),
        refresh: async () => publicWorkspace(workspaces[1])
      })
    },
    providers: {
      subscribe: (listener: () => void) => {
        providerSubscribers.push(listener)
        return () => undefined
      },
      waitForReady: async ({ cwd }: { cwd?: string }) => {
        calls.providerReadyCwds.push(cwd ?? '')
        return {}
      }
    }
  } as unknown as PaseoClient

  const notifications: PaseoAdapterNotification[] = []
  const adapter = new SpadePaseoAdapter({
    url: 'ws://127.0.0.1:7677/ws',
    client: fake,
    pollIntervalMs: 0,
    now: () => '2026-08-20T10:01:00Z'
  })
  adapter.subscribe((notification) => notifications.push(notification))
  await adapter.connect()
  expect((await adapter.openProjectCheckout('/opaque/checkout')).id).toBe('workspace-a')
  expect((await adapter.createWorkspace('/opaque/new', 'New workspace')).id).toBe('workspace-b')
  expect((await adapter.attachWorkspace('workspace-b'))?.id).toBe('workspace-b')
  expect(await adapter.spawnAgent({
    workspaceId: 'workspace-a',
    cwd: '/opaque/workspace-a',
    provider: 'claude',
    model: 'model-1',
    prompt: 'Caller prompt',
    title: 'Caller title'
  })).toMatchObject({ id: 'created', workspaceId: 'workspace-a' })
  expect((await adapter.attachAgent('created'))?.id).toBe('created')
  expect(await adapter.archiveAgent('created')).toBe('2026-08-20T10:02:00Z')
  const snapshot = await adapter.fetchAuthoritative('root', {
    agentIds: ['child'],
    workspaceIds: ['workspace-b']
  })
  agentSubscribers[0]()
  workspaceSubscribers[0]()
  providerSubscribers[0]()

  expect(calls.connect).toBe(1)
  expect(calls.agentLists).toHaveLength(2)
  expect(calls.workspaceLists).toHaveLength(2)
  expect(calls.agentRefreshes).toEqual(['created', 'root', 'child'])
  expect(calls.agentArchives).toEqual(['created'])
  expect(calls.workspaceRefreshes).toEqual(['workspace-b', 'workspace-a', 'workspace-b'])
  expect(calls.providerReadyCwds).toEqual(['/opaque/workspace-a'])
  expect(calls.spawnOptions).toEqual([{
    config: { provider: 'claude/model-1' },
    cwd: '/opaque/workspace-a',
    prompt: 'Caller prompt',
    title: 'Caller title'
  }])
  expect(calls.timelines.sort()).toEqual(['child', 'root'])
  expect(snapshot.agentPages[0].map(({ id }) => id).sort()).toEqual(['child', 'root'])
  expect(snapshot.providerSubagents).toEqual([])
  expect(notifications.filter(({ type }) => type === 'refresh')).toHaveLength(3)
})

class FakeAdapter implements PaseoAdapterPort {
  readonly url = 'ws://127.0.0.1:7677/ws'
  fetchCount = 0
  missingChild = false
  failNextFetch = false
  refreshOnConnect = false
  refreshDuringFetches = new Set<number>()
  missingAgentIds = new Set<string>()
  expectPersistedReferences = true
  attachWorkspaceIds: string[] = []
  private listener: ((notification: PaseoAdapterNotification) => void) | null = null

  subscribe(listener: (notification: PaseoAdapterNotification) => void): () => void {
    this.listener = listener
    return () => { this.listener = null }
  }

  emit(notification: PaseoAdapterNotification): void {
    this.listener?.(notification)
  }

  async connect(): Promise<void> {
    if (this.refreshOnConnect) this.emit({ type: 'refresh' })
  }
  async close(): Promise<void> {}
  pollConnectionState(): 'connected' { return 'connected' }
  async openProjectCheckout(): Promise<PaseoWorkspaceSnapshot> { return workspace('workspace-root') }
  async createWorkspace(): Promise<PaseoWorkspaceSnapshot> { return workspace('workspace-root') }
  async attachWorkspace(id: string): Promise<PaseoWorkspaceSnapshot | null> {
    this.attachWorkspaceIds.push(id)
    return workspace(id)
  }
  async spawnAgent(): Promise<PaseoAgentSnapshot> {
    return agent('root', null, 'workspace-root')
  }
  async attachAgent(id: string): Promise<PaseoAgentSnapshot | null> {
    return this.missingAgentIds.has(id) ? null : agent(id, null, 'workspace-root')
  }
  async fetchAuthoritative(
    rootAgentId: string,
    references: { agentIds: string[]; workspaceIds: string[] }
  ): Promise<PaseoAuthoritativeSnapshot> {
    this.fetchCount += 1
    expect(rootAgentId).toBe('root')
    if (this.refreshDuringFetches.has(this.fetchCount)) this.emit({ type: 'refresh' })
    if (this.failNextFetch) {
      this.failNextFetch = false
      throw new Error('injected authoritative refresh failure')
    }
    if (this.fetchCount > 1 && this.expectPersistedReferences) {
      expect(references.agentIds).toContain('root')
      expect(references.workspaceIds).toContain('workspace-root')
    }
    return {
      rootAgentId,
      agentPages: [[
        agent('root', null, 'workspace-root'),
        ...(this.missingChild ? [] : [agent('child', 'root', 'workspace-root')])
      ]],
      workspacePages: [[workspace('workspace-root')]],
      providerSubagents: [],
      timelines: [],
      refreshedAt: `2026-08-20T10:0${this.fetchCount}:00Z`
    }
  }
}

test('serializes root binding, restart refetch, missing preservation, and coalesced refresh triggers', async () => {
  let ledger = createInitialLedger('project-1', 'Prototype project')
  ledger = applyPrototypeCommand(ledger, {
    type: 'create-work-item',
    name: 'Issue 18',
    task: 'Integrate Paseo'
  }).ledger
  ledger = applyPrototypeCommand(ledger, {
    type: 'create-work-item',
    name: 'Unbound workspace',
    task: 'Preserve an attached workspace before a root is selected'
  }).ledger
  const state: { stored: PrototypeLedger | null } = { stored: null }
  const store = {
    load: async () => state.stored,
    save: async (next: PrototypeLedger) => { state.stored = structuredClone(next) }
  }
  const firstAdapter = new FakeAdapter()
  const first = new PrototypeCommandService(store, firstAdapter)
  await first.initialize(ledger)
  await first.execute({
    type: 'attach-workspace',
    targetGroup: 'work-item-2',
    workspaceId: 'workspace-unbound'
  })
  const attached = await first.execute({
    type: 'attach-agent',
    targetGroup: 'work-item-1',
    agentId: 'root'
  })

  expect(attached.paseo.bindings).toEqual([{ workItemId: 'work-item-1', rootAgentId: 'root' }])
  expect(attached.nodes.filter(({ paseo }) => paseo?.type === 'managed-agent')).toHaveLength(2)
  expect(
    attached.nodes.filter(({ paseo, workItemId }) =>
      paseo?.type === 'workspace' && workItemId === 'work-item-1'
    )
  ).toHaveLength(1)

  firstAdapter.emit({ type: 'refresh' })
  firstAdapter.emit({ type: 'refresh' })
  await first.execute({ type: 'set-work-item-status', workItemId: 'work-item-1', status: 'active' })
  expect(firstAdapter.fetchCount).toBe(2)
  await first.close()

  const secondAdapter = new FakeAdapter()
  secondAdapter.missingChild = true
  const restarted = new PrototypeCommandService(store, secondAdapter)
  const restored = await restarted.initialize()
  expect(secondAdapter.fetchCount).toBe(1)
  expect(secondAdapter.attachWorkspaceIds).toEqual(['workspace-unbound'])
  expect(restored.nodes.find(({ resourceRef }) => resourceRef.id === 'child')?.paseo?.state).toBe('missing')
  expect(new Set(restored.nodes.map(({ id }) => id)).size).toBe(restored.nodes.length)

  secondAdapter.emit({ type: 'connection', state: 'stale', error: 'restart' })
  secondAdapter.emit({ type: 'refresh' })
  secondAdapter.emit({ type: 'refresh' })
  secondAdapter.emit({ type: 'connection', state: 'connected', error: null })
  await restarted.execute({ type: 'set-work-item-status', workItemId: 'work-item-1', status: 'blocked' })
  await restarted.execute({ type: 'set-work-item-status', workItemId: 'work-item-1', status: 'active' })
  expect(restarted.snapshot().paseo.connection).toBe('connected')
  expect(secondAdapter.fetchCount).toBe(3)
  await restarted.close()
})

test('buffers initialization activity and refreshes again after the authoritative snapshot', async () => {
  let ledger = createInitialLedger('project-1', 'Prototype project')
  ledger = applyPrototypeCommand(ledger, {
    type: 'create-work-item',
    name: 'Issue 18',
    task: 'Integrate Paseo'
  }).ledger
  ledger = {
    ...ledger,
    paseo: {
      ...ledger.paseo,
      bindings: [{ workItemId: 'work-item-1', rootAgentId: 'root' }]
    }
  }
  const adapter = new FakeAdapter()
  adapter.refreshOnConnect = true
  adapter.refreshDuringFetches.add(1)
  const service = new PrototypeCommandService({
    load: async () => null,
    save: async () => undefined
  }, adapter)

  await service.initialize(ledger)
  await service.execute({ type: 'set-work-item-status', workItemId: 'work-item-1', status: 'active' })

  expect(adapter.fetchCount).toBe(2)
  await service.close()
})

test('persists a spawned opaque identity before refresh and keeps command failures local', async () => {
  let ledger = createInitialLedger('project-1', 'Prototype project')
  ledger = applyPrototypeCommand(ledger, {
    type: 'create-work-item',
    name: 'Issue 18',
    task: 'Integrate Paseo'
  }).ledger
  const state: { stored: PrototypeLedger | null } = { stored: null }
  const adapter = new FakeAdapter()
  const service = new PrototypeCommandService({
    load: async () => state.stored,
    save: async (next) => { state.stored = structuredClone(next) }
  }, adapter)
  await service.initialize(ledger)

  adapter.failNextFetch = true
  await expect(service.execute({
    type: 'spawn-agent',
    targetGroup: 'work-item-1',
    workspaceId: 'workspace-root',
    cwd: '/opaque/root',
    provider: 'claude',
    model: 'model-1',
    prompt: 'Caller prompt'
  })).rejects.toThrow('injected authoritative refresh failure')

  expect(service.snapshot().paseo.bindings).toEqual([
    { workItemId: 'work-item-1', rootAgentId: 'root' }
  ])
  expect(service.snapshot().nodes.find(({ resourceRef }) => resourceRef.id === 'root')).toBeDefined()
  expect(state.stored).toEqual(service.snapshot())
  expect(service.snapshot().paseo).toMatchObject({ connection: 'connected', error: null })

  await expect(service.execute({
    type: 'attach-agent',
    targetGroup: 'missing-work-item',
    agentId: 'root'
  })).rejects.toThrow('No group matches')
  expect(service.snapshot().paseo).toMatchObject({ connection: 'connected', error: null })

  adapter.missingAgentIds.add('missing-root')
  await expect(service.execute({
    type: 'attach-agent',
    targetGroup: 'work-item-1',
    agentId: 'missing-root'
  })).rejects.toThrow('Paseo agent missing-root is missing')
  expect(service.snapshot().paseo).toMatchObject({ connection: 'connected', error: null })
  await service.close()
})

test('composes the concrete adapter from the configured daemon URL', async () => {
  expect(createConfiguredPaseoAdapter({ SPADE_P3_DISABLE_PASEO: '1' })).toBeUndefined()
  const adapter = createConfiguredPaseoAdapter({
    SPADE_P3_PASEO_URL: 'ws://127.0.0.1:7777/ws'
  })
  expect(adapter?.url).toBe('ws://127.0.0.1:7777/ws')
  await adapter?.close()
})

test('forwards command and adapter snapshots once through one disposable publication path', async () => {
  const adapter = new FakeAdapter()
  const service = new PrototypeCommandService({
    load: async () => null,
    save: async () => undefined
  }, adapter)
  await service.initialize(createInitialLedger('project-1', 'Prototype project'))
  const snapshots: PrototypeLedger[] = []
  const unregister = registerSnapshotPublication(service, {
    isDestroyed: () => false,
    send: (snapshot) => snapshots.push(snapshot)
  })

  await service.execute({ type: 'create-group', name: 'Once' })
  expect(snapshots).toHaveLength(1)
  expect(snapshots[0].groups.map(({ name }) => name)).toEqual(['Once'])

  adapter.emit({ type: 'connection', state: 'stale', error: 'restart' })
  await service.execute({ type: 'create-group', name: 'Flush adapter update' })
  expect(snapshots.filter(({ paseo }) => paseo.connection === 'stale')).toHaveLength(2)
  expect(snapshots.filter(({ groups }) => groups.some(({ name }) => name === 'Flush adapter update'))).toHaveLength(1)

  unregister()
  await service.execute({ type: 'create-group', name: 'After cleanup' })
  expect(snapshots).toHaveLength(3)
  await service.close()
})

test('transfers one opaque root binding between WorkItems without leaving a duplicate owner', async () => {
  let ledger = createInitialLedger('project-1', 'Prototype project')
  for (const name of ['First', 'Second']) {
    ledger = applyPrototypeCommand(ledger, {
      type: 'create-work-item',
      name,
      task: `Own ${name}`
    }).ledger
  }
  const adapter = new FakeAdapter()
  adapter.expectPersistedReferences = false
  const service = new PrototypeCommandService({
    load: async () => null,
    save: async () => undefined
  }, adapter)
  await service.initialize(ledger)

  await service.execute({ type: 'attach-agent', targetGroup: 'work-item-1', agentId: 'root' })
  const transferred = await service.execute({
    type: 'attach-agent',
    targetGroup: 'work-item-2',
    agentId: 'root'
  })

  expect(transferred.paseo.bindings).toEqual([
    { workItemId: 'work-item-2', rootAgentId: 'root' }
  ])
  expect(transferred.nodes.find(({ resourceRef }) => resourceRef.id === 'root')?.workItemId).toBe(
    'work-item-2'
  )
  await service.close()
})
