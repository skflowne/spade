// The single boundary between SPADE and Paseo. The confined internal DaemonClient import is allowed
// only in this directory: the public facade cannot share one connection across agents, timelines,
// provider sub-agents, and event observations.
import {
  DaemonClient,
  DaemonConnectionError,
  type ConnectionState,
  type DaemonClientConfig
} from '@getpaseo/client/internal/daemon-client'
import {
  AGENT_TIMELINE_PAGE_LIMIT,
  type AgentProviderInfo,
  type AgentTimelinePage,
  type AgentTimelineQuery,
  type PaseoConnection,
  type PaseoConnectionState,
  type PermissionBehavior,
  type ProviderSubagentInfo
} from '../../shared/agents'
import { normalizeTimeline, type PaseoTimelineRow } from './normalizeTimeline'
import {
  PARENT_AGENT_ID_LABEL,
  toAgentSnapshot,
  toProviderInfo,
  toSubagentInfo,
  type PaseoAgentSnapshot
} from './snapshots'

type DriverMethod =
  | 'connect'
  | 'close'
  | 'subscribeConnectionStatus'
  | 'on'
  | 'getLastServerInfoMessage'
  | 'observeAgents'
  | 'observeEvents'
  | 'observeTimeline'
  | 'fetchAgent'
  | 'fetchAgents'
  | 'createAgent'
  | 'sendAgentMessage'
  | 'cancelAgent'
  | 'setAgentMode'
  | 'archiveAgent'
  | 'respondToPermission'
  | 'fetchAgentTimeline'
  | 'listProviderSubagents'
  | 'fetchProviderSubagentTimeline'
  | 'getProvidersSnapshot'

export type PaseoDaemonDriver = Pick<DaemonClient, DriverMethod>

export type PaseoAdapterOptions = {
  url: string
  // Never opens a socket; every daemon operation rejects with PaseoUnavailableError.
  disabled?: boolean
  createDriver?: (url: string) => PaseoDaemonDriver
  providerDiscoveryTimeoutMs?: number
  providerDiscoveryPollMs?: number
}

export type SpawnAgentInput = {
  cwd: string
  provider: string
  model?: string
  mode?: string
  prompt: string
  title?: string
  // Durable parent identity. Paseo then places the child in the parent's workspace and cwd.
  parentAgentId?: string
  // Hides the agent (and a workspace this spawn creates) from Paseo's default listings.
  background?: boolean
}

export type PaseoTimelinePage = Omit<AgentTimelinePage, 'nodeId'>

export type ProviderSubagentListing =
  | { observable: true; subagents: ProviderSubagentInfo[] }
  // Paseo could not read the parent's provider sub-agents (archived parent, provider error);
  // previously listed rows are unknown, not gone.
  | { observable: false; reason: string }

export type PaseoAdapterEvent =
  | { type: 'connection'; connection: PaseoConnection }
  // `created` marks an agent first seen by this adapter and created after it started.
  | { type: 'agent-updated'; agentId: string; agent: PaseoAgentSnapshot; created: boolean }
  | { type: 'agent-removed'; agentId: string }
  // Only for agents passed to `watchTimelines`. `reset` means earlier items and cursors are void.
  | { type: 'timeline'; agentId: string; reset: boolean }
  | { type: 'permissions'; agentId: string }
  | { type: 'provider-subagents'; parentAgentId: string; subagentId: string }
  | { type: 'provider-subagent-timeline'; parentAgentId: string; subagentId: string }

export class PaseoUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PaseoUnavailableError'
  }
}

// Daemons hide non-legacy providers from sessions whose appVersion does not parse as semver.
export const PASEO_CLIENT_APP_VERSION = '0.17.0'
const CLIENT_ID = 'spade-desktop'
const LIST_PAGE_LIMIT = 200
const DENY_MESSAGE = 'Denied in SPADE.'
const OBSERVED_EVENTS = [
  'agent_permission_request',
  'agent_permission_resolved',
  'agent.provider_subagents.update'
] as const

export function daemonClientOptions(url: string): DaemonClientConfig {
  return {
    url,
    clientId: CLIENT_ID,
    clientType: 'cli',
    appVersion: PASEO_CLIENT_APP_VERSION,
    reconnect: { enabled: true }
  }
}

type Observation = { ready: Promise<unknown>; release(): Promise<void> }
type ProviderEntries = Awaited<ReturnType<PaseoDaemonDriver['getProvidersSnapshot']>>['entries']

