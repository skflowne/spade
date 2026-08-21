import { expect, test } from '@playwright/test'
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
  type PaseoAdapterNotification,
  type PaseoDaemonDriver
} from '../../prototypes/paseo-issue-to-pr-bridge/main/SpadePaseoAdapter'
import { CheckoutAdapterError } from '../../prototypes/paseo-issue-to-pr-bridge/main/spadePaseoCheckout'
import { runPaseoValidation } from '../../prototypes/paseo-issue-to-pr-bridge/main/validatePaseo'
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

const validationEnvironment: NodeJS.ProcessEnv = {
  SPADE_P3_PASEO_URL: 'ws://127.0.0.1:17677/ws',
  SPADE_P3_VALIDATION_CWD: '/opaque/checkout',
  SPADE_P3_VALIDATION_PROVIDER: 'codex',
  SPADE_P3_VALIDATION_MODEL: 'model-1',
  SPADE_P3_VALIDATION_ROOT_PROMPT: '  Caller root prompt\n',
  SPADE_P3_VALIDATION_CHILD_PROMPT: '\tCaller child prompt  '
}

type ValidationFixtureOptions = {
  fetchError?: string
  archiveFailures?: ReadonlySet<string>
  closeError?: string
}

function createValidationFixture(options: ValidationFixtureOptions = {}) {
  const root = agent('validation-root', null, 'validation-workspace')
  const child = agent('validation-child', root.id, 'validation-workspace')
  const calls = {
    prompts: [] as string[],
    archivedAgentIds: [] as string[],
    close: 0
  }
  const adapter = {
    connect: async () => undefined,
    openProjectCheckout: async () => workspace('validation-workspace'),
    spawnAgent: async (input: Parameters<SpadePaseoAdapter['spawnAgent']>[0]) => {
      calls.prompts.push(input.prompt)
      return input.parentAgentId ? child : root
    },
    attachAgent: async (id: string) => [root, child].find((candidate) => candidate.id === id) ?? null,
    fetchAuthoritative: async (): Promise<PaseoAuthoritativeSnapshot> => {
      if (options.fetchError) throw new Error(options.fetchError)
      return {
        rootAgentId: root.id,
        agentPages: [[root, child]],
        workspacePages: [[workspace('validation-workspace')]],
        providerSubagents: [],
        timelines: [
          { agentId: root.id, epoch: 'epoch-1', entries: [] },
          { agentId: child.id, epoch: 'epoch-1', entries: [] }
        ],
        refreshedAt: '2026-08-20T10:01:00Z'
      }
    },
    archiveAgent: async (id: string) => {
      calls.archivedAgentIds.push(id)
      if (options.archiveFailures?.has(id)) throw new Error(`archive ${id}`)
      return '2026-08-20T10:02:00Z'
    },
    close: async () => {
      calls.close += 1
      if (options.closeError) throw new Error(options.closeError)
    }
  }
  return { adapter, calls }
}

test('forwards caller-selected validation prompts and completes reverse cleanup', async () => {
  const fixture = createValidationFixture()

  await runPaseoValidation(validationEnvironment, () => fixture.adapter)

  expect(fixture.calls.prompts).toEqual(['  Caller root prompt\n', '\tCaller child prompt  '])
  expect(fixture.calls.archivedAgentIds).toEqual(['validation-child', 'validation-root'])
  expect(fixture.calls.close).toBe(1)
})

test('fails validation when archive or client-close cleanup fails', async () => {
  const archiveFixture = createValidationFixture({
    archiveFailures: new Set(['validation-child'])
  })
  await expect(runPaseoValidation(validationEnvironment, () => archiveFixture.adapter)).rejects.toThrow(
    'Failed to archive validation agent validation-child'
  )
  expect(archiveFixture.calls.archivedAgentIds).toEqual(['validation-child', 'validation-root'])
  expect(archiveFixture.calls.close).toBe(1)

  const closeFixture = createValidationFixture({ closeError: 'close failed' })
  await expect(runPaseoValidation(validationEnvironment, () => closeFixture.adapter)).rejects.toThrow(
    'Failed to close the Paseo validation client: close failed'
  )
  expect(closeFixture.calls.archivedAgentIds).toEqual(['validation-child', 'validation-root'])
  expect(closeFixture.calls.close).toBe(1)
})

