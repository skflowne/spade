import { homedir } from 'node:os'
import type {
  AgentService,
  AgentServiceEvent,
  EntityCreateInput,
  EntityCreateResult,
  MainEntityAdapter,
  WorkspaceGateway,
  WorkspaceGatewayEvent
} from '../contracts'
import type { PaseoAdapterEvent, PaseoAgentSnapshot } from '../paseo'
import { buildAgentContext, formatAgentContext } from '../../shared/agentContext'
import type {
  AgentProviderInfo,
  AgentResourceState,
  AgentRuntime,
  AgentTimelinePage,
  AgentTimelineQuery,
  PaseoConnection,
  PermissionBehavior,
  ProviderSubagentInfo
} from '../../shared/agents'
import { AGENT_ENTITY, agentEntity, type AgentConfig } from '../../shared/builtinEntities'
import { CanvasCommandError } from '../../shared/commands'
import type { Actor, Canvas, CanvasNode, Project } from '../../shared/domain'
import type { EntityRegistry } from '../../shared/entities'
import { isSamePath } from '../../shared/paths'
import {
  agentConfigOf,
  agentResourceRef,
  agentRuntimeOf,
  agentTargetOf,
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
  // How long a spawned agent waits for the gateway to persist its node before reconciliation may adopt it.
  inFlightTimeoutMs: number
  providerCacheMs: number
}

export type AgentServiceOptions = {
  gateway: WorkspaceGateway
  paseo: PaseoPort
  entities: EntityRegistry
  // Appended to an initial prompt after a blank line; never stored in the node's config.
  agentInstructions?: AgentInstructions
  now?: () => Date
  timing?: Partial<AgentServiceTiming>
}

export type SpadeAgentService = AgentService & {
  // Resolves once every event received so far has been reconciled and written. For tests and scripts.
  whenIdle(): Promise<void>
}

const DEFAULT_TIMING: AgentServiceTiming = {
  coalesceMs: 50,
  timelineDebounceMs: 150,
  inFlightTimeoutMs: 60_000,
  providerCacheMs: 30_000
}

const SYSTEM: Actor = { kind: 'system' }
const READ_CONCURRENCY = 8
const SUBAGENT_TITLE_LIMIT = 80

type IndexedNode = { projectId: string; node: CanvasNode; target: AgentNodeTarget }

type Pending = {
  sweep: boolean
  // Agents to read again from Paseo.
  fetch: Set<string>
  // Agents Paseo reported that have no node yet but whose parent may have one.
  adopt: Map<string, PaseoAgentSnapshot>
  // Agents whose managed children should be looked up.
  discover: Set<string>
  // Agents whose provider-native sub-agent list should be read again.
  subagents: Set<string>
}

function emptyPending(): Pending {
  return { sweep: false, fetch: new Set(), adopt: new Map(), discover: new Set(), subagents: new Set() }
}

export function createAgentService(options: AgentServiceOptions): SpadeAgentService {
  return new PaseoAgentService(options)
}

// Owns every interaction with Paseo and keeps agent nodes reconciled with it. Paseo is authoritative for
// agent state; SPADE's records keep only the opaque identity (resourceRef) and a cached summary.
//
// Reconciliation never removes a node and only ever adds managed child agents (by Paseo's durable parent
// identity) under their parent's node. A child whose parent has no node is not placed anywhere, and a
// child whose node the user removed is not added again while this service runs.
class PaseoAgentService implements SpadeAgentService {
  readonly entityAdapter: MainEntityAdapter
  private readonly gateway: WorkspaceGateway
  private readonly paseo: PaseoPort
  private readonly entities: EntityRegistry
  private readonly agentInstructions: AgentInstructions | undefined
  private readonly now: () => Date
  private readonly timing: AgentServiceTiming
  private readonly listeners = new Set<(event: AgentServiceEvent) => void>()

