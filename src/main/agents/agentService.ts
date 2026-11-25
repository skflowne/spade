import { homedir } from 'node:os'
import type {
  AgentLocation,
  AgentService,
  AgentServiceEvent,
  EntityCreateInput,
  EntityCreateResult,
  MainEntityAdapter,
  WorkspaceGateway,
  WorkspaceGatewayEvent
} from '../contracts'
import { resolvePaseoUrl, type PaseoAdapterEvent, type PaseoAgentSnapshot } from '../paseo'
import { buildAgentContext, formatAgentContext } from '../../shared/agentContext'
import type {
  AgentProviderInfo,
  AgentResourceState,
  AgentRuntime,
  AgentTimelinePage,
  AgentTimelineQuery,
  ChildAgentInfo,
  PaseoConnection,
  PermissionBehavior,
  ProviderSubagentInfo
} from '../../shared/agents'
import { AGENT_ENTITY, PASEO_AGENT_KIND, agentEntity, type AgentConfig } from '../../shared/builtinEntities'
import { CanvasCommandError } from '../../shared/commands'
import type { Actor, Canvas, CanvasNode, Project } from '../../shared/domain'
import type { EntityRegistry } from '../../shared/entities'
import { isSamePath } from '../../shared/paths'
import {
  agentConfigOf,
  agentResourceRef,
  agentRuntimeOf,
  agentTargetOf,
  childAgentInfoOf,
  clipText,
  hasAutomaticTitle,
  paseoTitle,
  promptTitle,
  providerSubagentResourceRef,
  providerSubagentRuntimeOf,
  runtimeSummary,
  sameRuntime,
  type AgentNodeTarget
} from './agentNodes'
import { AgentServiceError } from './errors'
import { callPaseo, type PaseoPort } from './paseoPort'

export type AgentInstructions = (input: { nodeId: string; project: Project }) => string | null

export type AgentServiceTiming = {
  // How long bursts of Paseo and canvas events are gathered before reconciliation reacts.
  coalesceMs: number
  // At most one `timeline` event per node per window.
  timelineDebounceMs: number
  providerCacheMs: number
}

export type AgentServiceOptions = {
  gateway: WorkspaceGateway
  paseo: PaseoPort
  entities: EntityRegistry
  // Appended to the initial prompt of an agent the user creates, after a blank line; never stored in the
  // node's config.
  agentInstructions?: AgentInstructions
  // The daemon URL for the saved setting; defaults to `resolvePaseoUrl` over SPADE's environment.
  resolvePaseoUrl?: (setting: string | null) => string
  now?: () => Date
  timing?: Partial<AgentServiceTiming>
}

export type SpadeAgentService = AgentService & {
  // Resolves once every event received so far has been reconciled and written. For tests and scripts.
  whenIdle(): Promise<void>
  // Every Paseo agent the service follows, sorted. For tests and scripts.
  followedAgentIds(): string[]
}

const DEFAULT_TIMING: AgentServiceTiming = {
  coalesceMs: 50,
  timelineDebounceMs: 150,
  providerCacheMs: 30_000
}

const SYSTEM: Actor = { kind: 'system' }
const READ_CONCURRENCY = 8
const SUBAGENT_TITLE_LIMIT = 80
// Bounds every walk up Paseo's parent chain, which the daemon does not promise to be acyclic.
const OWNERSHIP_DEPTH_LIMIT = 64

type IndexedNode = { projectId: string; node: CanvasNode; target: AgentNodeTarget }

type Pending = {
  sweep: boolean
  // Agents to read again from Paseo.
  fetch: Set<string>
  // Agents whose Paseo children should be looked up, recursively.
  discover: Set<string>
  // Agents whose provider-native sub-agent list should be read again.
  subagents: Set<string>
}

function emptyPending(): Pending {
  return { sweep: false, fetch: new Set(), discover: new Set(), subagents: new Set() }
}

export function createAgentService(options: AgentServiceOptions): SpadeAgentService {
  return new PaseoAgentService(options)
}

// Owns every interaction with Paseo. Paseo manages agents; SPADE is a view on top: it follows every agent
// shown on a canvas and, recursively, every agent Paseo reports as their child, and lets nodes render the
// ones that are expanded. SPADE's records keep only the opaque identity (resourceRef) and a cached summary.
//
// Reconciliation never adds or removes a node. A Paseo child appears, collapsed, in its owner's runtime
// (`AgentRuntime.children`) until the user expands it into a delegated child node.
class PaseoAgentService implements SpadeAgentService {
  readonly entityAdapter: MainEntityAdapter
  private readonly gateway: WorkspaceGateway
  private readonly paseo: PaseoPort
  private readonly entities: EntityRegistry
  private readonly agentInstructions: AgentInstructions | undefined
  private readonly resolveUrl: (setting: string | null) => string
  private readonly now: () => Date
  private readonly timing: AgentServiceTiming
  private readonly listeners = new Set<(event: AgentServiceEvent) => void>()

  private readonly canvases = new Map<string, Canvas>()
  private nodes = new Map<string, IndexedNode>()
  // Agent nodes by agent id, and provider sub-agent nodes by their parent agent's id.
  private nodesByAgent = new Map<string, IndexedNode[]>()
  private readonly runtimeByNode = new Map<string, AgentRuntime>()

  private readonly snapshots = new Map<string, PaseoAgentSnapshot>()
  private readonly states = new Map<string, AgentResourceState>()
  // Paseo children by parent agent id, as far as SPADE has read them.
  private readonly childIds = new Map<string, Set<string>>()
  private readonly subagentLists = new Map<string, ProviderSubagentInfo[]>()
  private readonly subagentObservable = new Map<string, boolean>()
  private readonly paseoTitles = new Map<string, Set<string>>()
  // When each agent's snapshot was last applied, so a listing never undoes what arrived after it started.
  private readonly appliedAt = new Map<string, number>()
  private applied = 0

