import {
  createPaseoClient,
  type ConnectionState,
  type PaseoAgent,
  type PaseoAgentHandle,
  type PaseoClient,
  type PaseoWorkspace
} from '@getpaseo/client'
import { PASEO_TIMELINE_LIMIT, type PaseoConnectionState } from '../shared/model'
import {
  type PaseoAgentSnapshot,
  type PaseoAuthoritativeSnapshot,
  type PaseoTimelineSnapshot,
  type PaseoWorkspaceSnapshot
} from '../shared/paseoReconciliation'

const PAGE_LIMIT = 200
const PARENT_AGENT_ID_LABEL = 'paseo.parent-agent-id'

export type PaseoAdapterNotification =
  | { type: 'connection'; state: PaseoConnectionState; error: string | null }
  | { type: 'refresh' }

export type PaseoSnapshotReferences = {
  agentIds: string[]
  workspaceIds: string[]
}

export type SpawnAgentInput = {
  workspaceId?: string
  cwd: string
  provider: string
  model: string
  prompt: string
  title?: string
  parentAgentId?: string
}

export type SpadePaseoAdapterOptions = {
  url: string
  client?: PaseoClient
  pollIntervalMs?: number
  now?: () => string
}

export class SpadePaseoAdapter {
  readonly url: string
  private readonly client: PaseoClient
  private readonly pollIntervalMs: number
  private readonly now: () => string
  private readonly listeners = new Set<(notification: PaseoAdapterNotification) => void>()
  private cleanupPublicSubscriptions: (() => void) | null = null
  private connectionTimer: ReturnType<typeof setInterval> | null = null
  private lastConnectionState: PaseoConnectionState | null = null
  private agentSubscriptionId: string | null = null
  private workspaceSubscriptionId: string | null = null

  constructor(options: SpadePaseoAdapterOptions) {
    this.url = options.url
    this.client = options.client ?? createPaseoClient({
      url: options.url,
      clientId: 'spade-p3-prototype',
      appVersion: 'spade-p3-paseo-bridge',
      reconnect: { enabled: true }
    })
    this.pollIntervalMs = options.pollIntervalMs ?? 500
    this.now = options.now ?? (() => new Date().toISOString())
  }