  private readonly canvases = new Map<string, Canvas>()
  private nodes = new Map<string, IndexedNode>()
  private nodesByAgent = new Map<string, IndexedNode[]>()
  private readonly runtimeByNode = new Map<string, AgentRuntime>()

  private readonly snapshots = new Map<string, PaseoAgentSnapshot>()
  private readonly states = new Map<string, AgentResourceState>()
  private readonly subagentLists = new Map<string, ProviderSubagentInfo[]>()
  private readonly subagentObservable = new Map<string, boolean>()
  private readonly paseoTitles = new Map<string, Set<string>>()

  // Agents whose spawn command the gateway has not persisted yet; reconciliation must not add them.
  private readonly inFlight = new Map<string, ReturnType<typeof setTimeout>>()
  private pendingSpawns = 0
  private readonly deferredAdoptions = new Map<string, PaseoAgentSnapshot>()
  private readonly dismissed = new Set<string>()

  private pending = emptyPending()
  private readonly presentationDirty = new Set<string>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private queue: Promise<void> = Promise.resolve()
  private readonly timelineTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private watchKey: string | null = null
  private providerCache: { cwd: string; expires: number; providers: AgentProviderInfo[] } | null = null
  private unsubscribers: Array<() => void> = []
  private running = false

  constructor(options: AgentServiceOptions) {
    this.gateway = options.gateway
    this.paseo = options.paseo
    this.entities = options.entities
    this.agentInstructions = options.agentInstructions
    this.now = options.now ?? (() => new Date())
    this.timing = { ...DEFAULT_TIMING, ...options.timing }
    this.entityAdapter = { type: AGENT_ENTITY, create: (input) => this.spawn(input) }
  }

