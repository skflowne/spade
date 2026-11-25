import { expect, test } from '@playwright/test'
import { DaemonConnectionError, type ConnectionState } from '@getpaseo/client/internal/daemon-client'
import { AGENT_PERMISSION_DETAIL_LIMIT, AGENT_TIMELINE_PAGE_LIMIT } from '../../src/shared/agents'
import {
  PaseoAdapter,
  PaseoUnavailableError,
  daemonClientOptions,
  type PaseoAdapterEvent,
  type PaseoDaemonDriver
} from '../../src/main/paseo/PaseoAdapter'
import { createPaseoAdapter } from '../../src/main/paseo'
import { agentActivity } from '../../src/main/paseo/snapshots'
import { DEFAULT_PASEO_URL, normalizePaseoUrl, resolvePaseoUrl } from '../../src/main/paseo/url'

const URL_UNDER_TEST = 'ws://127.0.0.1:17677/ws'
const LONG_AGO = '2020-01-01T00:00:00.000Z'

type Call = { method: string; args: unknown[] }
type Handler = (message: { type: string; payload: unknown }) => void

function agentRecord(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    provider: 'claude',
    cwd: '/work/project',
    workspaceId: 'workspace-1',
    model: 'claude-haiku-4-5',
    createdAt: LONG_AGO,
    updatedAt: LONG_AGO,
    lastUserMessageAt: null,
    status: 'idle',
    capabilities: {},
    currentModeId: 'default',
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: `Agent ${id}`,
    labels: {},
    ...overrides
  }
}

function timelineEntry(seqStart: number, text: string, seqEnd = seqStart) {
  return {
    provider: 'claude',
    item: { type: 'assistant_message', text },
    timestamp: '2026-11-21T10:00:00.000Z',
    seqStart,
    seqEnd,
    sourceSeqRanges: [],
    collapsed: []
  }
}

function timelinePayload(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'timeline',
    agentId: 'agent-1',
    agent: null,
    direction: 'tail',
    projection: 'projected',
    epoch: 'epoch-1',
    reset: false,
    staleCursor: false,
    gap: false,
    window: { minSeq: 1, maxSeq: 30, nextSeq: 31 },
    startCursor: { epoch: 'epoch-1', seq: 20 },
    endCursor: { epoch: 'epoch-1', seq: 30 },
    hasOlder: true,
    hasNewer: false,
    entries: [timelineEntry(20, 'older'), timelineEntry(25, 'newer', 30)],
    error: null,
    ...overrides
  }
}

class FakeDriver {
  readonly calls: Call[] = []
  readonly handlers = new Map<string, Handler[]>()
  readonly released: unknown[] = []
  statusListener: ((status: ConnectionState) => void) | null = null
  autoConnect = true
  features: Record<string, boolean> = { providersSnapshotCwd: true }
  agents = new Map<string, Record<string, unknown>>()
  agentPages: Array<{ entries: Array<{ agent: Record<string, unknown> }>; nextCursor: string | null }> = []
  providerSnapshots: Array<Array<Record<string, unknown>>> = []
  timelineResponses: Array<Record<string, unknown>> = []
  subagentTimelineResponses: Array<Record<string, unknown>> = []
  subagentList: () => Promise<Record<string, unknown>> = async () => ({ requestId: 'r', parentAgentId: 'p', subagents: [], error: null })
  createdAgent = agentRecord('created')

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args })
  }

  callsOf(method: string): unknown[][] {
    return this.calls.filter((call) => call.method === method).map((call) => call.args)
  }

  setStatus(status: ConnectionState): void {
    this.statusListener?.(status)
  }

  deliver(type: string, payload: unknown): void {
    for (const handler of this.handlers.get(type) ?? []) handler({ type, payload })
  }

  observation(label: string, ...args: unknown[]) {
    this.record(label, ...args)
    return {
      subscriptionId: null,
      ready: Promise.resolve({}),
      subscribe: () => () => undefined,
      release: async () => { this.released.push([label, ...args]) }
    }
  }

  connect = async () => {
    this.record('connect')
    if (this.autoConnect) this.setStatus({ status: 'connected' })
  }
  closeDelayMs = 0
  close = async () => {
    this.record('close')
    if (this.closeDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.closeDelayMs))
  }
  subscribeConnectionStatus = (listener: (status: ConnectionState) => void) => {
    this.statusListener = listener
    return () => { this.statusListener = null }
  }
  on = (type: string, handler: Handler) => {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler])
    return () => this.handlers.set(type, (this.handlers.get(type) ?? []).filter((candidate) => candidate !== handler))
  }
  getLastServerInfoMessage = () => ({ features: this.features })
  observeAgents = (options: unknown) => this.observation('observeAgents', options)
  observeEvents = (events: unknown) => this.observation('observeEvents', events)
  observeTimeline = (ids: unknown) => this.observation('observeTimeline', ids)
  fetchAgent = async (id: string) => {
    this.record('fetchAgent', id)
    const agent = this.agents.get(id)
    return agent ? { agent, project: null } : null
  }
  fetchAgents = async (options: unknown) => {
    this.record('fetchAgents', options)
    const page = this.agentPages.shift() ?? { entries: [], nextCursor: null }
    return { requestId: 'agents', entries: page.entries, pageInfo: { nextCursor: page.nextCursor, prevCursor: null, hasMore: Boolean(page.nextCursor) } }
  }
  createAgent = async (options: unknown) => {
    this.record('createAgent', options)
    return this.createdAgent
  }
  sendAgentMessage = async (...args: unknown[]) => { this.record('sendAgentMessage', ...args); return {} }
  cancelAgent = async (...args: unknown[]) => { this.record('cancelAgent', ...args) }
  setAgentMode = async (...args: unknown[]) => { this.record('setAgentMode', ...args); return null }
  archiveAgent = async (...args: unknown[]) => { this.record('archiveAgent', ...args); return { archivedAt: '2026-11-21T11:00:00.000Z' } }
  respondToPermission = async (...args: unknown[]) => { this.record('respondToPermission', ...args) }
  fetchAgentTimeline = async (...args: unknown[]) => {
    this.record('fetchAgentTimeline', ...args)
    return this.timelineResponses.shift() ?? timelinePayload()
  }
  listProviderSubagents = async (...args: unknown[]) => {
    this.record('listProviderSubagents', ...args)
    return this.subagentList()
  }
  fetchProviderSubagentTimeline = async (...args: unknown[]) => {
    this.record('fetchProviderSubagentTimeline', ...args)
    return this.subagentTimelineResponses.shift()
  }
  getProvidersSnapshot = async (options: unknown) => {
    this.record('getProvidersSnapshot', options)
    return { requestId: 'providers', cwd: '/work/project', entries: this.providerSnapshots.length > 1 ? this.providerSnapshots.shift()! : this.providerSnapshots[0] ?? [] }
  }
}