export class PaseoAdapter {
  private currentUrl: string
  private readonly disabled: boolean
  private readonly createDriver: (url: string) => PaseoDaemonDriver
  private readonly providerDiscoveryTimeoutMs: number
  private readonly providerDiscoveryPollMs: number
  private readonly listeners = new Set<(event: PaseoAdapterEvent) => void>()
  private driver: PaseoDaemonDriver | null = null
  private current: PaseoConnection
  private everConnected = false
  private startedAt = 0
  private settleStart: (() => void) | null = null
  private detachDriver: Array<() => void> = []
  private observations: Observation[] = []
  private timeline: { ids: string[]; observation: Observation | null } = { ids: [], observation: null }
  private requestedTimelineIds: string[] = []
  private timelineQueue: Promise<void> = Promise.resolve()
  private readonly seenAgentIds = new Set<string>()

  constructor(options: PaseoAdapterOptions) {
    this.currentUrl = options.url
    this.disabled = options.disabled ?? false
    this.createDriver = options.createDriver ?? ((url) => new DaemonClient(daemonClientOptions(url)))
    this.providerDiscoveryTimeoutMs = options.providerDiscoveryTimeoutMs ?? 30_000
    this.providerDiscoveryPollMs = options.providerDiscoveryPollMs ?? 250
    this.current = { state: this.disabled ? 'disabled' : 'disconnected', url: this.url, error: null }
  }

  get url(): string {
    return this.currentUrl
  }

  connection(): PaseoConnection {
    return this.current
  }

  subscribe(listener: (event: PaseoAdapterEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // Resolves once connected and observing, or after the first failed attempt; the client keeps
  // reconnecting in the background and `connection()` tells which.
  async start(): Promise<void> {
    if (this.disabled || this.driver) return
    const driver = this.createDriver(this.url)
    this.driver = driver
    this.startedAt = Date.now()
    this.everConnected = false
    const settled = new Promise<void>((resolve) => { this.settleStart = resolve })
    this.detachDriver = [
      driver.subscribeConnectionStatus((status) => this.onConnectionStatus(driver, status)),
      driver.on('agent_update', ({ payload }) => {
        if (payload.kind === 'remove') {
          this.seenAgentIds.delete(payload.agentId)
          this.emit({ type: 'agent-removed', agentId: payload.agentId })
          return
        }
        const agent = toAgentSnapshot(payload.agent)
        // Compares daemon and local clocks; both are this machine for the local daemon.
        const created = !this.seenAgentIds.has(agent.id) && Date.parse(agent.createdAt) >= this.startedAt
        this.seenAgentIds.add(agent.id)
        this.emit({ type: 'agent-updated', agentId: agent.id, agent, created })
      }),
      driver.on('agent_stream', ({ payload }) => {
        if (payload.event.type === 'timeline') this.emit({ type: 'timeline', agentId: payload.agentId, reset: false })
      }),
      driver.on('agent.timeline.replacement', ({ payload }) => {
        this.emit({ type: 'timeline', agentId: payload.agentId, reset: true })
      }),
      driver.on('agent_permission_request', ({ payload }) => this.emit({ type: 'permissions', agentId: payload.agentId })),
      driver.on('agent_permission_resolved', ({ payload }) => this.emit({ type: 'permissions', agentId: payload.agentId })),
      driver.on('agent.provider_subagents.update', ({ payload }) => {
        if (payload.kind === 'upsert') {
          this.emit({
            type: 'provider-subagents',
            parentAgentId: payload.subagent.parentAgentId,
            subagentId: payload.subagent.id
          })
        } else {
          this.emit({
            type: payload.kind === 'timeline' ? 'provider-subagent-timeline' : 'provider-subagents',
            parentAgentId: payload.parentAgentId,
            subagentId: payload.subagentId
          })
        }
      })
    ]
    this.setConnection('connecting', null)
    // With reconnect enabled the client resolves this only once connected; failures surface as status.
    driver.connect().catch((error: unknown) => {
      if (this.driver !== driver) return
      this.setConnection(this.everConnected ? 'reconnecting' : 'connecting', errorMessage(error))
      this.finishStart()
    })
    await settled
  }

  async stop(): Promise<void> {
    const driver = this.driver
    if (!driver) return
    this.driver = null
    for (const detach of this.detachDriver) detach()
    this.detachDriver = []
    const observations = [...this.observations, ...(this.timeline.observation ? [this.timeline.observation] : [])]
    this.observations = []
    this.timeline = { ids: [], observation: null }
    this.seenAgentIds.clear()
    this.finishStart()
    await Promise.allSettled(observations.map((observation) => observation.release()))
    await driver.close()
    this.setConnection('disconnected', null)
  }

  // Points the adapter at `url`. A different URL, or a connection that is not up, closes the client and
  // starts a new one; a connected adapter already on `url` is left alone. Resolves like `start`.
  async reconnect(url: string): Promise<void> {
    if (this.disabled) {
      this.currentUrl = url
      this.current = { ...this.current, url }
      this.emit({ type: 'connection', connection: this.current })
      return
    }
    if (url === this.currentUrl && this.driver && this.current.state === 'connected') return
    await this.stop()
    this.currentUrl = url
    await this.start()
  }

  // Resolves when connected; rejects with PaseoUnavailableError when disabled or after the timeout.
  ready(timeoutMs = 15_000): Promise<void> {
    if (this.current.state === 'connected') return Promise.resolve()
    if (this.disabled) return Promise.reject(new PaseoUnavailableError('Paseo is disabled.'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe()
        reject(new PaseoUnavailableError(`Paseo did not connect within ${timeoutMs} ms: ${this.current.error ?? this.current.state}`))
      }, timeoutMs)
      const unsubscribe = this.subscribe((event) => {
        if (event.type !== 'connection' || event.connection.state !== 'connected') return
        clearTimeout(timer)
        unsubscribe()
        resolve()
      })
    })
  }