  subscribe(listener: (notification: PaseoAdapterNotification) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async connect(): Promise<void> {
    if (!this.cleanupPublicSubscriptions) {
      const unsubscribeAgent = this.client.agents.subscribe(() => this.emit({ type: 'refresh' }))
      const unsubscribeWorkspace = this.client.workspaces.subscribe(() => this.emit({ type: 'refresh' }))
      const unsubscribeProvider = this.client.providers.subscribe(() => this.emit({ type: 'refresh' }))
      this.cleanupPublicSubscriptions = () => {
        unsubscribeAgent()
        unsubscribeWorkspace()
        unsubscribeProvider()
      }
    }

    await this.client.connect()
    this.pollConnectionState()
    if (!this.connectionTimer && this.pollIntervalMs > 0) {
      this.connectionTimer = setInterval(() => this.pollConnectionState(), this.pollIntervalMs)
      this.connectionTimer.unref?.()
    }
  }

  async close(): Promise<void> {
    if (this.connectionTimer) clearInterval(this.connectionTimer)
    this.connectionTimer = null
    this.cleanupPublicSubscriptions?.()
    this.cleanupPublicSubscriptions = null
    await this.client.close()
  }

  pollConnectionState(): PaseoConnectionState {
    const connection = mapConnectionState(this.client.getConnectionState())
    if (connection.state !== this.lastConnectionState) {
      this.lastConnectionState = connection.state
      this.emit({ type: 'connection', ...connection })
    }
    return connection.state
  }

  async openProjectCheckout(cwd: string): Promise<PaseoWorkspaceSnapshot> {
    const handle = await this.client.workspaces.open({ cwd })
    const workspace = handle.current() ?? await handle.refresh()
    if (!workspace) throw new Error(`Paseo did not return the workspace opened for ${cwd}.`)
    return toWorkspaceSnapshot(workspace, this.now())
  }

  async createWorkspace(cwd: string, title?: string): Promise<PaseoWorkspaceSnapshot> {
    const handle = await this.client.workspaces.create({
      source: { kind: 'directory', path: cwd },
      ...(title ? { title } : {})
    })
    const workspace = handle.current() ?? await handle.refresh()
    if (!workspace) throw new Error(`Paseo did not return the workspace created for ${cwd}.`)
    return toWorkspaceSnapshot(workspace, this.now())
  }

  async attachWorkspace(workspaceId: string): Promise<PaseoWorkspaceSnapshot | null> {
    const workspace = await this.client.workspaces.ref(workspaceId).refresh()
    return workspace ? toWorkspaceSnapshot(workspace, this.now()) : null
  }

  async spawnAgent(input: SpawnAgentInput): Promise<PaseoAgentSnapshot> {
    await this.client.providers.waitForReady({ cwd: input.cwd })
    const options = {
      config: { provider: `${input.provider}/${input.model}` },
      cwd: input.cwd,
      prompt: input.prompt,
      ...(input.title ? { title: input.title } : {}),
      ...(input.parentAgentId ? { parent: input.parentAgentId } : {})
    }
    let handle: PaseoAgentHandle
    if (input.workspaceId) {
      const workspace = this.client.workspaces.ref(input.workspaceId)
      if (!await workspace.refresh()) throw new Error(`Paseo workspace ${input.workspaceId} is missing.`)
      handle = await workspace.agents.create(options)
    } else {
      handle = await this.client.agents.create(options)
    }
    const agent = handle.current() ?? (await handle.refresh())?.agent
    if (!agent) throw new Error('Paseo did not return the created agent.')
    return toAgentSnapshot(agent)
  }

  async attachAgent(agentId: string): Promise<PaseoAgentSnapshot | null> {
    const result = await this.client.agents.ref(agentId).refresh()
    return result ? toAgentSnapshot(result.agent) : null
  }

  async archiveAgent(agentId: string): Promise<string> {
    return (await this.client.agents.ref(agentId).archive()).archivedAt
  }

  async fetchAuthoritative(
    rootAgentId: string,
    references: PaseoSnapshotReferences
  ): Promise<PaseoAuthoritativeSnapshot> {
    const agentPages = await this.fetchAllAgentPages()
    const workspacePages = await this.fetchAllWorkspacePages()
    const agentById = new Map(agentPages.flat().map((agent) => [agent.id, agent]))
    const workspaceById = new Map(workspacePages.flat().map((workspace) => [workspace.id, workspace]))

    for (const agentId of new Set([rootAgentId, ...references.agentIds])) {
      const result = await this.client.agents.ref(agentId).refresh()
      if (result) agentById.set(agentId, toAgentSnapshot(result.agent))
      else agentById.delete(agentId)
    }
    for (const workspaceId of new Set(references.workspaceIds)) {
      const workspace = await this.client.workspaces.ref(workspaceId).refresh()
      if (workspace) workspaceById.set(workspaceId, toWorkspaceSnapshot(workspace, this.now()))
      else workspaceById.delete(workspaceId)
    }

    const allAgents = [...agentById.values()]
    const timelineAgentIds = new Set([
      ...descendantAgentIds(rootAgentId, allAgents),
      ...references.agentIds.filter((agentId) => agentById.has(agentId))
    ])
    const timelines: PaseoTimelineSnapshot[] = []
    for (const agentId of timelineAgentIds) {
      const result = await this.client.agents.ref(agentId).timeline.refetch({
        direction: 'tail',
        projection: 'projected',
        limit: PASEO_TIMELINE_LIMIT
      })
      if (result.error) throw new Error(`Paseo timeline ${agentId}: ${result.error}`)
      timelines.push({
        agentId,
        epoch: result.epoch,
        entries: result.entries.map((entry) => ({
          timestamp: entry.timestamp,
          seqStart: entry.seqStart,
          seqEnd: entry.seqEnd,
          item: entry.item
        }))
      })
    }

    return {
      rootAgentId,
      agentPages: [allAgents],
      workspacePages: [[...workspaceById.values()]],
      providerSubagents: [],
      timelines,
      refreshedAt: this.now()
    }
  }

  private async fetchAllAgentPages(): Promise<PaseoAgentSnapshot[][]> {
    const pages: PaseoAgentSnapshot[][] = []
    let cursor: string | undefined
    let firstPage = true
    do {
      const result = await this.client.agents.list({
        filter: { includeArchived: true },
        page: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
        ...(firstPage
          ? { subscribe: this.agentSubscriptionId ? { subscriptionId: this.agentSubscriptionId } : {} }
          : {})
      })
      if (firstPage && result.subscriptionId) this.agentSubscriptionId = result.subscriptionId
      pages.push(result.entries.map(({ agent }) => toAgentSnapshot(agent)))
      cursor = result.pageInfo.nextCursor ?? undefined
      firstPage = false
    } while (cursor)
    return pages
  }

  private async fetchAllWorkspacePages(): Promise<PaseoWorkspaceSnapshot[][]> {
    const pages: PaseoWorkspaceSnapshot[][] = []
    let cursor: string | undefined
    let firstPage = true
    do {
      const result = await this.client.workspaces.list({
        page: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
        ...(firstPage
          ? { subscribe: this.workspaceSubscriptionId ? { subscriptionId: this.workspaceSubscriptionId } : {} }
          : {})
      })
      if (firstPage && result.subscriptionId) this.workspaceSubscriptionId = result.subscriptionId
      pages.push(result.entries.map((workspace) => toWorkspaceSnapshot(workspace, this.now())))
      cursor = result.pageInfo.nextCursor ?? undefined
      firstPage = false
    } while (cursor)
    return pages
  }

  private emit(notification: PaseoAdapterNotification): void {
    for (const listener of this.listeners) listener(notification)
  }
}

function toAgentSnapshot(agent: PaseoAgent): PaseoAgentSnapshot {
  const parentAgentId = agent.labels[PARENT_AGENT_ID_LABEL]?.trim() || null
  return {
    id: agent.id,
    parentAgentId,
    workspaceId: agent.workspaceId ?? null,
    title: agent.title,
    provider: agent.provider,
    model: agent.model,
    status: agent.status,
    cwd: agent.cwd,
    updatedAt: agent.updatedAt
  }
}

function toWorkspaceSnapshot(workspace: PaseoWorkspace, fallbackUpdatedAt: string): PaseoWorkspaceSnapshot {
  return {
    id: workspace.id,
    projectId: workspace.projectId,
    name: workspace.title ?? workspace.name,
    directory: workspace.workspaceDirectory ?? null,
    branch: workspace.gitRuntime?.currentBranch ?? null,
    status: workspace.status,
    updatedAt: workspace.activityAt ?? workspace.statusEnteredAt ?? fallbackUpdatedAt
  }
}

function descendantAgentIds(rootAgentId: string, agents: readonly PaseoAgentSnapshot[]): string[] {
  if (!agents.some(({ id }) => id === rootAgentId)) return []
  const byParent = new Map<string, PaseoAgentSnapshot[]>()
  for (const agent of agents) {
    if (!agent.parentAgentId) continue
    const children = byParent.get(agent.parentAgentId) ?? []
    children.push(agent)
    byParent.set(agent.parentAgentId, children)
  }

  const result: string[] = []
  const seen = new Set<string>()
  const queue = [rootAgentId]
  while (queue.length > 0) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    result.push(id)
    for (const child of byParent.get(id) ?? []) queue.push(child.id)
  }
  return result
}

function mapConnectionState(connection: ConnectionState): {
  state: PaseoConnectionState
  error: string | null
} {
  switch (connection.status) {
    case 'connected':
      return { state: 'connected', error: null }
    case 'idle':
    case 'connecting':
      return { state: 'reconnecting', error: null }
    case 'disconnected':
      return { state: 'stale', error: connection.reason ?? null }
    case 'disposed':
      return { state: 'error', error: 'The Paseo client connection is disposed.' }
  }
}