async function connectedAdapter(driver = new FakeDriver()) {
  const adapter = new PaseoAdapter({
    url: URL_UNDER_TEST,
    createDriver: () => driver as unknown as PaseoDaemonDriver,
    providerDiscoveryPollMs: 1,
    providerDiscoveryTimeoutMs: 200
  })
  const events: PaseoAdapterEvent[] = []
  adapter.subscribe((event) => events.push(event))
  await adapter.start()
  return { adapter, driver, events }
}

test.describe('daemon URL resolution', () => {
  const files = (entries: Record<string, string>) => (path: string) => entries[path] ?? null

  test('prefers the explicit setting, then the environment, then the local daemon, then the default', () => {
    const readFile = files({ '/home/me/.paseo/paseo.pid': JSON.stringify({ pid: 1, listen: '127.0.0.1:6768' }) })
    const env = { SPADE_PASEO_URL: 'ws://10.0.0.2:7000/ws' }

    expect(resolvePaseoUrl({ setting: 'ws://10.0.0.1:7000/ws', env, homeDir: '/home/me', readFile }))
      .toEqual({ url: 'ws://10.0.0.1:7000/ws', source: 'setting' })
    expect(resolvePaseoUrl({ setting: null, env, homeDir: '/home/me', readFile }))
      .toEqual({ url: 'ws://10.0.0.2:7000/ws', source: 'environment' })
    expect(resolvePaseoUrl({ env: {}, homeDir: '/home/me', readFile }))
      .toEqual({ url: 'ws://127.0.0.1:6768/ws', source: 'local-daemon' })
    expect(resolvePaseoUrl({ env: {}, homeDir: '/home/me', readFile: files({}) }))
      .toEqual({ url: DEFAULT_PASEO_URL, source: 'default' })
  })

  test('falls back to the configured listen address and honors PASEO_HOME', () => {
    const readFile = files({
      '/srv/paseo/paseo.pid': JSON.stringify({ pid: 1, listen: null }),
      '/srv/paseo/config.json': JSON.stringify({ daemon: { listen: '0.0.0.0:6900' } })
    })

    expect(resolvePaseoUrl({ env: { PASEO_HOME: '/srv/paseo' }, homeDir: '/home/me', readFile }))
      .toEqual({ url: 'ws://127.0.0.1:6900/ws', source: 'local-daemon' })
  })

  test('skips unusable values instead of failing', () => {
    const readFile = files({ '/home/me/.paseo/paseo.pid': JSON.stringify({ listen: '/run/paseo.sock' }) })

    expect(resolvePaseoUrl({ setting: 'not a url', env: { SPADE_PASEO_URL: '' }, homeDir: '/home/me', readFile }))
      .toEqual({ url: DEFAULT_PASEO_URL, source: 'default' })
    expect(resolvePaseoUrl({ env: {}, homeDir: '/home/me', readFile: files({ '/home/me/.paseo/paseo.pid': '{broken' }) }).source)
      .toBe('default')
  })

  test('normalizes the address forms Paseo accepts', () => {
    expect(normalizePaseoUrl('6768')).toBe('ws://127.0.0.1:6768/ws')
    expect(normalizePaseoUrl('localhost:6767')).toBe('ws://localhost:6767/ws')
    expect(normalizePaseoUrl('tcp://192.168.1.5:6767')).toBe('ws://192.168.1.5:6767/ws')
    expect(normalizePaseoUrl('[::]:6767')).toBe('ws://127.0.0.1:6767/ws')
    expect(normalizePaseoUrl('wss://paseo.example/ws')).toBe('wss://paseo.example/ws')
    expect(normalizePaseoUrl('unix:///tmp/paseo.sock')).toBeNull()
  })
})