  // Sets the agents whose timeline growth is reported as `timeline` events; replaces the previous set.
  watchTimelines(agentIds: readonly string[]): Promise<void> {
    this.requestedTimelineIds = [...new Set(agentIds)].sort()
    if (this.current.state !== 'connected') return Promise.resolve()
    return this.applyTimelineWatch()
  }

  async listProviders(cwd: string): Promise<AgentProviderInfo[]> {
    const entries = await this.discoverProviders(cwd, (snapshot) => snapshot.every(({ status }) => status !== 'loading'))
    return entries.map(toProviderInfo)
  }

  async spawnAgent(input: SpawnAgentInput): Promise<PaseoAgentSnapshot> {
    const entries = await this.discoverProviders(input.cwd, (snapshot) =>
      snapshot.some(({ provider, status }) => provider === input.provider && status !== 'loading'))
    const entry = entries.find(({ provider }) => provider === input.provider)
    if (!entry) throw new Error(`Paseo has no provider “${input.provider}”.`)
    if (entry.status === 'loading') throw new Error(`Timed out waiting for Paseo to discover provider “${input.provider}”.`)
    if (entry.status !== 'ready' || !entry.enabled) {
      throw new Error(`Paseo provider “${input.provider}” is ${entry.enabled ? entry.status : 'disabled'}${entry.error ? `: ${entry.error}` : '.'}`)
    }
    const created = await this.requireDriver().createAgent({
      config: {
        provider: input.provider,
        cwd: input.cwd,
        ...(input.model ? { model: input.model } : {}),
        ...(input.mode ? { modeId: input.mode } : {}),
        ...(input.title ? { title: input.title } : {})
      },
      cwd: input.cwd,
      ...(input.parentAgentId ? { callerAgentId: input.parentAgentId } : {}),
      ...(input.background !== undefined ? { background: input.background } : {}),
      initialPrompt: input.prompt
    })
    return toAgentSnapshot(created)
  }

  async getAgent(agentId: string): Promise<PaseoAgentSnapshot | null> {
    const result = await this.requireDriver().fetchAgent(agentId)
    return result ? toAgentSnapshot(result.agent) : null
  }

  // Managed agents whose durable parent label names one of `parentAgentIds`, archived ones included.
  async listChildAgents(parentAgentIds: readonly string[]): Promise<PaseoAgentSnapshot[]> {
    const driver = this.requireDriver()
    const children = new Map<string, PaseoAgentSnapshot>()
    for (const parentAgentId of new Set(parentAgentIds)) {
      let cursor: string | undefined
      do {
        const page = await driver.fetchAgents({
          filter: { labels: { [PARENT_AGENT_ID_LABEL]: parentAgentId }, includeArchived: true, includeBackground: true },
          page: { limit: LIST_PAGE_LIMIT, ...(cursor ? { cursor } : {}) }
        })
        for (const { agent } of page.entries) {
          const snapshot = toAgentSnapshot(agent)
          if (snapshot.parentAgentId === parentAgentId) children.set(snapshot.id, snapshot)
        }
        cursor = page.pageInfo.nextCursor ?? undefined
      } while (cursor)
    }
    return [...children.values()]
  }