  private pending = emptyPending()
  private readonly presentationDirty = new Set<string>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private queue: Promise<void> = Promise.resolve()
  private readonly timelineTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private watchKey: string | null = null
  private providerCache: { cwd: string; expires: number; providers: AgentProviderInfo[] } | null = null
  // The saved daemon URL setting the connection was last resolved from.
  private urlSetting: string | null = null
  private settingRefresh: Promise<void> | null = null
  private unsubscribers: Array<() => void> = []
  private running = false

  constructor(options: AgentServiceOptions) {
    this.gateway = options.gateway
    this.paseo = options.paseo
    this.entities = options.entities
    this.agentInstructions = options.agentInstructions
    this.resolveUrl = options.resolvePaseoUrl ?? ((setting) => resolvePaseoUrl({ setting }).url)
    this.now = options.now ?? (() => new Date())
    this.timing = { ...DEFAULT_TIMING, ...options.timing }
    this.entityAdapter = {
      type: AGENT_ENTITY,
      create: (input) => this.spawn(input),
      discard: (_input, created) => this.discardSpawn(created)
    }
  }

  // Lifecycle

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.urlSetting = this.gateway.getSettings().paseoUrl
    this.unsubscribers = [
      this.gateway.subscribe((event) => this.onGatewayEvent(event)),
      this.paseo.subscribe((event) => this.onPaseoEvent(event))
    ]
    await this.loadCanvases()
    // Connecting never blocks startup: a missing daemon is a normal state that recovers on its own.
    await this.paseo.start()
    if (this.paseo.connection().state === 'connected') this.request((pending) => (pending.sweep = true))
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    for (const unsubscribe of this.unsubscribers) unsubscribe()
    this.unsubscribers = []
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    for (const timer of this.timelineTimers.values()) clearTimeout(timer)
    this.timelineTimers.clear()
    this.pending = emptyPending()
    // Nothing watched before the stop is assumed to survive it: the next start subscribes again.
    this.watchKey = null
    await this.paseo.stop()
    await Promise.race([this.queue, new Promise((resolve) => setTimeout(resolve, 2_000))])
  }

  async whenIdle(): Promise<void> {
    while (this.running) {
      if (this.settingRefresh) {
        await this.settingRefresh
        continue
      }
      await this.queue
      if (this.flushTimer) {
        await new Promise((resolve) => setTimeout(resolve, this.timing.coalesceMs + 1))
        continue
      }
      if (this.hasPendingWork()) {
        this.scheduleFlush()
        continue
      }
      return
    }
  }

  connection(): PaseoConnection {
    return this.paseo.connection()
  }

  async refreshConnection(): Promise<PaseoConnection> {
    const setting = this.gateway.getSettings().paseoUrl
    this.urlSetting = setting
    this.providerCache = null
    await this.paseo.reconnect(this.resolveUrl(setting))
    // A reconnection sweeps by itself; this also covers a connection that was already up.
    if (this.running && this.paseo.connection().state === 'connected') {
      this.pending.sweep = true
      await this.runFlush()
    }
    return this.paseo.connection()
  }

  subscribe(listener: (event: AgentServiceEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  runtimes(projectId: string): AgentRuntime[] {
    return [...this.runtimeByNode.values()].filter((runtime) => runtime.projectId === projectId)
  }

  // Spawning

  // An agent the user creates from the UI: SPADE's instructions and the saved default mode apply.
  private async spawn(input: EntityCreateInput): Promise<EntityCreateResult> {
    const config = agentEntity.parseConfig(input.config)
    if (config.prompt === null) throw new Error('An agent needs an initial prompt.')
    const project = input.project
    const defaults = this.gateway.getSettings().agentDefaults
    // Mode ids are provider-specific, so the saved default applies only to its own provider.
    const mode = config.mode ?? (defaults && defaults.provider === config.provider ? defaults.mode : null)
    const instructions = this.agentInstructions?.({ nodeId: input.nodeId, project }) ?? null
    const prompt = instructions ? `${config.prompt}\n\n${instructions}` : config.prompt

    const snapshot = await callPaseo('spawn the agent', () =>
      this.paseo.spawnAgent({
        cwd: project.rootPath,
        provider: config.provider,
        prompt,
        ...(config.model ? { model: config.model } : {}),
        ...(mode ? { mode } : {}),
        ...(input.title ? { title: input.title } : {}),
        ...(input.actor.kind === 'agent' ? { parentAgentId: input.actor.agentId } : {})
      })
    )
    this.applySnapshot(snapshot)

    // The node must point at the agent even if this bookkeeping fails, so it never blocks the spawn.
    const workspaceId = await this.ensureRootWorkspace(project, snapshot.workspaceId).catch((error: unknown) => {
      console.error('SPADE could not record the project workspace', error)
      return undefined
    })
    const normalized: AgentConfig = {
      provider: snapshot.provider,
      model: snapshot.model ?? config.model,
      mode: snapshot.mode ?? mode,
      prompt: config.prompt,
      ...(config.expansion === undefined ? {} : { expansion: config.expansion })
    }
    return {
      resourceRef: agentResourceRef(snapshot.id),
      title: input.title ?? paseoTitle(snapshot.title) ?? promptTitle(config.prompt) ?? undefined,
      config: normalized,
      ...(workspaceId === undefined ? {} : { workspaceId })
    }
  }

  // The spawn command failed after Paseo created the agent: archive it rather than leave it running without a node.
  private async discardSpawn(created: EntityCreateResult): Promise<void> {
    const ref = created.resourceRef
    const agentId = ref?.provider === 'paseo' && ref.kind === PASEO_AGENT_KIND ? ref.id : null
    if (agentId === null) return
    await callPaseo('archive the agent', () => this.paseo.archiveAgent(agentId))
  }

  async spawnChildAgent(
    callerAgentId: string,
    input: { prompt: string; provider: string; model?: string; mode?: string; title?: string }
  ): Promise<{ agentId: string }> {
    if (!nonEmpty(input.prompt)) throw new AgentServiceError('invalid-argument', 'An agent needs an initial prompt.')
    if (!nonEmpty(input.provider)) throw new AgentServiceError('invalid-argument', 'An agent needs a provider.')
    const caller =
      this.snapshots.get(callerAgentId) ?? (await callPaseo('read the calling agent', () => this.paseo.getAgent(callerAgentId)))
    if (!caller) throw new AgentServiceError('unknown-agent', `Paseo has no agent ${callerAgentId}.`)
    // Paseo places a child created with a caller in the caller's workspace and directory; the client still
    // requires a cwd, and the caller's own is the one Paseo resolves to.
    const created = await callPaseo('spawn the agent', () =>
      this.paseo.spawnAgent({
        cwd: caller.cwd,
        provider: input.provider,
        prompt: input.prompt,
        ...(input.model ? { model: input.model } : {}),
        ...(input.mode ? { mode: input.mode } : {}),
        ...(input.title ? { title: input.title } : {}),
        parentAgentId: callerAgentId
      })
    )
    if (this.follows(callerAgentId)) this.applySnapshot(created)
    return { agentId: created.id }
  }

  // One workspace per project: its root directory, with Paseo's opaque workspace id once known.
  private async ensureRootWorkspace(project: Project, paseoWorkspaceId: string | null): Promise<string> {
    const canvas = await this.gateway.getCanvas(project.id)
    const existing = canvas.workspaces.find((workspace) => isSamePath(workspace.cwd, project.rootPath))
    const id = existing?.id ?? `root-${project.id}`
    await this.gateway.execute(
      project.id,
      {
        type: 'upsertWorkspace',
        workspace: {
          id,
          cwd: project.rootPath,
          name: existing?.name ?? project.name,
          ...(paseoWorkspaceId ? { paseoWorkspaceId } : {})
        }
      },
      SYSTEM
    )
    return id
  }

  // Operations on nodes

  async listProviders(): Promise<AgentProviderInfo[]> {
    const cwd = this.gateway.listProjects()[0]?.rootPath ?? homedir()
    const now = this.now().getTime()
    if (this.providerCache && this.providerCache.cwd === cwd && this.providerCache.expires > now) {
      return this.providerCache.providers
    }
    const providers = await callPaseo('list providers', () => this.paseo.listProviders(cwd))
    this.providerCache = { cwd, expires: now + this.timing.providerCacheMs, providers }
    return providers
  }

  async timeline(nodeId: string, query: AgentTimelineQuery = {}): Promise<AgentTimelinePage> {
    const { target } = await this.requireAgentNode(nodeId)
    const page =
      target.kind === 'agent'
        ? await callPaseo('read the conversation', () => this.paseo.agentTimeline(target.agentId, query))
        : await callPaseo('read the sub-agent conversation', () =>
            this.paseo.providerSubagentTimeline(target.parentAgentId, target.subagentId, query)
          )
    return { nodeId, ...page }
  }

  // The user's composer. Agents message each other with Paseo's own tools.
  async prompt(nodeId: string, input: { text: string; contextNodeIds?: string[] }): Promise<void> {
    const { projectId, agentId } = await this.requireManagedAgent(nodeId, 'prompted')
    if (typeof input.text !== 'string' || input.text.trim().length === 0) {
      throw new AgentServiceError('invalid-argument', 'A prompt needs text.')
    }
    let message = input.text
    const contextNodeIds = input.contextNodeIds ?? []
    if (contextNodeIds.length > 0) {
      const canvas = await this.gateway.getCanvas(projectId)
      const unknown = contextNodeIds.find((id) => !canvas.nodes.some((node) => node.id === id))
      if (unknown !== undefined) {
        throw new AgentServiceError('unknown-node', `Context node ${unknown} is not on this agent's canvas.`)
      }
      const block = formatAgentContext(buildAgentContext(canvas, this.entities, nodeId, contextNodeIds))
      if (block) message = `${message}\n\n${block}`
    }
    await callPaseo('send the prompt', () => this.paseo.sendPrompt(agentId, message))
    this.request((pending) => pending.fetch.add(agentId))
  }

  async interrupt(nodeId: string): Promise<void> {
    const { agentId } = await this.requireManagedAgent(nodeId, 'interrupted')
    await callPaseo('interrupt the agent', () => this.paseo.interrupt(agentId))
    this.request((pending) => pending.fetch.add(agentId))
  }

  async respondToPermission(nodeId: string, requestId: string, behavior: PermissionBehavior): Promise<void> {
    const { agentId } = await this.requireManagedAgent(nodeId, 'asked for permissions')
    await this.answerPermission(agentId, requestId, behavior)
  }

  async openProviderSubagent(nodeId: string, subagentId: string, actor: Actor): Promise<{ nodeId: string }> {
    const { projectId, node, target } = await this.requireAgentNode(nodeId)
    const parentAgentId = target.kind === 'agent' ? target.agentId : target.parentAgentId
    let row = this.subagentLists.get(parentAgentId)?.find((candidate) => candidate.id === subagentId)
    if (!row) {
      await callPaseo('list provider sub-agents', () => this.refreshSubagents(parentAgentId, { rethrow: true }))
      row = this.subagentLists.get(parentAgentId)?.find((candidate) => candidate.id === subagentId)
    }
    if (!row) throw new AgentServiceError('unknown-subagent', `The agent has no provider sub-agent ${subagentId}.`)

    const provider = this.snapshots.get(parentAgentId)?.provider ?? agentConfigOf(node)?.provider ?? 'unknown'
    const title = row.description ?? row.title
    const outcome = await this.gateway.execute(
      projectId,
      {
        type: 'spawnChild',
        sourceNodeId: node.id,
        origin: 'delegated',
        node: {
          entityType: AGENT_ENTITY,
          config: { provider, model: null, mode: null, prompt: null },
          ...(title ? { title: clipText(title, SUBAGENT_TITLE_LIMIT) } : {}),
          resourceRef: providerSubagentResourceRef(parentAgentId, subagentId),
          ifResourceAbsent: true
        }
      },
      actor
    )
    if (!outcome.nodeId) throw new AgentServiceError('paseo-failed', 'The sub-agent node was not created.')
    return { nodeId: outcome.nodeId }
  }

  // Operations on agents, so a collapsed child can be served from its owner's list.

  async respondToAgentPermission(agentId: string, requestId: string, behavior: PermissionBehavior): Promise<void> {
    this.requireFollowedAgent(agentId)
    await this.answerPermission(agentId, requestId, behavior)
  }

  async setAgentMode(agentId: string, modeId: string): Promise<void> {
    if (!nonEmpty(modeId)) throw new AgentServiceError('invalid-argument', 'A mode is a non-empty provider mode id.')
    this.requireFollowedAgent(agentId)
    await callPaseo('change the mode', () => this.paseo.setAgentMode(agentId, modeId))
    this.request((pending) => pending.fetch.add(agentId))
  }

  async expandChildAgent(ownerNodeId: string, agentId: string, actor: Actor): Promise<{ nodeId: string }> {
    const { projectId, node, target } = await this.requireAgentNode(ownerNodeId)
    if (target.kind !== 'agent') {
      throw new AgentServiceError('unsupported-agent-action', 'A provider sub-agent has no Paseo children.')
    }
    let child = typeof agentId === 'string' ? this.snapshots.get(agentId) : undefined
    if (child?.parentAgentId !== target.agentId && nonEmpty(agentId)) {
      child = (await callPaseo('read the agent', () => this.paseo.getAgent(agentId))) ?? undefined
    }
    if (!child || child.parentAgentId !== target.agentId) {
      throw new AgentServiceError('unknown-agent', `Paseo does not report agent ${String(agentId)} as a child of node ${ownerNodeId}.`)
    }
    this.applySnapshot(child)
    const title = paseoTitle(child.title)
    const outcome = await this.gateway.execute(
      projectId,
      {
        type: 'spawnChild',
        sourceNodeId: node.id,
        origin: 'delegated',
        node: {
          entityType: AGENT_ENTITY,
          config: { provider: child.provider, model: child.model, mode: child.mode, prompt: null },
          ...(title ? { title } : {}),
          resourceRef: agentResourceRef(child.id),
          ifResourceAbsent: true
        }
      },
      actor
    )
    if (!outcome.nodeId) throw new AgentServiceError('paseo-failed', 'The child agent node was not created.')
    return { nodeId: outcome.nodeId }
  }

  async locateAgent(agentId: string): Promise<AgentLocation | null> {
    if (!nonEmpty(agentId)) return null
    // The agent, then its owners up Paseo's parent chain, as far as they are known.
    const chain: PaseoAgentSnapshot[] = []
    const fetched: PaseoAgentSnapshot[] = []
    let current: string | null = agentId
    while (current !== null && chain.length < OWNERSHIP_DEPTH_LIMIT && !chain.some((entry) => entry.id === current)) {
      let snapshot = this.snapshots.get(current)
      if (!snapshot) {
        const read = await this.readAgent(current)
        if (read) fetched.push(read)
        snapshot = read ?? undefined
      }
      if (!snapshot) break
      chain.push(snapshot)
      current = snapshot.parentAgentId
    }
    const ids = chain.length > 0 ? chain.map((entry) => entry.id) : [agentId]
    // An agent shown on a canvas is located there even while Paseo cannot be read.
    if (chain.length === 0 && !this.hasAgentNode(agentId)) return null

    const placements: AgentLocation['placements'] = []
    for (const projectId of this.canvases.keys()) {
      for (const id of ids) {
        const own = this.agentNodeOn(id, projectId)
        if (!own) continue
        placements.push({ projectId, nodeId: id === agentId ? own.node.id : null, anchorNodeId: own.node.id })
        break
      }
    }
    if (placements.length === 0) return null
    for (const snapshot of fetched) this.applySnapshot(snapshot)
    // A canvas showing the agent's own node comes first.
    placements.sort((left, right) => Number(left.nodeId === null) - Number(right.nodeId === null))
    return { agentId, parentAgentId: chain[0]?.parentAgentId ?? null, placements }
  }

  private async readAgent(agentId: string): Promise<PaseoAgentSnapshot | null> {
    if (this.paseo.connection().state !== 'connected') return null
    try {
      return await this.paseo.getAgent(agentId)
    } catch {
      return null
    }
  }

  private async answerPermission(agentId: string, requestId: string, behavior: PermissionBehavior): Promise<void> {
    if (behavior !== 'allow' && behavior !== 'deny') {
      throw new AgentServiceError('invalid-argument', 'A permission response is "allow" or "deny".')
    }
    await callPaseo('answer the permission request', () => this.paseo.respondToPermission(agentId, requestId, behavior))
    this.request((pending) => pending.fetch.add(agentId))
  }

  private async requireAgentNode(nodeId: string): Promise<IndexedNode> {
    const match = typeof nodeId === 'string' ? await this.gateway.findNode(nodeId) : null
    if (!match) throw new AgentServiceError('unknown-node', `Unknown node: ${String(nodeId)}`)
    const target = agentTargetOf(match.node)
    if (!target) throw new AgentServiceError('not-an-agent', `Node ${nodeId} is not a Paseo agent.`)
    return { projectId: match.projectId, node: match.node, target }
  }

  // An agent Paseo manages (not a provider-native sub-agent) that Paseo still has.
  private async requireManagedAgent(nodeId: string, verb: string): Promise<{ projectId: string; agentId: string }> {
    const { projectId, target } = await this.requireAgentNode(nodeId)
    if (target.kind !== 'agent') {
      throw new AgentServiceError('unsupported-agent-action', `A provider sub-agent cannot be ${verb}; use its parent agent.`)
    }
    if (this.states.get(target.agentId) === 'missing') {
      throw new AgentServiceError('agent-missing', `Paseo no longer has the agent behind node ${nodeId}.`)
    }
    return { projectId, agentId: target.agentId }
  }

  private requireFollowedAgent(agentId: string): void {
    if (!nonEmpty(agentId) || !this.follows(agentId)) {
      throw new AgentServiceError('unknown-agent', `SPADE does not show agent ${String(agentId)}, nor an owner of it.`)
    }
    if (this.states.get(agentId) === 'missing') throw new AgentServiceError('agent-missing', `Paseo no longer has agent ${agentId}.`)
  }

  // Events

  private onGatewayEvent(event: WorkspaceGatewayEvent): void {
    if (!this.running) return
    if (event.type === 'canvas-changed') {
      this.onCanvasChanged(event)
    } else if (event.type === 'projects-changed') {
      void this.loadCanvases().catch((error: unknown) => console.error('The agent service could not load canvases', error))
    } else if (this.gateway.getSettings().paseoUrl !== this.urlSetting) {
      // Saving the daemon URL refreshes the connection, as the refresh control does.
      const refresh: Promise<void> = this.refreshConnection()
        .then(() => undefined)
        .catch((error: unknown) => console.error('SPADE could not refresh the Paseo connection', error))
        .finally(() => {
          if (this.settingRefresh === refresh) this.settingRefresh = null
        })
      this.settingRefresh = refresh
    }
  }

  private onCanvasChanged(event: Extract<WorkspaceGatewayEvent, { type: 'canvas-changed' }>): void {
    const projectId = event.canvas.projectId
    const before = new Set([...this.nodes.values()].filter((entry) => entry.projectId === projectId).map((entry) => entry.node.id))
    this.canvases.set(projectId, event.canvas)
    this.rebuildIndex()

    const removed = [...before].filter((nodeId) => !this.nodes.has(nodeId))
    for (const nodeId of removed) this.dropRuntime(nodeId)
    if (removed.length > 0) this.forgetUnfollowed()
    for (const entry of this.nodes.values()) {
      if (entry.projectId !== projectId) continue
      if (!before.has(entry.node.id)) {
        const target = entry.target
        this.request((pending) => {
          if (target.kind === 'agent') {
            if (!this.snapshots.has(target.agentId)) pending.fetch.add(target.agentId)
            pending.discover.add(target.agentId)
          } else {
            if (!this.snapshots.has(target.parentAgentId)) pending.fetch.add(target.parentAgentId)
            if (!this.subagentLists.has(target.parentAgentId)) pending.subagents.add(target.parentAgentId)
          }
        })
      }
      // Expanding or removing a node changes how its owner lists the agent.
      this.updateRuntime(entry)
    }
    this.syncTimelineWatch()
  }

  private onPaseoEvent(event: PaseoAdapterEvent): void {
    if (!this.running) return
    switch (event.type) {
      case 'connection':
        this.emit({ type: 'connection', connection: event.connection })
        if (event.connection.state === 'connected') {
          // Another daemon, or the same one restarted, may offer other providers.
          this.providerCache = null
          this.request((pending) => (pending.sweep = true))
        } else {
          this.markAllStale()
        }
        return
      case 'agent-updated': {
        const parentAgentId = event.agent.parentAgentId
        if (!this.follows(event.agentId) && !(parentAgentId !== null && this.follows(parentAgentId))) return
        const previous = this.snapshots.get(event.agentId)
        this.applySnapshot(event.agent)
        // Provider sub-agents start and finish within a parent's turn.
        if (this.nodesByAgent.has(event.agentId) && previous?.status !== event.agent.status) {
          this.request((pending) => pending.subagents.add(event.agentId))
        }
        return
      }
      case 'agent-removed':
        if (this.follows(event.agentId)) {
          this.states.set(event.agentId, 'missing')
          this.updateAgentRuntimes(event.agentId)
          this.syncTimelineWatch()
        }
        return
      case 'timeline':
        for (const entry of this.nodesByAgent.get(event.agentId) ?? []) {
          if (entry.target.kind === 'agent') this.scheduleTimeline(entry.node.id)
        }
        return
      case 'permissions':
        if (this.follows(event.agentId)) this.request((pending) => pending.fetch.add(event.agentId))
        return
      case 'provider-subagents':
        if (this.nodesByAgent.has(event.parentAgentId)) {
          this.request((pending) => pending.subagents.add(event.parentAgentId))
        }
        return
      case 'provider-subagent-timeline':
        for (const entry of this.nodesByAgent.get(event.parentAgentId) ?? []) {
          if (entry.target.kind === 'provider-subagent' && entry.target.subagentId === event.subagentId) {
            this.scheduleTimeline(entry.node.id)
          }
        }
        return
    }
  }

  // Reconciliation

  private request(change: (pending: Pending) => void): void {
    if (!this.running) return
    change(this.pending)
    this.scheduleFlush()
  }

  private hasPendingWork(): boolean {
    const pending = this.pending
    return (
      pending.sweep ||
      pending.fetch.size > 0 ||
      pending.discover.size > 0 ||
      pending.subagents.size > 0 ||
      this.presentationDirty.size > 0
    )
  }

  private scheduleFlush(): void {
    if (!this.running || this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.runFlush()
    }, this.timing.coalesceMs)
  }

  // Runs one flush after everything already queued; resolves when it is done, never rejects.
  private runFlush(): Promise<void> {
    const run = this.queue.then(() => this.flush())
    this.queue = run.catch((error: unknown) => {
      console.error('Agent reconciliation failed', error)
    })
    return this.queue
  }

  private async flush(): Promise<void> {
    if (!this.running) return
    const work = this.pending
    this.pending = emptyPending()
    const connected = this.paseo.connection().state === 'connected'
    try {
      if (connected && work.sweep) {
        await this.sweep()
      } else if (connected) {
        await this.forEachLimited([...work.fetch], (agentId) => this.refreshAgent(agentId))
        await this.forEachLimited([...work.subagents], (agentId) => this.refreshSubagents(agentId))
        if (work.discover.size > 0) await this.discoverChildren([...work.discover])
      }
      // Work dropped while disconnected is covered by the sweep the next connection runs.
    } catch (error) {
      // A connection lost mid-way: the next connection's sweep covers everything again.
      if (this.paseo.connection().state === 'connected') console.error('Agent reconciliation failed', error)
    }
    this.syncTimelineWatch()
    await this.writePresentations()
    this.forgetUnfollowed()
  }

  // Full pass over every agent node and everything Paseo reports under them: run on start and on every
  // (re)connection.
  private async sweep(): Promise<void> {
    await this.loadCanvases()
    const agentIds = [...this.nodesByAgent.keys()]
    await this.forEachLimited(agentIds, (agentId) => this.refreshAgent(agentId))
    const live = agentIds.filter((agentId) => this.states.get(agentId) === 'live')
    await this.forEachLimited(live, (agentId) => this.refreshSubagents(agentId))
    await this.discoverChildren(live.filter((agentId) => this.hasAgentNode(agentId)))
  }

  private async refreshAgent(agentId: string): Promise<void> {
    try {
      const snapshot = await this.paseo.getAgent(agentId)
      if (snapshot) {
        this.applySnapshot(snapshot)
      } else {
        this.states.set(agentId, 'missing')
        this.updateAgentRuntimes(agentId)
      }
    } catch (error) {
      this.states.set(agentId, 'stale')
      this.updateAgentRuntimes(agentId)
      throwIfDisconnected(this.paseo, error)
    }
  }

  private async refreshSubagents(parentAgentId: string, options: { rethrow?: boolean } = {}): Promise<void> {
    try {
      const listing = await this.paseo.listProviderSubagents(parentAgentId)
      // An unobservable parent (archived, closed) keeps its last known list.
      this.subagentObservable.set(parentAgentId, listing.observable)
      if (listing.observable) this.subagentLists.set(parentAgentId, listing.subagents)
      this.updateAgentRuntimes(parentAgentId)
    } catch (error) {
      if (options.rethrow) throw error
      throwIfDisconnected(this.paseo, error)
    }
  }

  // Paseo children, recursively, by Paseo's durable parent identity. Each listed parent's children are
  // replaced by what Paseo reports now.
  private async discoverChildren(parentAgentIds: string[]): Promise<void> {
    const visited = new Set(parentAgentIds)
    let frontier = parentAgentIds
    while (frontier.length > 0 && this.running) {
      const listingStarted = this.applied
      const children = await this.paseo.listChildAgents(frontier)
      // A child applied after the listing started (just spawned, or just reported) is newer than it.
      const unlisted = (childId: string, listed: Set<string>): boolean =>
        !listed.has(childId) && (this.appliedAt.get(childId) ?? 0) <= listingStarted
      for (const parentAgentId of frontier) {
        const listed = new Set(children.filter((child) => child.parentAgentId === parentAgentId).map((child) => child.id))
        const known = this.childIds.get(parentAgentId)
        if (known && [...known].some((childId) => unlisted(childId, listed))) {
          this.childIds.set(parentAgentId, new Set([...known].filter((childId) => !unlisted(childId, listed))))
          this.updateAgentRuntimes(parentAgentId)
        }
      }
      const next: string[] = []
      for (const child of children) {
        this.applySnapshot(child)
        if (visited.has(child.id)) continue
        visited.add(child.id)
        next.push(child.id)
      }
      frontier = next
    }
  }

  private async loadCanvases(): Promise<void> {
    const projects = this.gateway.listProjects()
    const known = new Set(projects.map((project) => project.id))
    for (const projectId of [...this.canvases.keys()]) {
      if (!known.has(projectId)) this.canvases.delete(projectId)
    }
    for (const project of projects) {
      try {
        this.canvases.set(project.id, await this.gateway.getCanvas(project.id))
      } catch (error) {
        // An unreadable canvas has no agents SPADE can show.
        this.canvases.delete(project.id)
        if (!(error instanceof CanvasCommandError)) console.error('The agent service could not read a canvas', error)
      }
    }
    this.rebuildIndex()
    for (const nodeId of [...this.runtimeByNode.keys()]) {
      if (!this.nodes.has(nodeId)) this.dropRuntime(nodeId)
    }
    for (const entry of this.nodes.values()) this.updateRuntime(entry)
    this.syncTimelineWatch()
  }

  private hasAgentNode(agentId: string): boolean {
    return this.nodesByAgent.get(agentId)?.some((entry) => entry.target.kind === 'agent') ?? false
  }

  // The agent's own node on that canvas, when it is expanded there.
  private agentNodeOn(agentId: string, projectId: string): IndexedNode | undefined {
    return this.nodesByAgent.get(agentId)?.find((entry) => entry.target.kind === 'agent' && entry.projectId === projectId)
  }

  followedAgentIds(): string[] {
    return [...this.followedSet()].sort()
  }

  // Agents shown on a canvas and, recursively, every Paseo child SPADE knows under them.
  private followedSet(): Set<string> {
    const followed = new Set<string>()
    const pending = [...this.nodesByAgent.keys()]
    for (let agentId = pending.pop(); agentId !== undefined; agentId = pending.pop()) {
      if (followed.has(agentId)) continue
      followed.add(agentId)
      pending.push(...(this.childIds.get(agentId) ?? []))
    }
    return followed
  }

  // Drops what SPADE knows about agents no longer under any shown agent; they are read again if they return.
  private forgetUnfollowed(): void {
    const followed = this.followedSet()
    for (const byAgent of [
      this.snapshots,
      this.states,
      this.childIds,
      this.paseoTitles,
      this.appliedAt,
      this.subagentLists,
      this.subagentObservable
    ]) {
      for (const agentId of [...byAgent.keys()]) if (!followed.has(agentId)) byAgent.delete(agentId)
    }
  }

  // True for an agent shown on a canvas (or whose provider sub-agent is) and for every agent Paseo reports
  // under one, at any depth.
  private follows(agentId: string): boolean {
    const seen = new Set<string>()
    for (let current: string | null = agentId; current !== null && !seen.has(current) && seen.size < OWNERSHIP_DEPTH_LIMIT; ) {
      if (this.nodesByAgent.has(current)) return true
      seen.add(current)
      current = this.snapshots.get(current)?.parentAgentId ?? null
    }
    return false
  }

  private rebuildIndex(): void {
    const nodes = new Map<string, IndexedNode>()
    const byAgent = new Map<string, IndexedNode[]>()
    for (const [projectId, canvas] of this.canvases) {
      for (const node of canvas.nodes) {
        const target = agentTargetOf(node)
        if (!target) continue
        const entry = { projectId, node, target }
        nodes.set(node.id, entry)
        const agentId = target.kind === 'agent' ? target.agentId : target.parentAgentId
        const list = byAgent.get(agentId)
        if (list) list.push(entry)
        else byAgent.set(agentId, [entry])
      }
    }
    this.nodes = nodes
    this.nodesByAgent = byAgent
  }

  // Runtimes

  private applySnapshot(snapshot: PaseoAgentSnapshot): void {
    this.applied += 1
    this.appliedAt.set(snapshot.id, this.applied)
    this.snapshots.set(snapshot.id, snapshot)
    this.states.set(snapshot.id, 'live')
    if (snapshot.parentAgentId !== null) {
      const siblings = this.childIds.get(snapshot.parentAgentId)
      if (siblings) siblings.add(snapshot.id)
      else this.childIds.set(snapshot.parentAgentId, new Set([snapshot.id]))
    }
    const title = paseoTitle(snapshot.title)
    if (title) {
      const titles = this.paseoTitles.get(snapshot.id)
      if (titles) titles.add(title)
      else this.paseoTitles.set(snapshot.id, new Set([title]))
    }
    this.updateAgentRuntimes(snapshot.id)
  }

  private markAllStale(): void {
    for (const [agentId, state] of this.states) {
      if (state === 'live') this.states.set(agentId, 'stale')
    }
    for (const entry of this.nodes.values()) this.updateRuntime(entry)
  }

  // The agent's own nodes and those of every owner up its chain, which list it.
  private updateAgentRuntimes(agentId: string): void {
    const seen = new Set<string>()
    for (let current: string | null = agentId; current !== null && !seen.has(current) && seen.size < OWNERSHIP_DEPTH_LIMIT; ) {
      seen.add(current)
      for (const entry of this.nodesByAgent.get(current) ?? []) this.updateRuntime(entry)
      current = this.snapshots.get(current)?.parentAgentId ?? null
    }
  }

  private updateRuntime(entry: IndexedNode): void {
    const runtime = this.runtimeOf(entry)
    if (sameRuntime(this.runtimeByNode.get(entry.node.id), runtime)) return
    this.runtimeByNode.set(entry.node.id, runtime)
    this.emit({ type: 'runtime', runtime })
    if (runtime.resourceState === 'live') {
      this.presentationDirty.add(entry.node.id)
      this.scheduleFlush()
    }
  }

  private dropRuntime(nodeId: string): void {
    this.runtimeByNode.delete(nodeId)
    this.presentationDirty.delete(nodeId)
    const timer = this.timelineTimers.get(nodeId)
    if (timer) clearTimeout(timer)
    this.timelineTimers.delete(nodeId)
  }

  private runtimeOf({ projectId, node, target }: IndexedNode): AgentRuntime {
    if (target.kind === 'agent') {
      const canvas = this.canvases.get(projectId)
      const workspace = canvas?.workspaces.find((candidate) => candidate.id === node.workspaceId)
      return agentRuntimeOf({
        projectId,
        node,
        agentId: target.agentId,
        snapshot: this.snapshots.get(target.agentId),
        state: this.states.get(target.agentId) ?? 'stale',
        providerSubagents: this.subagentLists.get(target.agentId) ?? [],
        children: this.childrenOf(target.agentId, projectId, new Set([target.agentId])),
        fallbackCwd: workspace?.cwd ?? null
      })
    }
    const parentState = this.states.get(target.parentAgentId) ?? 'stale'
    const listed = this.subagentLists.get(target.parentAgentId) ?? null
    const observable = this.subagentObservable.get(target.parentAgentId) === true
    const present = listed?.some((row) => row.id === target.subagentId) ?? false
    const state: AgentResourceState =
      parentState !== 'live' ? parentState : !observable ? 'stale' : present ? 'live' : 'missing'
    return providerSubagentRuntimeOf({
      projectId,
      node,
      parentAgentId: target.parentAgentId,
      subagentId: target.subagentId,
      parent: this.snapshots.get(target.parentAgentId),
      listed,
      state
    })
  }

  // Direct Paseo children, oldest first. A child without a node on this canvas lists its own children, so
  // whatever waits on the user surfaces on the nearest expanded owner.
  private childrenOf(agentId: string, projectId: string, seen: ReadonlySet<string>): ChildAgentInfo[] {
    const children: ChildAgentInfo[] = []
    for (const childId of this.childIds.get(agentId) ?? []) {
      const snapshot = this.snapshots.get(childId)
      if (!snapshot || seen.has(childId) || seen.size >= OWNERSHIP_DEPTH_LIMIT) continue
      const own = this.agentNodeOn(childId, projectId)
      // An archived child is done; only a node the user keeps for it still shows it.
      if (snapshot.archivedAt !== null && !own) continue
      children.push(
        childAgentInfoOf({
          snapshot,
          state: this.states.get(childId) ?? 'stale',
          nodeId: own?.node.id ?? null,
          children: own ? [] : this.childrenOf(childId, projectId, new Set([...seen, childId]))
        })
      )
    }
    return children.sort((left, right) => {
      const created = (this.snapshots.get(left.agentId)?.createdAt ?? '').localeCompare(this.snapshots.get(right.agentId)?.createdAt ?? '')
      return created !== 0 ? created : left.agentId.localeCompare(right.agentId)
    })
  }

  // Mirrors the summary (and Paseo's title, while the node keeps an automatic one) onto the node:
  // one write per node per meaningful change, never while the runtime is not live.
  private async writePresentations(): Promise<void> {
    const dirty = [...this.presentationDirty]
    this.presentationDirty.clear()
    for (const nodeId of dirty) {
      if (!this.running) return
      const entry = this.nodes.get(nodeId)
      const runtime = this.runtimeByNode.get(nodeId)
      if (!entry || !runtime || runtime.resourceState !== 'live') continue
      const { node } = entry
      const summary = runtimeSummary(runtime)
      const patch: { title?: string; cachedPresentation?: { revision?: string; summary: string } } = {}
      if (node.cachedPresentation?.summary !== summary) {
        const revision = node.cachedPresentation?.revision
        patch.cachedPresentation = { ...(revision === undefined ? {} : { revision }), summary }
      }
      if (entry.target.kind === 'agent') {
        const title = paseoTitle(runtime.title)
        if (title && title !== node.title && hasAutomaticTitle(node, this.paseoTitles.get(entry.target.agentId))) {
          patch.title = title
        }
      }
      if (patch.title === undefined && patch.cachedPresentation === undefined) continue
      try {
        await this.gateway.execute(entry.projectId, { type: 'updateNode', nodeId, patch }, SYSTEM)
      } catch (error) {
        if (!(error instanceof CanvasCommandError && error.code === 'unknown-node')) {
          console.error('SPADE could not record an agent summary', error)
        }
      }
    }
  }

  // Timelines

  private syncTimelineWatch(): void {
    if (!this.running) return
    const ids = [...this.nodesByAgent.keys()]
      .filter((agentId) => this.hasAgentNode(agentId) && this.states.get(agentId) !== 'missing')
      .sort()
    const key = ids.join('\n')
    if (key === this.watchKey) return
    this.watchKey = key
    this.paseo.watchTimelines(ids).catch(() => {
      // Retried on the next change; the adapter also re-applies the requested set on reconnect.
      if (this.watchKey === key) this.watchKey = null
    })
  }

  private scheduleTimeline(nodeId: string): void {
    if (this.timelineTimers.has(nodeId)) return
    this.timelineTimers.set(
      nodeId,
      setTimeout(() => {
        this.timelineTimers.delete(nodeId)
        if (this.running && this.nodes.has(nodeId)) this.emit({ type: 'timeline', nodeId })
      }, this.timing.timelineDebounceMs)
    )
  }

  // Helpers

  private async forEachLimited(ids: string[], task: (id: string) => Promise<void>): Promise<void> {
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < ids.length && this.running) {
        const id = ids[next]
        next += 1
        await task(id)
      }
    }
    await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, ids.length) }, worker))
  }

  private emit(event: AgentServiceEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch (error) {
        console.error('An agent service listener failed', error)
      }
    }
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

// A failed read while connected marks one agent stale; a lost connection aborts the whole pass.
function throwIfDisconnected(paseo: PaseoPort, error: unknown): void {
  if (paseo.connection().state !== 'connected') throw error
}