test('composes the adapter from the URL setting, or disabled when the environment opts out', async () => {
  const configured = createPaseoAdapter({ setting: 'ws://127.0.0.1:7777/ws', env: {} })
  const disabled = createPaseoAdapter({ setting: 'ws://127.0.0.1:7777/ws', env: { SPADE_DISABLE_PASEO: '1' } })

  expect(configured.connection()).toEqual({ state: 'disconnected', url: 'ws://127.0.0.1:7777/ws', error: null })
  expect(disabled.connection().state).toBe('disabled')
  await disabled.start()
  expect(disabled.connection().state).toBe('disabled')
})

test('identifies the daemon client with a semver app version and reconnects', () => {
  const options = daemonClientOptions(URL_UNDER_TEST)
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(options.appVersion ?? '')
  expect(match).not.toBeNull()
  const [major, minor, patch] = match!.slice(1).map(Number)
  expect(major * 1e6 + minor * 1e3 + patch).toBeGreaterThanOrEqual(1 * 1e3 + 45)
  expect(options).toMatchObject({ url: URL_UNDER_TEST, reconnect: { enabled: true } })
})

test('a disabled adapter never opens a connection and rejects every daemon operation', async () => {
  let created = 0
  const adapter = new PaseoAdapter({
    url: URL_UNDER_TEST,
    disabled: true,
    createDriver: () => {
      created += 1
      return new FakeDriver() as unknown as PaseoDaemonDriver
    }
  })

  await adapter.start()

  expect(created).toBe(0)
  expect(adapter.connection()).toEqual({ state: 'disabled', url: URL_UNDER_TEST, error: null })
  await expect(adapter.ready(10)).rejects.toBeInstanceOf(PaseoUnavailableError)
  await expect(adapter.getAgent('agent-1')).rejects.toBeInstanceOf(PaseoUnavailableError)
  await expect(adapter.listProviders('/work/project')).rejects.toBeInstanceOf(PaseoUnavailableError)
  await adapter.stop()
})

test('connects once, observes agents and session events, and reports readiness', async () => {
  const { adapter, driver, events } = await connectedAdapter()

  await adapter.ready(10)

  expect(driver.callsOf('connect')).toHaveLength(1)
  expect(driver.callsOf('observeAgents')).toEqual([[{ filter: { includeArchived: true, includeBackground: true }, page: { limit: 1 } }]])
  expect(driver.callsOf('observeEvents')).toEqual([[['agent_permission_request', 'agent_permission_resolved', 'agent.provider_subagents.update']]])
  expect(events.filter(({ type }) => type === 'connection')).toEqual([
    { type: 'connection', connection: { state: 'connecting', url: URL_UNDER_TEST, error: null } },
    { type: 'connection', connection: { state: 'connected', url: URL_UNDER_TEST, error: null } }
  ])

  await adapter.stop()
  expect(driver.released).toHaveLength(2)
  expect(driver.callsOf('close')).toHaveLength(1)
  expect(adapter.connection().state).toBe('disconnected')
})

test('keeps retrying an unreachable daemon and distinguishes first connection from reconnection', async () => {
  const driver = new FakeDriver()
  driver.autoConnect = false
  const adapter = new PaseoAdapter({ url: URL_UNDER_TEST, createDriver: () => driver as unknown as PaseoDaemonDriver })
  const states: string[] = []
  adapter.subscribe((event) => {
    if (event.type === 'connection') states.push(`${event.connection.state}:${event.connection.error ?? ''}`)
  })

  const started = adapter.start()
  driver.setStatus({ status: 'disconnected', reason: 'connect ECONNREFUSED' })
  await started

  expect(adapter.connection()).toMatchObject({ state: 'connecting', error: 'connect ECONNREFUSED' })
  await expect(adapter.getAgent('agent-1')).rejects.toBeInstanceOf(PaseoUnavailableError)

  driver.setStatus({ status: 'connected' })
  await adapter.ready(50)
  driver.setStatus({ status: 'disconnected', reason: 'socket closed' })
  driver.setStatus({ status: 'connecting', attempt: 1 })
  driver.setStatus({ status: 'connected' })
  await adapter.ready(50)

  expect(states).toEqual([
    'connecting:',
    'connecting:connect ECONNREFUSED',
    'connected:',
    'reconnecting:socket closed',
    'connected:'
  ])
  expect(driver.callsOf('observeAgents')).toHaveLength(1)
  await adapter.stop()
})