  async sendPrompt(agentId: string, text: string): Promise<void> {
    await this.requireDriver().sendAgentMessage(agentId, text)
  }

  async interrupt(agentId: string): Promise<void> {
    await this.requireDriver().cancelAgent(agentId)
  }

  // Mode ids are the provider's own, as `listProviders` reports them.
  async setAgentMode(agentId: string, modeId: string): Promise<void> {
    await this.requireDriver().setAgentMode(agentId, modeId)
  }

  // Returns Paseo's archival timestamp.
  async archiveAgent(agentId: string): Promise<string> {
    return (await this.requireDriver().archiveAgent(agentId)).archivedAt
  }

  async respondToPermission(agentId: string, requestId: string, behavior: PermissionBehavior): Promise<void> {
    await this.requireDriver().respondToPermission(
      agentId,
      requestId,
      behavior === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: DENY_MESSAGE }
    )
  }

  async agentTimeline(agentId: string, query: AgentTimelineQuery = {}): Promise<PaseoTimelinePage> {
    const driver = this.requireDriver()
    const limit = pageLimit(query.limit)
    const cursor = decodeCursor(query.before)
    // A cursor from another epoch makes the daemon answer with the newest page and `reset: true`.
    let page = await driver.fetchAgentTimeline(agentId, {
      projection: 'projected',
      limit,
      ...(cursor ? { direction: 'before', cursor } : { direction: 'tail' })
    })
    if (page.error && cursor) page = await driver.fetchAgentTimeline(agentId, { projection: 'projected', limit, direction: 'tail' })
    if (page.error) throw new Error(`Paseo timeline ${agentId}: ${page.error}`)
    return toTimelinePage(page.entries, page.epoch, page.hasOlder, limit)
  }

  async listProviderSubagents(parentAgentId: string): Promise<ProviderSubagentListing> {
    const driver = this.requireDriver()
    try {
      const listed = await driver.listProviderSubagents(parentAgentId)
      if (listed.error) return { observable: false, reason: listed.error }
      return { observable: true, subagents: listed.subagents.map(toSubagentInfo) }
    } catch (error) {
      if (error instanceof DaemonConnectionError) throw error
      return { observable: false, reason: errorMessage(error) }
    }
  }

  async providerSubagentTimeline(
    parentAgentId: string,
    subagentId: string,
    query: AgentTimelineQuery = {}
  ): Promise<PaseoTimelinePage> {
    const driver = this.requireDriver()
    const limit = pageLimit(query.limit)
    const cursor = decodeCursor(query.before)
    let page = await driver.fetchProviderSubagentTimeline(parentAgentId, subagentId, {
      limit,
      ...(cursor ? { direction: 'before', cursor } : { direction: 'tail' })
    })
    if (page.error && cursor) page = await driver.fetchProviderSubagentTimeline(parentAgentId, subagentId, { limit, direction: 'tail' })
    if (page.error) throw new Error(`Paseo sub-agent timeline ${subagentId}: ${page.error}`)
    const rows = page.rows.map((row) => ({ ...row, seqStart: row.seqStart ?? row.seq }))
    return toTimelinePage(rows, page.epoch, page.hasOlder, limit)
  }

  private onConnectionStatus(driver: PaseoDaemonDriver, status: ConnectionState): void {
    if (this.driver !== driver) return
    switch (status.status) {
      case 'connected':
        void this.onConnected(driver)
        return
      case 'connecting':
        this.setConnection(this.everConnected ? 'reconnecting' : 'connecting', this.current.error)
        return
      case 'disconnected':
        this.setConnection(this.everConnected ? 'reconnecting' : 'connecting', status.reason ?? 'Disconnected from Paseo.')
        this.finishStart()
        return
      default:
        return
    }
  }

  private async onConnected(driver: PaseoDaemonDriver): Promise<void> {
    try {
      // Owned observations survive reconnects; the daemon only sends agent updates and session
      // events while one is open. Background agents (spawned by other agents) need the opt-in.
      if (this.observations.length === 0) {
        this.observations = [
          driver.observeAgents({ filter: { includeArchived: true, includeBackground: true }, page: { limit: 1 } }),
          driver.observeEvents([...OBSERVED_EVENTS])
        ]
        await Promise.all(this.observations.map(({ ready }) => ready))
      }
      if (this.driver !== driver) return
      this.everConnected = true
      this.setConnection('connected', null)
      await this.applyTimelineWatch()
    } catch (error) {
      if (this.driver !== driver) return
      const failed = this.observations
      this.observations = []
      await Promise.allSettled(failed.map((observation) => observation.release()))
      this.setConnection(this.everConnected ? 'reconnecting' : 'connecting', errorMessage(error))
    } finally {
      this.finishStart()
    }
  }

  private applyTimelineWatch(): Promise<void> {
    const run = this.timelineQueue.then(async () => {
      const driver = this.driver
      const ids = this.requestedTimelineIds
      if (!driver || sameIds(ids, this.timeline.ids)) return
      const previous = this.timeline.observation
      const next = ids.length > 0 ? driver.observeTimeline([...ids]) : null
      this.timeline = { ids, observation: next }
      try {
        await next?.ready
      } catch (error) {
        this.timeline = { ids: [], observation: null }
        await next?.release().catch(() => undefined)
        throw error
      } finally {
        await previous?.release().catch(() => undefined)
      }
    })
    this.timelineQueue = run.catch(() => undefined)
    return run
  }

  private async discoverProviders(cwd: string, settled: (entries: ProviderEntries) => boolean): Promise<ProviderEntries> {
    const driver = this.requireDriver()
    // Without per-cwd snapshots the daemon would answer for a different directory.
    if (driver.getLastServerInfoMessage()?.features?.providersSnapshotCwd !== true) {
      throw new Error('Update the Paseo daemon: it cannot report providers for a directory.')
    }
    const deadline = Date.now() + this.providerDiscoveryTimeoutMs
    for (;;) {
      const { entries } = await driver.getProvidersSnapshot({ cwd })
      if (settled(entries) || Date.now() >= deadline) return entries
      await new Promise((resolve) => setTimeout(resolve, this.providerDiscoveryPollMs))
    }
  }

  private requireDriver(): PaseoDaemonDriver {
    if (this.disabled) throw new PaseoUnavailableError('Paseo is disabled.')
    if (!this.driver || this.current.state !== 'connected') {
      throw new PaseoUnavailableError(`Paseo is not connected (${this.current.state}${this.current.error ? `: ${this.current.error}` : ''}).`)
    }
    return this.driver
  }

  private setConnection(state: PaseoConnectionState, error: string | null): void {
    if (this.current.state === state && this.current.error === error) return
    this.current = { state, url: this.url, error }
    this.emit({ type: 'connection', connection: this.current })
  }

  private finishStart(): void {
    this.settleStart?.()
    this.settleStart = null
  }

  private emit(event: PaseoAdapterEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }
}