  // Lifecycle

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
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
    for (const timer of [...this.timelineTimers.values(), ...this.inFlight.values()]) clearTimeout(timer)
    this.timelineTimers.clear()
    this.inFlight.clear()
    this.pending = emptyPending()
    await this.paseo.stop()
    await Promise.race([this.queue, new Promise((resolve) => setTimeout(resolve, 2_000))])
  }

  async whenIdle(): Promise<void> {
    while (this.running) {
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

  subscribe(listener: (event: AgentServiceEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  runtimes(projectId: string): AgentRuntime[] {
    return [...this.runtimeByNode.values()].filter((runtime) => runtime.projectId === projectId)
  }

  // Spawning

  private async spawn(input: EntityCreateInput): Promise<EntityCreateResult> {
    const config = agentEntity.parseConfig(input.config)
    if (config.prompt === null) throw new Error('An agent needs an initial prompt.')
    const project = input.project
    const defaults = this.gateway.getSettings().agentDefaults
    // Mode ids are provider-specific, so the saved default applies only to its own provider.
    const mode = config.mode ?? (defaults && defaults.provider === config.provider ? defaults.mode : null)
    const instructions = this.agentInstructions?.({ nodeId: input.nodeId, project }) ?? null
    const prompt = instructions ? `${config.prompt}\n\n${instructions}` : config.prompt

    this.pendingSpawns += 1
    let snapshot: PaseoAgentSnapshot
    try {
      snapshot = await callPaseo('spawn the agent', () =>
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
      this.markInFlight(snapshot.id)
      this.applySnapshot(snapshot)
    } finally {
      this.pendingSpawns -= 1
      if (this.pendingSpawns === 0 && this.deferredAdoptions.size > 0) {
        for (const [agentId, deferred] of this.deferredAdoptions) this.pending.adopt.set(agentId, deferred)
        this.deferredAdoptions.clear()
        this.scheduleFlush()
      }
    }

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

  private markInFlight(agentId: string): void {
    const previous = this.inFlight.get(agentId)
    if (previous) clearTimeout(previous)
    const timer = setTimeout(() => {
      this.inFlight.delete(agentId)
      // The node never appeared (the command failed after the spawn); the agent may still belong under its parent.
      const snapshot = this.snapshots.get(agentId)
      if (snapshot && !this.nodesByAgent.has(agentId)) this.request((pending) => pending.adopt.set(agentId, snapshot))
    }, this.timing.inFlightTimeoutMs)
    timer.unref?.()
    this.inFlight.set(agentId, timer)
  }

  private clearInFlight(agentId: string): void {
    const timer = this.inFlight.get(agentId)
    if (!timer) return
    clearTimeout(timer)
    this.inFlight.delete(agentId)
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
    if (behavior !== 'allow' && behavior !== 'deny') {
      throw new AgentServiceError('invalid-argument', 'A permission response is "allow" or "deny".')
    }
    await callPaseo('answer the permission request', () => this.paseo.respondToPermission(agentId, requestId, behavior))
    this.request((pending) => pending.fetch.add(agentId))
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

  // Events

  private onGatewayEvent(event: WorkspaceGatewayEvent): void {
    if (!this.running) return
    if (event.type === 'canvas-changed') {
      this.onCanvasChanged(event)
    } else if (event.type === 'projects-changed') {
      void this.loadCanvases().catch((error: unknown) => console.error('The agent service could not load canvases', error))
    }
  }

  private onCanvasChanged(event: Extract<WorkspaceGatewayEvent, { type: 'canvas-changed' }>): void {
    const projectId = event.canvas.projectId
    const before = new Map(
      [...this.nodes.values()].filter((entry) => entry.projectId === projectId).map((entry) => [entry.node.id, entry])
    )
    this.canvases.set(projectId, event.canvas)
    this.rebuildIndex()

    const removal = event.command.type === 'removeNode' || event.command.type === 'removeBranch'
    for (const [nodeId, entry] of before) {
      if (this.nodes.has(nodeId)) continue
      this.dropRuntime(nodeId)
      if (removal && entry.target.kind === 'agent') this.dismissed.add(entry.target.agentId)
    }

    // Nodes reconciliation adds are looked after by the reconciliation that added them.
    const addedByReconciliation = event.actor.kind === 'system' && event.command.type === 'spawnChild'
    for (const entry of this.nodes.values()) {
      if (entry.projectId !== projectId) continue
      const trackedAgent = entry.target.kind === 'agent' ? entry.target.agentId : entry.target.parentAgentId
      if (entry.target.kind === 'agent') this.clearInFlight(entry.target.agentId)
      if (!before.has(entry.node.id) && !addedByReconciliation) {
        const agentId = trackedAgent
        this.request((pending) => {
          if (!this.snapshots.has(agentId)) pending.fetch.add(agentId)
          if (entry.target.kind === 'agent') pending.discover.add(agentId)
          else if (!this.subagentLists.has(agentId)) pending.subagents.add(agentId)
        })
      }
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
          this.request((pending) => (pending.sweep = true))
        } else {
          this.markAllStale()
        }
        return
      case 'agent-updated': {
        if (this.nodesByAgent.has(event.agentId)) {
          const previous = this.snapshots.get(event.agentId)
          this.applySnapshot(event.agent)
          // Provider sub-agents start and finish within a parent's turn.
          if (previous?.status !== event.agent.status) this.request((pending) => pending.subagents.add(event.agentId))
        }
        const parentAgentId = event.agent.parentAgentId
        if (parentAgentId && !this.hasAgentNode(event.agentId) && this.hasAgentNode(parentAgentId)) {
          this.request((pending) => pending.adopt.set(event.agentId, event.agent))
        }
        return
      }
      case 'agent-removed':
        if (this.nodesByAgent.has(event.agentId)) {
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
        if (this.nodesByAgent.has(event.agentId)) this.request((pending) => pending.fetch.add(event.agentId))
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
      pending.adopt.size > 0 ||
      pending.discover.size > 0 ||
      pending.subagents.size > 0 ||
      this.presentationDirty.size > 0
    )
  }

  private scheduleFlush(): void {
    if (!this.running || this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.enqueue(() => this.flush())
    }, this.timing.coalesceMs)
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((error: unknown) => {
      console.error('Agent reconciliation failed', error)
    })
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
        const roots = new Set(work.discover)
        for (const snapshot of work.adopt.values()) {
          if (await this.adopt(snapshot)) roots.add(snapshot.id)
        }
        if (roots.size > 0) await this.discoverChildren([...roots])
      }
      // Work dropped while disconnected is covered by the sweep the next connection runs.
    } catch (error) {
      // A connection lost mid-way: the next connection's sweep covers everything again.
      if (this.paseo.connection().state === 'connected') console.error('Agent reconciliation failed', error)
    }
    this.syncTimelineWatch()
    await this.writePresentations()
  }

  // Full pass over every agent node: run on start and on every (re)connection.
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

  // Managed children, recursively, by Paseo's durable parent identity.
  private async discoverChildren(parentAgentIds: string[]): Promise<void> {
    const visited = new Set(parentAgentIds)
    let frontier = parentAgentIds
    while (frontier.length > 0 && this.running) {
      const children = await this.paseo.listChildAgents(frontier)
      const next: string[] = []
      for (const child of children) {
        if (visited.has(child.id)) continue
        visited.add(child.id)
        if (this.hasAgentNode(child.id)) {
          this.applySnapshot(child)
          next.push(child.id)
        } else if (await this.adopt(child)) {
          next.push(child.id)
        }
      }
      frontier = next
    }
  }

  // Adds a managed child agent as a collapsed, delegated child of its parent's node on every canvas
  // that has the parent and not the child. Returns whether a node now exists for it.
  private async adopt(snapshot: PaseoAgentSnapshot): Promise<boolean> {
    const parentAgentId = snapshot.parentAgentId
    if (!parentAgentId || this.dismissed.has(snapshot.id)) return false
    if (this.inFlight.has(snapshot.id)) return true
    // A spawn still waiting for Paseo may be this very agent; decide once every pending spawn is known.
    if (this.pendingSpawns > 0) {
      this.deferredAdoptions.set(snapshot.id, snapshot)
      return false
    }
    this.applySnapshot(snapshot)
    const parents = new Map<string, IndexedNode>()
    for (const entry of this.nodesByAgent.get(parentAgentId) ?? []) {
      if (entry.target.kind === 'agent' && !parents.has(entry.projectId)) parents.set(entry.projectId, entry)
    }
    let placed = false
    for (const [projectId, parent] of parents) {
      if (this.hasAgentNode(snapshot.id, projectId)) {
        placed = true
        continue
      }
      const title = paseoTitle(snapshot.title)
      try {
        await this.gateway.execute(
          projectId,
          {
            type: 'spawnChild',
            sourceNodeId: parent.node.id,
            origin: 'delegated',
            node: {
              entityType: AGENT_ENTITY,
              config: { provider: snapshot.provider, model: snapshot.model, mode: snapshot.mode, prompt: null },
              ...(title ? { title } : {}),
              collapsed: true,
              resourceRef: agentResourceRef(snapshot.id),
              ifResourceAbsent: true
            }
          },
          SYSTEM
        )
        placed = true
      } catch (error) {
        // The parent node went away meanwhile: nothing to attach to.
        if (!(error instanceof CanvasCommandError && error.code === 'unknown-node')) throw error
      }
    }
    return placed
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

  private hasAgentNode(agentId: string, projectId?: string): boolean {
    return (
      this.nodesByAgent
        .get(agentId)
        ?.some((entry) => entry.target.kind === 'agent' && (projectId === undefined || entry.projectId === projectId)) ?? false
    )
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
    this.snapshots.set(snapshot.id, snapshot)
    this.states.set(snapshot.id, 'live')
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

  private updateAgentRuntimes(agentId: string): void {
    for (const entry of this.nodesByAgent.get(agentId) ?? []) this.updateRuntime(entry)
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

// A failed read while connected marks one agent stale; a lost connection aborts the whole pass.
function throwIfDisconnected(paseo: PaseoPort, error: unknown): void {
  if (paseo.connection().state !== 'connected') throw error
}