test('switches to another daemon URL with a new client, and reconnects only when the URL changed or the connection is down', async () => {
  const drivers: Array<{ url: string; driver: FakeDriver }> = []
  const adapter = new PaseoAdapter({
    url: URL_UNDER_TEST,
    createDriver: (url) => {
      const driver = new FakeDriver()
      drivers.push({ url, driver })
      return driver as unknown as PaseoDaemonDriver
    }
  })
  const connections: string[] = []
  adapter.subscribe((event) => {
    if (event.type === 'connection') connections.push(`${event.connection.state}@${event.connection.url}`)
  })
  await adapter.start()
  await adapter.watchTimelines(['agent-1'])

  await adapter.reconnect(URL_UNDER_TEST)
  expect(drivers).toHaveLength(1)

  const other = 'ws://127.0.0.1:17999/ws'
  await adapter.reconnect(other)
  expect(drivers.map(({ url }) => url)).toEqual([URL_UNDER_TEST, other])
  expect(drivers[0].driver.callsOf('close')).toHaveLength(1)
  expect(adapter.url).toBe(other)
  expect(adapter.connection()).toEqual({ state: 'connected', url: other, error: null })
  // The new client observes agents, events, and the requested timelines again.
  expect(drivers[1].driver.callsOf('observeAgents')).toHaveLength(1)
  expect(drivers[1].driver.callsOf('observeTimeline')).toEqual([[['agent-1']]])
  expect(connections).toEqual([
    `connecting@${URL_UNDER_TEST}`,
    `connected@${URL_UNDER_TEST}`,
    `disconnected@${URL_UNDER_TEST}`,
    `connecting@${other}`,
    `connected@${other}`
  ])

  // Down on the same URL: a refresh starts over instead of waiting for the client's own retries.
  drivers[1].driver.setStatus({ status: 'disconnected', reason: 'socket closed' })
  await adapter.reconnect(other)
  expect(drivers).toHaveLength(3)
  expect(adapter.connection().state).toBe('connected')
  await adapter.stop()

  const disabled = new PaseoAdapter({ url: URL_UNDER_TEST, disabled: true, createDriver: () => { throw new Error('never') } })
  await disabled.reconnect(other)
  expect(disabled.connection()).toEqual({ state: 'disabled', url: other, error: null })
})

test('overlapping reconnects run one after the other, the latest URL wins, and a slow old client never overrides the new one', async () => {
  const drivers: Array<{ url: string; driver: FakeDriver }> = []
  const adapter = new PaseoAdapter({
    url: URL_UNDER_TEST,
    createDriver: (url) => {
      const driver = new FakeDriver()
      driver.agents.set('agent-1', agentRecord('agent-1'))
      drivers.push({ url, driver })
      return driver as unknown as PaseoDaemonDriver
    }
  })
  await adapter.start()
  drivers[0].driver.closeDelayMs = 200
  const other = 'ws://127.0.0.1:17999/ws'

  await Promise.all([adapter.reconnect(other), adapter.reconnect(other)])

  expect(adapter.connection()).toEqual({ state: 'connected', url: other, error: null })
  const live = drivers.filter(({ driver }) => driver.callsOf('close').length === 0)
  expect(live.map(({ url }) => url)).toEqual([other])
  expect((await adapter.getAgent('agent-1'))?.id).toBe('agent-1')

  // Two quick saves: the second URL is where the adapter ends up.
  const third = 'ws://127.0.0.1:18000/ws'
  live[0].driver.closeDelayMs = 100
  await Promise.all([adapter.reconnect(URL_UNDER_TEST), adapter.reconnect(third)])
  expect(adapter.connection()).toEqual({ state: 'connected', url: third, error: null })
  expect(drivers.filter(({ driver }) => driver.callsOf('close').length === 0).map(({ url }) => url)).toEqual([third])
  await adapter.stop()
})

test('lists providers for a directory after discovery settles', async () => {
  const driver = new FakeDriver()
  driver.providerSnapshots = [
    [{ provider: 'claude', status: 'loading', enabled: true }],
    [
      {
        provider: 'claude',
        status: 'ready',
        enabled: true,
        label: 'Claude',
        defaultModeId: 'default',
        models: [
          { provider: 'claude', id: 'claude-haiku-4-5', label: 'Haiku', isDefault: true },
          { provider: 'claude', id: 'hidden', label: 'Hidden', isSelectable: false }
        ],
        modes: [{ id: 'default', label: 'Default', description: 'Asks first' }]
      },
      { provider: 'copilot', status: 'error', enabled: true, label: 'Copilot', error: 'not installed' },
      { provider: 'opencode', status: 'unavailable', enabled: true }
    ]
  ]
  const { adapter } = await connectedAdapter(driver)

  const providers = await adapter.listProviders('/work/project')

  expect(driver.callsOf('getProvidersSnapshot')).toEqual([[{ cwd: '/work/project' }], [{ cwd: '/work/project' }]])
  expect(providers).toEqual([
    {
      id: 'claude',
      label: 'Claude',
      available: true,
      status: 'ready',
      error: null,
      models: [{ id: 'claude-haiku-4-5', label: 'Haiku', isDefault: true }],
      modes: [{ id: 'default', label: 'Default', description: 'Asks first' }],
      defaultModeId: 'default'
    },
    { id: 'copilot', label: 'Copilot', available: false, status: 'error', error: 'not installed', models: [], modes: [], defaultModeId: null },
    { id: 'opencode', label: 'opencode', available: false, status: 'unavailable', error: null, models: [], modes: [], defaultModeId: null }
  ])
  await adapter.stop()
})