type TimelineEntry = { item: unknown; timestamp: string; seqStart: number; seqEnd?: number }

// Keeps the newest `limit` rows; the daemon's projection can return a few more than asked.
function toTimelinePage(
  entries: readonly TimelineEntry[],
  epoch: string,
  hasOlder: boolean,
  limit: number
): PaseoTimelinePage {
  const rows: PaseoTimelineRow[] = [...entries].sort((left, right) => left.seqStart - right.seqStart)
  const kept = rows.slice(-limit)
  const oldest = kept[0]?.seqStart
  const olderCursor = (hasOlder || kept.length < rows.length) && oldest !== undefined && epoch
    ? encodeCursor(epoch, oldest)
    : null
  return { epoch: epoch || null, items: normalizeTimeline(kept, epoch || null), olderCursor }
}

function encodeCursor(epoch: string, seq: number): string {
  return `${seq}@${epoch}`
}

function decodeCursor(value: string | undefined): { epoch: string; seq: number } | null {
  const match = value ? /^(\d+)@(.+)$/.exec(value) : null
  return match ? { epoch: match[2], seq: Number(match[1]) } : null
}

function pageLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return AGENT_TIMELINE_PAGE_LIMIT
  return Math.min(AGENT_TIMELINE_PAGE_LIMIT, Math.max(1, Math.floor(requested)))
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