test('preserves primary and cleanup failures while attempting every cleanup action', async () => {
  const fixture = createValidationFixture({
    fetchError: 'authoritative validation failed',
    archiveFailures: new Set(['validation-child']),
    closeError: 'close failed'
  })

  const failure = await runPaseoValidation(validationEnvironment, () => fixture.adapter).catch(
    (error: unknown) => error
  )

  expect(failure).toBeInstanceOf(AggregateError)
  expect((failure as AggregateError).errors.map((error) => String(error))).toEqual([
    'Error: authoritative validation failed',
    'Error: Failed to archive validation agent validation-child: archive validation-child',
    'Error: Failed to close the Paseo validation client: close failed'
  ])
  expect(fixture.calls.archivedAgentIds).toEqual(['validation-child', 'validation-root'])
  expect(fixture.calls.close).toBe(1)
})

test('uses one daemon driver while exhausting pages and refetching exact opaque references', async () => {
  const calls = {
    connect: 0,
    close: 0,
    agentLists: [] as unknown[],
    workspaceLists: [] as unknown[],
    agentRefreshes: [] as string[],
    agentArchives: [] as string[],
    timelines: [] as string[],
    providerReadyCwds: [] as string[],
    spawnOptions: [] as unknown[]
  }
  const agents = [agent('root', null, 'workspace-a'), agent('child', 'root', 'workspace-b')]
  const createdAgent = agent('created', null, 'workspace-a')
  const workspaces = [workspace('workspace-a'), workspace('workspace-b')]
  const subscribers = new Map<string, Array<() => void>>()
  const driver = {
    connect: async () => { calls.connect += 1 },
    close: async () => { calls.close += 1 },
    getConnectionState: () => ({ status: 'connected' as const }),
    on: (type: string, listener: () => void) => {
      subscribers.set(type, [...(subscribers.get(type) ?? []), listener])
      return () => undefined
    },
    fetchAgents: async (options: { page?: { cursor?: string } }) => {
      calls.agentLists.push(options)
      const second = options.page?.cursor === 'agents-2'
      return {
        requestId: 'agents',
        subscriptionId: second ? null : 'agent-subscription',
        entries: [{ agent: publicAgent(agents[second ? 1 : 0]), project: {} }],
        pageInfo: { nextCursor: second ? null : 'agents-2', prevCursor: null, hasMore: !second }
      }
    },
    fetchWorkspaces: async (options: { page?: { cursor?: string } }) => {
      calls.workspaceLists.push(options)
      const second = options.page?.cursor === 'workspaces-2'
      return {
        requestId: 'workspaces',
        subscriptionId: second ? null : 'workspace-subscription',
        entries: [publicWorkspace(workspaces[second ? 1 : 0])],
        pageInfo: { nextCursor: second ? null : 'workspaces-2', prevCursor: null, hasMore: !second }
      }
    },
    openProject: async () => ({ workspace: publicWorkspace(workspaces[0]), error: null }),
    createWorkspace: async () => ({ workspace: publicWorkspace(workspaces[1]), error: null }),
    fetchAgent: async (id: string) => {
      calls.agentRefreshes.push(id)
      const snapshot = [...agents, createdAgent].find((candidate) => candidate.id === id)
      return snapshot ? { agent: publicAgent(snapshot), project: null } : null
    },
    archiveAgent: async (id: string) => {
      calls.agentArchives.push(id)
      return { archivedAt: '2026-08-20T10:02:00Z' }
    },
    fetchAgentTimeline: async (id: string) => {
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
    },
    createAgent: async (options: unknown) => {
      calls.spawnOptions.push(options)
      return publicAgent(createdAgent)
    },
    getLastServerInfoMessage: () => ({ features: { providersSnapshotCwd: true } }),
    getProvidersSnapshot: async ({ cwd }: { cwd?: string }) => {
      calls.providerReadyCwds.push(cwd ?? '')
      return { requestId: 'providers', cwd: cwd ?? '', entries: [] }
    }
  } as unknown as PaseoDaemonDriver

  const notifications: PaseoAdapterNotification[] = []
  const adapter = new SpadePaseoAdapter({
    url: 'ws://127.0.0.1:7677/ws',
    driver,
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
    cwd: '/ignored/by/opaque-workspace',
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
  for (const type of ['agent_update', 'workspace_update', 'providers_snapshot_update']) {
    subscribers.get(type)?.[0]()
  }
  await adapter.close()

  expect(calls.connect).toBe(1)
  expect(calls.close).toBe(1)
  expect(calls.agentLists).toHaveLength(2)
  expect(calls.workspaceLists.some((options) =>
    (options as { page?: { cursor?: string } }).page?.cursor === 'workspaces-2'
  )).toBe(true)
  expect(calls.agentRefreshes).toEqual(['created', 'root', 'child'])
  expect(calls.agentArchives).toEqual(['created'])
  expect(calls.providerReadyCwds).toEqual(['/opaque/workspace-a'])
  expect(calls.spawnOptions).toEqual([{
    config: {
      provider: 'claude',
      model: 'model-1',
      cwd: '/opaque/workspace-a',
      title: 'Caller title'
    },
    cwd: '/opaque/workspace-a',
    workspaceId: 'workspace-a',
    initialPrompt: 'Caller prompt'
  }])
  expect(calls.timelines.sort()).toEqual(['child', 'root'])
  expect(snapshot.agentPages[0].map(({ id }) => id).sort()).toEqual(['child', 'root'])
  expect(snapshot.providerSubagents).toEqual([])
  expect(notifications.filter(({ type }) => type === 'refresh')).toHaveLength(3)
})

test('waits for a matching provider update before spawning through the daemon driver', async () => {
  let providerListener: ((message: { payload: { cwd: string; entries: unknown[] } }) => void) | null = null
  const created = agent('created-after-provider-ready', null, 'workspace-a')
  const driver = {
    on: (type: string, listener: typeof providerListener) => {
      if (type === 'providers_snapshot_update') providerListener = listener
      return () => undefined
    },
    fetchWorkspaces: async () => ({
      requestId: 'workspaces',
      entries: [publicWorkspace(workspace('workspace-a'))],
      pageInfo: { nextCursor: null, prevCursor: null, hasMore: false }
    }),
    getLastServerInfoMessage: () => ({ features: { providersSnapshotCwd: true } }),
    getProvidersSnapshot: async () => {
      queueMicrotask(() => providerListener?.({
        payload: {
          cwd: '/opaque/workspace-a',
          entries: [{ provider: 'claude', status: 'ready' }]
        }
      }))
      return {
        requestId: 'providers',
        cwd: '/opaque/workspace-a',
        entries: [{ provider: 'claude', status: 'loading' }]
      }
    },
    createAgent: async () => publicAgent(created)
  } as unknown as PaseoDaemonDriver
  const adapter = new SpadePaseoAdapter({
    url: 'ws://127.0.0.1:7677/ws',
    driver,
    pollIntervalMs: 0
  })

  await expect(adapter.spawnAgent({
    workspaceId: 'workspace-a',
    cwd: '/ignored',
    provider: 'claude',
    model: 'model-1',
    prompt: 'Start after discovery'
  })).resolves.toMatchObject({ id: created.id })
})

test('maps checkout operations through the same opaque-workspace daemon driver', async () => {
  const checkoutCalls: Array<{ method: string; cwd: string; input?: unknown }> = []
  let committed = false
  const workspaceRecord = publicWorkspace({
    ...workspace('workspace-checkout'),
    directory: '/opaque/checkout',
    branch: 'spade-19-checkout'
  })
  const driver = {
    fetchWorkspaces: async () => ({
      requestId: 'workspaces',
      entries: [workspaceRecord],
      pageInfo: { nextCursor: null, prevCursor: null, hasMore: false }
    }),
    getCheckoutStatus: async (cwd: string) => {
      checkoutCalls.push({ method: 'status', cwd })
      return {
        cwd,
        requestId: 'status',
        error: null,
        upstreamRef: 'origin/spade-19-checkout',
        isGit: true as const,
        isPaseoOwnedWorktree: false as const,
        repoRoot: cwd,
        mainRepoRoot: null,
        currentBranch: 'spade-19-checkout',
        isDirty: true,
        baseRef: 'origin/main',
        aheadBehind: { ahead: 1, behind: 0 },
        aheadOfOrigin: 0,
        behindOfOrigin: 0,
        hasRemote: true,
        remoteUrl: 'git@github.com:skflowne/spade-fixture.git'
      }
    },
    getCheckoutDiff: async (cwd: string) => {
      checkoutCalls.push({ method: 'diff', cwd })
      return {
        cwd,
        requestId: 'diff',
        error: null,
        diffTooLarge: false,
        files: [
          { path: 'fixture.txt', isNew: false, isDeleted: false, additions: 2, deletions: 1, hunks: [] },
          { path: 'evidence.txt', isNew: true, isDeleted: false, additions: 3, deletions: 0, hunks: [] }
        ]
      }
    },
    listCheckoutCommits: async (cwd: string) => {
      checkoutCalls.push({ method: 'commits', cwd })
      return {
        baseRef: 'origin/main',
        commits: [{
          sha: committed ? 'revision-after-commit' : 'revision-before-commit',
          shortSha: committed ? 'revision-a' : 'revision-b',
          subject: 'Fixture commit',
          authorName: 'SPADE',
          authorDate: '2026-08-21T01:00:00Z',
          isOnRemote: committed,
          isOnBase: false,
          files: []
        }]
      }
    },
    checkoutCommit: async (cwd: string, input: unknown) => {
      checkoutCalls.push({ method: 'commit', cwd, input })
      committed = true
      return { cwd, requestId: 'commit', success: true, error: null }
    },
    checkoutPush: async (cwd: string) => {
      checkoutCalls.push({ method: 'push', cwd })
      return { cwd, requestId: 'push', success: true, error: null }
    },
    checkoutPrCreate: async (cwd: string, input: unknown) => {
      checkoutCalls.push({ method: 'pr-create', cwd, input })
      return {
        cwd,
        requestId: 'pr-create',
        url: 'https://github.com/skflowne/spade-fixture/pull/7',
        number: 7,
        error: null
      }
    },
    checkoutPrStatus: async (cwd: string) => {
      checkoutCalls.push({ method: 'pr-status', cwd })
      return {
        cwd,
        requestId: 'pr-status',
        githubFeaturesEnabled: true,
        forge: 'github',
        authState: 'authenticated',
        error: null,
        status: {
          forge: 'github',
          number: 7,
          url: 'https://github.com/skflowne/spade-fixture/pull/7',
          title: 'Fixture PR',
          state: 'OPEN',
          baseRefName: 'main',
          headRefName: 'spade-19-checkout',
          isMerged: false,
          isDraft: false,
          mergeable: 'MERGEABLE',
          checks: [],
          repoOwner: 'skflowne',
          repoName: 'spade-fixture'
        }
      }
    }
  } as unknown as PaseoDaemonDriver
  const adapter = new SpadePaseoAdapter({
    url: 'ws://127.0.0.1:7677/ws',
    driver,
    pollIntervalMs: 0
  })

  await expect(adapter.checkoutStatus('workspace-checkout')).resolves.toEqual({
    workspaceId: 'workspace-checkout',
    branch: 'spade-19-checkout',
    headRevision: 'revision-before-commit',
    baseRef: 'origin/main',
    changedFiles: 2,
    additions: 5,
    deletions: 1,
    stagedFiles: null,
    unstagedFiles: null,
    untrackedFiles: null,
    conflicts: null
  })
  await expect(adapter.checkoutCommit('workspace-checkout', 'Fixture commit')).resolves.toEqual({
    revision: 'revision-after-commit'
  })
  await expect(adapter.checkoutPush('workspace-checkout')).resolves.toEqual({
    remote: 'origin',
    branch: 'spade-19-checkout'
  })
  await expect(adapter.checkoutCreatePullRequest('workspace-checkout', {
    title: 'Fixture PR',
    body: 'Disposable evidence',
    baseBranch: 'main'
  })).resolves.toEqual({
    repository: 'skflowne/spade-fixture',
    number: 7,
    url: 'https://github.com/skflowne/spade-fixture/pull/7'
  })
  await expect(adapter.checkoutPullRequestStatus('workspace-checkout')).resolves.toEqual({
    pullRequest: {
      repository: 'skflowne/spade-fixture',
      number: 7,
      url: 'https://github.com/skflowne/spade-fixture/pull/7'
    },
    state: 'OPEN'
  })

  expect(checkoutCalls.every(({ cwd }) => cwd === '/opaque/checkout')).toBe(true)
  expect(checkoutCalls.find(({ method }) => method === 'commit')?.input).toEqual({
    message: 'Fixture commit',
    addAll: true
  })
  expect(checkoutCalls.find(({ method }) => method === 'pr-create')?.input).toEqual({
    title: 'Fixture PR',
    body: 'Disposable evidence',
    baseRef: 'main'
  })
})

test('classifies missing workspaces and daemon checkout failures', async () => {
  const missingAdapter = new SpadePaseoAdapter({
    url: 'ws://127.0.0.1:7677/ws',
    driver: {
      fetchWorkspaces: async () => ({
        requestId: 'workspaces',
        entries: [],
        pageInfo: { nextCursor: null, prevCursor: null, hasMore: false }
      })
    } as unknown as PaseoDaemonDriver,
    pollIntervalMs: 0
  })
  await expect(missingAdapter.checkoutStatus('missing-workspace')).rejects.toMatchObject({
    name: 'CheckoutAdapterError',
    kind: 'missing-workspace'
  } satisfies Partial<CheckoutAdapterError>)

  const failedAdapter = new SpadePaseoAdapter({
    url: 'ws://127.0.0.1:7677/ws',
    driver: {
      fetchWorkspaces: async () => ({
        requestId: 'workspaces',
        entries: [publicWorkspace(workspace('workspace-checkout'))],
        pageInfo: { nextCursor: null, prevCursor: null, hasMore: false }
      }),
      checkoutPush: async (cwd: string) => ({
        cwd,
        requestId: 'push',
        success: false,
        error: { code: 'UNKNOWN' as const, message: 'push rejected' }
      })
    } as unknown as PaseoDaemonDriver,
    pollIntervalMs: 0
  })
  await expect(failedAdapter.checkoutPush('workspace-checkout')).rejects.toMatchObject({
    name: 'CheckoutAdapterError',
    kind: 'mutation',
    message: 'push rejected'
  } satisfies Partial<CheckoutAdapterError>)
})

test('rejects mismatched pull-request identities and unknown states from the daemon', async () => {
  const workspaceResponse = {
    requestId: 'workspaces',
    entries: [publicWorkspace(workspace('workspace-checkout'))],
    pageInfo: { nextCursor: null, prevCursor: null, hasMore: false }
  }
  const adapter = new SpadePaseoAdapter({
    url: 'ws://127.0.0.1:7677/ws',
    driver: {
      fetchWorkspaces: async () => workspaceResponse,
      checkoutPrCreate: async (cwd: string) => ({
        cwd,
        requestId: 'pr-create',
        url: 'https://github.com/skflowne/spade-fixture/pull/8',
        number: 7,
        error: null
      }),
      checkoutPrStatus: async (cwd: string) => ({
        cwd,
        requestId: 'pr-status',
        githubFeaturesEnabled: true,
        forge: 'github',
        error: null,
        status: {
          forge: 'github',
          number: 7,
          url: 'https://github.com/skflowne/spade-fixture/pull/7',
          title: 'Fixture PR',
          state: 'QUEUED',
          baseRefName: 'main',
          headRefName: 'fixture',
          isMerged: false,
          checks: []
        }
      })
    } as unknown as PaseoDaemonDriver,
    pollIntervalMs: 0
  })

  await expect(adapter.checkoutCreatePullRequest('workspace-checkout', {
    title: 'Fixture PR',
    body: 'Evidence'
  })).rejects.toMatchObject({ kind: 'mutation' } satisfies Partial<CheckoutAdapterError>)
  await expect(adapter.checkoutPullRequestStatus('workspace-checkout')).rejects.toMatchObject({
    kind: 'check',
    message: 'Paseo returned unknown pull-request state “QUEUED”.'
  } satisfies Partial<CheckoutAdapterError>)
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