test('refuses provider reads from a daemon that cannot scope them to a directory', async () => {
  const driver = new FakeDriver()
  driver.features = {}
  const { adapter } = await connectedAdapter(driver)

  await expect(adapter.listProviders('/work/project')).rejects.toThrow('cannot report providers for a directory')
  await adapter.stop()
})

test('spawns with caller-selected settings and a durable parent identity once the provider is ready', async () => {
  const driver = new FakeDriver()
  driver.providerSnapshots = [
    [{ provider: 'claude', status: 'loading', enabled: true }],
    [{ provider: 'claude', status: 'ready', enabled: true }]
  ]
  driver.createdAgent = agentRecord('child-1', { labels: { 'paseo.parent-agent-id': 'parent-1' }, status: 'initializing' })
  const { adapter } = await connectedAdapter(driver)

  const child = await adapter.spawnAgent({
    cwd: '/work/project',
    provider: 'claude',
    model: 'claude-haiku-4-5',
    mode: 'bypassPermissions',
    prompt: 'Reply OK.',
    title: 'Helper',
    parentAgentId: 'parent-1',
    background: true
  })

  expect(driver.callsOf('getProvidersSnapshot')).toHaveLength(2)
  expect(driver.callsOf('createAgent')).toEqual([[{
    config: { provider: 'claude', cwd: '/work/project', model: 'claude-haiku-4-5', modeId: 'bypassPermissions', title: 'Helper' },
    cwd: '/work/project',
    callerAgentId: 'parent-1',
    background: true,
    initialPrompt: 'Reply OK.'
  }]])
  expect(child).toMatchObject({ id: 'child-1', parentAgentId: 'parent-1', status: 'initializing' })
  await adapter.stop()
})

test('refuses to spawn on a provider that is not ready', async () => {
  const driver = new FakeDriver()
  driver.providerSnapshots = [[{ provider: 'copilot', status: 'error', enabled: true, error: 'not installed' }]]
  const { adapter } = await connectedAdapter(driver)

  await expect(adapter.spawnAgent({ cwd: '/w', provider: 'copilot', prompt: 'x' })).rejects.toThrow('is error: not installed')
  await expect(adapter.spawnAgent({ cwd: '/w', provider: 'missing', prompt: 'x' })).rejects.toThrow('has no provider')
  expect(driver.callsOf('createAgent')).toHaveLength(0)
  await adapter.stop()
})

test('reads one agent exactly, with mode, archival, bounded permissions, and last error', async () => {
  const driver = new FakeDriver()
  driver.agents.set('agent-1', agentRecord('agent-1', {
    labels: { 'paseo.parent-agent-id': ' parent-1 ' },
    currentModeId: 'acceptEdits',
    status: 'error',
    lastError: 'Provider crashed',
    pendingPermissions: [
      { id: 'perm-1', provider: 'claude', name: 'Bash', kind: 'tool', title: 'Run a command', detail: { type: 'shell', command: 'rm -rf build' } },
      { id: 'perm-2', provider: 'claude', name: 'Write', kind: 'tool', input: { content: 'x'.repeat(AGENT_PERMISSION_DETAIL_LIMIT * 2) } }
    ]
  }))
  driver.agents.set('agent-2', agentRecord('agent-2', { status: 'idle', archivedAt: '2026-11-21T11:00:00.000Z' }))
  const { adapter } = await connectedAdapter(driver)

  const agent = await adapter.getAgent('agent-1')
  const archived = await adapter.getAgent('agent-2')

  expect(agent).toMatchObject({
    id: 'agent-1',
    parentAgentId: 'parent-1',
    workspaceId: 'workspace-1',
    title: 'Agent agent-1',
    provider: 'claude',
    model: 'claude-haiku-4-5',
    mode: 'acceptEdits',
    status: 'error',
    archivedAt: null,
    cwd: '/work/project',
    updatedAt: LONG_AGO,
    lastError: 'Provider crashed'
  })
  expect(agent!.pendingPermissions[0]).toEqual({
    id: 'perm-1',
    kind: 'tool',
    name: 'Bash',
    title: 'Run a command',
    description: null,
    detail: 'rm -rf build'
  })
  expect(agent!.pendingPermissions[1].detail!.length).toBeLessThanOrEqual(AGENT_PERMISSION_DETAIL_LIMIT)
  expect(archived).toMatchObject({ status: 'archived', archivedAt: '2026-11-21T11:00:00.000Z' })
  expect(await adapter.getAgent('missing')).toBeNull()
  await adapter.stop()
})

test('lists managed children only by their durable parent label, across pages and archival', async () => {
  const driver = new FakeDriver()
  driver.agentPages = [
    { entries: [{ agent: agentRecord('child-a', { labels: { 'paseo.parent-agent-id': 'parent-1' } }) }], nextCursor: 'page-2' },
    {
      entries: [
        { agent: agentRecord('child-b', { labels: { 'paseo.parent-agent-id': 'parent-1' }, archivedAt: LONG_AGO }) },
        { agent: agentRecord('stray', { labels: { 'paseo.parent-agent-id': 'someone-else' } }) }
      ],
      nextCursor: null
    },
    { entries: [{ agent: agentRecord('child-c', { labels: { 'paseo.parent-agent-id': 'parent-2' } }) }], nextCursor: null }
  ]
  const { adapter } = await connectedAdapter(driver)

  const children = await adapter.listChildAgents(['parent-1', 'parent-2', 'parent-1'])

  expect(children.map(({ id, parentAgentId, status }) => [id, parentAgentId, status])).toEqual([
    ['child-a', 'parent-1', 'idle'],
    ['child-b', 'parent-1', 'archived'],
    ['child-c', 'parent-2', 'idle']
  ])
  expect(driver.callsOf('fetchAgents')).toEqual([
    [{ filter: { labels: { 'paseo.parent-agent-id': 'parent-1' }, includeArchived: true, includeBackground: true }, page: { limit: 200 } }],
    [{ filter: { labels: { 'paseo.parent-agent-id': 'parent-1' }, includeArchived: true, includeBackground: true }, page: { limit: 200, cursor: 'page-2' } }],
    [{ filter: { labels: { 'paseo.parent-agent-id': 'parent-2' }, includeArchived: true, includeBackground: true }, page: { limit: 200 } }]
  ])
  await adapter.stop()
})

test('prompts, interrupts, changes the mode, answers permissions, and archives through the daemon', async () => {
  const { adapter, driver } = await connectedAdapter()

  await adapter.sendPrompt('agent-1', 'Continue.')
  await adapter.interrupt('agent-1')
  await adapter.setAgentMode('agent-1', 'acceptEdits')
  await adapter.respondToPermission('agent-1', 'perm-1', 'allow')
  await adapter.respondToPermission('agent-1', 'perm-2', 'deny')
  const archivedAt = await adapter.archiveAgent('agent-1')

  expect(driver.callsOf('sendAgentMessage')).toEqual([['agent-1', 'Continue.']])
  expect(driver.callsOf('cancelAgent')).toEqual([['agent-1']])
  expect(driver.callsOf('setAgentMode')).toEqual([['agent-1', 'acceptEdits']])
  expect(driver.callsOf('respondToPermission')).toEqual([
    ['agent-1', 'perm-1', { behavior: 'allow' }],
    ['agent-1', 'perm-2', { behavior: 'deny', message: 'Denied in SPADE.' }]
  ])
  expect(archivedAt).toBe('2026-11-21T11:00:00.000Z')
  await adapter.stop()
})

test.describe('agent timelines', () => {
  test('reads the newest bounded page and pages back with an opaque cursor', async () => {
    const driver = new FakeDriver()
    driver.timelineResponses = [
      timelinePayload(),
      timelinePayload({ direction: 'before', entries: [timelineEntry(12, 'oldest')], hasOlder: false, startCursor: { epoch: 'epoch-1', seq: 12 } })
    ]
    const { adapter } = await connectedAdapter(driver)

    const newest = await adapter.agentTimeline('agent-1')
    const older = await adapter.agentTimeline('agent-1', { before: newest.olderCursor!, limit: 500 })

    expect(newest.epoch).toBe('epoch-1')
    expect(newest.items.map((item) => [item.id, item.kind])).toEqual([['epoch-1:20', 'assistant-message'], ['epoch-1:25', 'assistant-message']])
    expect(newest.olderCursor).not.toBeNull()
    expect(older.items.map(({ id }) => id)).toEqual(['epoch-1:12'])
    expect(older.olderCursor).toBeNull()
    expect(driver.callsOf('fetchAgentTimeline')).toEqual([
      ['agent-1', { projection: 'projected', limit: AGENT_TIMELINE_PAGE_LIMIT, direction: 'tail' }],
      ['agent-1', { projection: 'projected', limit: AGENT_TIMELINE_PAGE_LIMIT, direction: 'before', cursor: { epoch: 'epoch-1', seq: 20 } }]
    ])
    await adapter.stop()
  })

  test('trims a projected page that overshoots the limit and keeps a cursor to what was trimmed', async () => {
    const driver = new FakeDriver()
    driver.timelineResponses = [
      timelinePayload({ hasOlder: false, entries: [timelineEntry(5, 'a'), timelineEntry(6, 'b'), timelineEntry(7, 'c')] })
    ]
    const { adapter } = await connectedAdapter(driver)

    const page = await adapter.agentTimeline('agent-1', { limit: 2 })

    expect(page.items.map(({ id }) => id)).toEqual(['epoch-1:6', 'epoch-1:7'])
    expect(page.olderCursor).not.toBeNull()
    const [, options] = driver.callsOf('fetchAgentTimeline')[0] as [string, { limit: number }]
    expect(options.limit).toBe(2)
    await adapter.stop()
  })

  test('answers a cursor from an earlier epoch with the newest page of the current one', async () => {
    const driver = new FakeDriver()
    // What a 0.17 daemon returns for a cursor whose epoch it no longer has.
    driver.timelineResponses = [
      timelinePayload({ direction: 'before', epoch: 'epoch-2', reset: true, staleCursor: true, entries: [timelineEntry(3, 'after restart')] })
    ]
    const { adapter } = await connectedAdapter(driver)

    const page = await adapter.agentTimeline('agent-1', { before: '20@epoch-1' })

    expect(page.epoch).toBe('epoch-2')
    expect(page.items.map(({ id }) => id)).toEqual(['epoch-2:3'])
    await adapter.stop()
  })

  test('falls back to the newest page when a cursor is malformed or rejected', async () => {
    const driver = new FakeDriver()
    driver.timelineResponses = [
      timelinePayload({ entries: [timelineEntry(1, 'x')] }),
      timelinePayload({ error: 'cursor rejected', entries: [] }),
      timelinePayload({ entries: [timelineEntry(2, 'y')] })
    ]
    const { adapter } = await connectedAdapter(driver)

    await adapter.agentTimeline('agent-1', { before: 'garbage' })
    const recovered = await adapter.agentTimeline('agent-1', { before: '4@epoch-1' })

    expect(driver.callsOf('fetchAgentTimeline').map(([, options]) => (options as { direction: string }).direction))
      .toEqual(['tail', 'before', 'tail'])
    expect(recovered.items.map(({ id }) => id)).toEqual(['epoch-1:2'])
    await adapter.stop()
  })

  test('surfaces a timeline read error for the newest page', async () => {
    const driver = new FakeDriver()
    driver.timelineResponses = [timelinePayload({ error: 'Agent not found: agent-1', entries: [] })]
    const { adapter } = await connectedAdapter(driver)

    await expect(adapter.agentTimeline('agent-1')).rejects.toThrow('Agent not found')
    await adapter.stop()
  })
})

test.describe('provider-native sub-agents', () => {
  test('lists observable sub-agents and reports unobservable parents distinctly from none', async () => {
    const driver = new FakeDriver()
    const { adapter } = await connectedAdapter(driver)

    driver.subagentList = async () => ({
      requestId: 'r',
      parentAgentId: 'parent-1',
      error: null,
      subagents: [{
        id: 'toolu_1',
        parentAgentId: 'parent-1',
        parentSubagentId: null,
        provider: 'claude',
        title: 'general-purpose',
        description: 'Summarize the docs',
        status: 'completed',
        createdAt: LONG_AGO,
        updatedAt: LONG_AGO,
        toolCallId: 'toolu_1',
        cwd: null
      }]
    })
    expect(await adapter.listProviderSubagents('parent-1')).toEqual({
      observable: true,
      subagents: [{ id: 'toolu_1', parentSubagentId: null, title: 'general-purpose', description: 'Summarize the docs', status: 'completed', updatedAt: LONG_AGO }]
    })

    driver.subagentList = async () => ({ requestId: 'r', parentAgentId: 'parent-1', subagents: [], error: null })
    expect(await adapter.listProviderSubagents('parent-1')).toEqual({ observable: true, subagents: [] })

    driver.subagentList = async () => { throw new Error('Agent is archived: parent-1') }
    expect(await adapter.listProviderSubagents('parent-1')).toEqual({ observable: false, reason: 'Agent is archived: parent-1' })

    driver.subagentList = async () => ({ requestId: 'r', parentAgentId: 'parent-1', subagents: [], error: 'Provider has no sub-agent support' })
    expect(await adapter.listProviderSubagents('parent-1')).toEqual({ observable: false, reason: 'Provider has no sub-agent support' })

    driver.subagentList = async () => { throw new DaemonConnectionError('Connection lost') }
    await expect(adapter.listProviderSubagents('parent-1')).rejects.toBeInstanceOf(DaemonConnectionError)
    await adapter.stop()
  })

  test('reads a sub-agent timeline page', async () => {
    const driver = new FakeDriver()
    driver.subagentTimelineResponses = [{
      requestId: 'r',
      parentAgentId: 'parent-1',
      subagentId: 'toolu_1',
      provider: 'claude',
      direction: 'tail',
      epoch: 'sub-epoch',
      projection: 'projected',
      startCursor: { epoch: 'sub-epoch', seq: 36 },
      endCursor: { epoch: 'sub-epoch', seq: 38 },
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 1, maxSeq: 38, nextSeq: 39 },
      hasOlder: true,
      hasNewer: false,
      rows: [
        { item: { type: 'reasoning', text: 'thinking' }, timestamp: LONG_AGO, seq: 38, seqStart: 38, seqEnd: 38 },
        { item: { type: 'tool_call', callId: 'c', name: 'Read', status: 'completed', error: null, detail: { type: 'read', filePath: '/w/a.ts' } }, timestamp: LONG_AGO, seq: 37, seqStart: 36, seqEnd: 37 }
      ],
      error: null
    }]
    const { adapter } = await connectedAdapter(driver)

    const page = await adapter.providerSubagentTimeline('parent-1', 'toolu_1', { limit: 10 })

    expect(page.epoch).toBe('sub-epoch')
    expect(page.items.map((item) => [item.id, item.kind])).toEqual([['sub-epoch:36', 'tool-call'], ['sub-epoch:38', 'thinking']])
    expect(page.olderCursor).not.toBeNull()
    expect(driver.callsOf('fetchProviderSubagentTimeline')).toEqual([['parent-1', 'toolu_1', { limit: 10, direction: 'tail' }]])
    await adapter.stop()
  })
})

test('reports which agent changed and how', async () => {
  const { adapter, driver, events } = await connectedAdapter()
  const changes = () => events.filter(({ type }) => type !== 'connection')

  driver.deliver('agent_update', { kind: 'upsert', agent: agentRecord('old-agent') })
  driver.deliver('agent_update', { kind: 'upsert', agent: agentRecord('new-agent', { createdAt: new Date(Date.now() + 1000).toISOString(), labels: { 'paseo.parent-agent-id': 'old-agent' } }) })
  driver.deliver('agent_update', { kind: 'upsert', agent: agentRecord('new-agent', { createdAt: new Date(Date.now() + 1000).toISOString(), status: 'running' }) })
  driver.deliver('agent_update', { kind: 'remove', agentId: 'old-agent' })
  driver.deliver('agent_stream', { agentId: 'old-agent', event: { type: 'timeline', provider: 'claude', item: { type: 'reasoning', text: 'x' } }, timestamp: LONG_AGO, seq: 4, epoch: 'e' })
  driver.deliver('agent_stream', { agentId: 'old-agent', event: { type: 'turn_started', provider: 'claude' }, timestamp: LONG_AGO })
  driver.deliver('agent.timeline.replacement', { agentId: 'old-agent', epoch: 'e2' })
  driver.deliver('agent_permission_request', { agentId: 'old-agent', request: { id: 'p', provider: 'claude', name: 'Bash', kind: 'tool' } })
  driver.deliver('agent_permission_resolved', { agentId: 'old-agent', requestId: 'p', resolution: { behavior: 'allow' } })
  driver.deliver('agent.provider_subagents.update', { kind: 'upsert', subagent: { id: 'sub-1', parentAgentId: 'old-agent' } })
  driver.deliver('agent.provider_subagents.update', { kind: 'timeline', parentAgentId: 'old-agent', subagentId: 'sub-1' })
  driver.deliver('agent.provider_subagents.update', { kind: 'remove', parentAgentId: 'old-agent', subagentId: 'sub-1' })

  expect(changes().map((event) => {
    if (event.type === 'agent-updated') return [event.type, event.agentId, event.created, event.agent.parentAgentId, event.agent.status]
    return [event.type, ...Object.values(event).slice(1)]
  })).toEqual([
    ['agent-updated', 'old-agent', false, null, 'idle'],
    ['agent-updated', 'new-agent', true, 'old-agent', 'idle'],
    ['agent-updated', 'new-agent', false, null, 'running'],
    ['agent-removed', 'old-agent'],
    ['timeline', 'old-agent', false],
    ['timeline', 'old-agent', true],
    ['permissions', 'old-agent'],
    ['permissions', 'old-agent'],
    ['provider-subagents', 'old-agent', 'sub-1'],
    ['provider-subagent-timeline', 'old-agent', 'sub-1'],
    ['provider-subagents', 'old-agent', 'sub-1']
  ])

  await adapter.stop()
  driver.deliver('agent_update', { kind: 'remove', agentId: 'new-agent' })
  expect(changes()).toHaveLength(11)
})

test('observes exactly the requested timelines and replaces the set when it changes', async () => {
  const driver = new FakeDriver()
  driver.autoConnect = false
  const adapter = new PaseoAdapter({ url: URL_UNDER_TEST, createDriver: () => driver as unknown as PaseoDaemonDriver })
  const started = adapter.start()
  await adapter.watchTimelines(['b', 'a', 'a'])
  expect(driver.callsOf('observeTimeline')).toHaveLength(0)

  driver.setStatus({ status: 'connected' })
  await started
  await adapter.watchTimelines(['a', 'b'])
  await adapter.watchTimelines(['c'])
  await adapter.watchTimelines([])

  expect(driver.callsOf('observeTimeline')).toEqual([[['a', 'b']], [['c']]])
  expect(driver.released).toEqual([['observeTimeline', ['a', 'b']], ['observeTimeline', ['c']]])
  await adapter.stop()
})

test('reads agent activity from Paseo status and pending permissions', () => {
  const cases: Array<[string, number, string]> = [
    ['initializing', 0, 'starting'],
    ['running', 0, 'running'],
    ['running', 1, 'attention'],
    ['idle', 0, 'idle'],
    ['idle', 2, 'attention'],
    ['error', 0, 'error'],
    ['closed', 0, 'closed'],
    ['archived', 1, 'closed'],
    ['something-new', 0, 'unknown']
  ]
  for (const [status, pending, activity] of cases) expect([status, pending, agentActivity(status, pending)]).toEqual([status, pending, activity])
})
