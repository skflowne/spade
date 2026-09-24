import { type ConnectionState, type PaseoAgent, type PaseoWorkspace } from '@getpaseo/client'
import { DaemonClient } from '@getpaseo/client/internal/daemon-client'
import { CheckoutAdapterError, type CheckoutMutationOutcome } from './spadePaseoCheckout'
import type {
  CheckoutCommitResult,
  CheckoutPullRequestIdentity,
  CheckoutPullRequestStatus,
  CheckoutPushResult,
  CheckoutStatus,
  CreateCheckoutPullRequestInput
} from '../shared/checkout'
import { PASEO_TIMELINE_LIMIT, type PaseoConnectionState } from '../shared/model'
import {
  type PaseoAgentSnapshot,
  type PaseoAuthoritativeSnapshot,
  type PaseoTimelineSnapshot,
  type PaseoWorkspaceSnapshot
} from '../shared/paseoReconciliation'

const PAGE_LIMIT = 200
const PARENT_AGENT_ID_LABEL = 'paseo.parent-agent-id'

type DriverMethod =
  | 'connect'
  | 'close'
  | 'getConnectionState'
  | 'on'
  | 'fetchAgents'
  | 'observeAgents'
  | 'observeWorkspaces'
  | 'observeEvents'
  | 'fetchAgent'
  | 'fetchAgentTimeline'
  | 'createAgent'
  | 'archiveAgent'
  | 'fetchWorkspaces'
  | 'openProject'
  | 'createWorkspace'
  | 'getProvidersSnapshot'
  | 'getLastServerInfoMessage'
  | 'getCheckoutStatus'
  | 'getCheckoutDiff'
  | 'listCheckoutCommits'
  | 'checkoutCommit'
  | 'checkoutPush'
  | 'checkoutPrCreate'
  | 'checkoutPrStatus'

export type PaseoDaemonDriver = Pick<DaemonClient, DriverMethod>

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
  driver?: PaseoDaemonDriver
  pollIntervalMs?: number
  now?: () => string
}

// Daemons hide agents from providers other than claude/codex/opencode unless the session
// sends the all_providers capability (client >= 0.9) or an appVersion parsing as semver
// >= 0.1.45, so appVersion must stay a version, not a name.
export const PASEO_CLIENT_APP_VERSION = '0.9.2'
const PROVIDER_READY_TIMEOUT_MS = 60_000
const PROVIDER_READY_POLL_MS = 250

export function daemonClientOptions(url: string): ConstructorParameters<typeof DaemonClient>[0] {
  return {
    url,
    clientId: 'spade-p3-prototype',
    clientType: 'cli',
    appVersion: PASEO_CLIENT_APP_VERSION,
    reconnect: { enabled: true }
  }
}

export class SpadePaseoAdapter {
  readonly url: string
  private readonly driver: PaseoDaemonDriver
  private readonly pollIntervalMs: number
  private readonly now: () => string
  private readonly listeners = new Set<(notification: PaseoAdapterNotification) => void>()
  private cleanupDriverSubscriptions: (() => void) | null = null
  private connectionTimer: ReturnType<typeof setInterval> | null = null
  private lastConnectionState: PaseoConnectionState | null = null
  private observations: Array<{ ready: Promise<unknown>; release(): Promise<void> }> = []

  constructor(options: SpadePaseoAdapterOptions) {
    this.url = options.url
    this.driver = options.driver ?? new DaemonClient(daemonClientOptions(options.url))
    this.pollIntervalMs = options.pollIntervalMs ?? 500
    this.now = options.now ?? (() => new Date().toISOString())
  }

  subscribe(listener: (notification: PaseoAdapterNotification) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async connect(): Promise<void> {
    if (!this.cleanupDriverSubscriptions) {
      const unsubscribeAgent = this.driver.on('agent_update', () => this.emit({ type: 'refresh' }))
      const unsubscribeWorkspace = this.driver.on('workspace_update', () => this.emit({ type: 'refresh' }))
      const unsubscribeProvider = this.driver.on('providers_snapshot_update', () => this.emit({ type: 'refresh' }))
      this.cleanupDriverSubscriptions = () => {
        unsubscribeAgent()
        unsubscribeWorkspace()
        unsubscribeProvider()
      }
    }

    await this.driver.connect()
    if (this.observations.length === 0) {
      // Daemons send agent, workspace, and provider updates only while an owned subscription is open.
      this.observations = [
        this.driver.observeAgents({ filter: { includeArchived: true }, page: { limit: 1 } }),
        this.driver.observeWorkspaces({ page: { limit: 1 } }),
        this.driver.observeEvents(['providers_snapshot_update'])
      ]
      await Promise.all(this.observations.map(({ ready }) => ready))
    }
    this.pollConnectionState()
    if (!this.connectionTimer && this.pollIntervalMs > 0) {
      this.connectionTimer = setInterval(() => this.pollConnectionState(), this.pollIntervalMs)
      this.connectionTimer.unref?.()
    }
  }

  async close(): Promise<void> {
    if (this.connectionTimer) clearInterval(this.connectionTimer)
    this.connectionTimer = null
    this.cleanupDriverSubscriptions?.()
    this.cleanupDriverSubscriptions = null
    const observations = this.observations
    this.observations = []
    await Promise.allSettled(observations.map((observation) => observation.release()))
    await this.driver.close()
  }

  pollConnectionState(): PaseoConnectionState {
    const connection = mapConnectionState(this.driver.getConnectionState())
    if (connection.state !== this.lastConnectionState) {
      this.lastConnectionState = connection.state
      this.emit({ type: 'connection', ...connection })
    }
    return connection.state
  }

  async openProjectCheckout(cwd: string): Promise<PaseoWorkspaceSnapshot> {
    const result = await this.driver.openProject(cwd)
    if (result.error || !result.workspace) {
      throw new Error(result.error ?? `Paseo did not return the workspace opened for ${cwd}.`)
    }
    return toWorkspaceSnapshot(result.workspace, this.now())
  }

  async createWorkspace(cwd: string, title?: string): Promise<PaseoWorkspaceSnapshot> {
    const result = await this.driver.createWorkspace({
      source: { kind: 'directory', path: cwd },
      ...(title ? { title } : {})
    })
    if (result.error || !result.workspace) {
      throw new Error(result.error ?? `Paseo did not return the workspace created for ${cwd}.`)
    }
    return toWorkspaceSnapshot(result.workspace, this.now())
  }

  async attachWorkspace(workspaceId: string): Promise<PaseoWorkspaceSnapshot | null> {
    const workspace = await this.fetchWorkspaceById(workspaceId)
    return workspace ? toWorkspaceSnapshot(workspace, this.now()) : null
  }

  async spawnAgent(input: SpawnAgentInput): Promise<PaseoAgentSnapshot> {
    let cwd = input.cwd
    if (input.workspaceId) {
      const workspace = await this.requireWorkspace(input.workspaceId)
      cwd = workspace.workspaceDirectory
    }
    await waitForProviderReady(this.driver, cwd, input.provider)
    const created = await this.driver.createAgent({
      config: {
        provider: input.provider,
        model: input.model,
        cwd,
        ...(input.title ? { title: input.title } : {})
      },
      cwd,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.parentAgentId ? { callerAgentId: input.parentAgentId } : {}),
      initialPrompt: input.prompt
    })
    return toAgentSnapshot(created)
  }

  async attachAgent(agentId: string): Promise<PaseoAgentSnapshot | null> {
    const result = await this.driver.fetchAgent(agentId)
    return result ? toAgentSnapshot(result.agent) : null
  }

  async archiveAgent(agentId: string): Promise<string> {
    return (await this.driver.archiveAgent(agentId)).archivedAt
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
      if (agentById.has(agentId)) continue
      const result = await this.driver.fetchAgent(agentId)
      if (result) agentById.set(agentId, toAgentSnapshot(result.agent))
    }
    for (const workspaceId of new Set(references.workspaceIds)) {
      const workspace = await this.fetchWorkspaceById(workspaceId)
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
      const result = await this.driver.fetchAgentTimeline(agentId, {
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

  async checkoutStatus(workspaceId: string): Promise<CheckoutStatus> {
    const workspace = await this.requireWorkspace(workspaceId)
    const cwd = workspace.workspaceDirectory
    const [status, diff, commits] = await Promise.all([
      this.driver.getCheckoutStatus(cwd),
      this.driver.getCheckoutDiff(cwd, { mode: 'uncommitted' }),
      this.driver.listCheckoutCommits(cwd)
    ])
    requireCheckoutCwd(status.cwd, cwd, 'check')
    requireCheckoutCwd(diff.cwd, cwd, 'check')
    if (status.error) throw new CheckoutAdapterError('check', status.error.message)
    if (!status.isGit) throw new CheckoutAdapterError('check', 'Selected Paseo workspace is not a Git checkout.')
    if (diff.error) throw new CheckoutAdapterError('check', diff.error.message)
    if (diff.diffTooLarge) {
      throw new CheckoutAdapterError('check', 'Paseo could not return complete checkout diff totals.')
    }

    return {
      workspaceId,
      branch: status.currentBranch,
      headRevision: latestCheckoutRevision(commits.commits),
      baseRef: status.baseRef,
      changedFiles: diff.files.length,
      additions: sum(diff.files.map(({ additions }) => additions)),
      deletions: sum(diff.files.map(({ deletions }) => deletions)),
      stagedFiles: null,
      unstagedFiles: null,
      untrackedFiles: null,
      conflicts: null
    }
  }

  async checkoutCommit(workspaceId: string, message: string): Promise<CheckoutMutationOutcome<CheckoutCommitResult>> {
    const cwd = (await this.requireWorkspace(workspaceId)).workspaceDirectory
    const trimmedMessage = message.trim()
    if (!trimmedMessage) throw new CheckoutAdapterError('mutation', 'Commit message is required.')
    const result = await this.driver.checkoutCommit(cwd, { message: trimmedMessage, addAll: true })
    requireCheckoutMutation(result, cwd)
    try {
      const commits = await this.driver.listCheckoutCommits(cwd)
      const revision = latestCheckoutRevision(commits.commits)
      if (!revision) throw new Error('Paseo returned no revision.')
      return { result: { revision }, warning: null }
    } catch (error) {
      return { result: null, warning: checkoutObservationWarning('committed', 'revision', error) }
    }
  }

  async checkoutPush(workspaceId: string): Promise<CheckoutMutationOutcome<CheckoutPushResult>> {
    const cwd = (await this.requireWorkspace(workspaceId)).workspaceDirectory
    const result = await this.driver.checkoutPush(cwd)
    requireCheckoutMutation(result, cwd)
    try {
      const status = await this.driver.getCheckoutStatus(cwd)
      requireCheckoutCwd(status.cwd, cwd, 'check')
      if (status.error) throw new CheckoutAdapterError('check', status.error.message)
      if (!status.isGit || !status.currentBranch) {
        throw new CheckoutAdapterError('check', 'Paseo returned no pushed branch.')
      }
      return {
        result: {
          remote: upstreamRemote(status.upstreamRef),
          branch: status.currentBranch
        },
        warning: null
      }
    } catch (error) {
      return { result: null, warning: checkoutObservationWarning('pushed', 'remote branch', error) }
    }
  }

  async checkoutCreatePullRequest(
    workspaceId: string,
    input: CreateCheckoutPullRequestInput
  ): Promise<CheckoutPullRequestIdentity> {
    const cwd = (await this.requireWorkspace(workspaceId)).workspaceDirectory
    const result = await this.driver.checkoutPrCreate(cwd, {
      title: input.title,
      body: input.body,
      ...(input.baseBranch ? { baseRef: input.baseBranch } : {})
    })
    requireCheckoutCwd(result.cwd, cwd, 'mutation')
    if (result.error) throw new CheckoutAdapterError('mutation', result.error.message)
    if (!result.url || !result.number) {
      throw new CheckoutAdapterError('mutation', 'Paseo created no pull-request identity.')
    }
    return parseGitHubPullRequest(result.url, result.number, 'mutation')
  }

  async checkoutPullRequestStatus(workspaceId: string): Promise<CheckoutPullRequestStatus> {
    const cwd = (await this.requireWorkspace(workspaceId)).workspaceDirectory
    const result = await this.driver.checkoutPrStatus(cwd)
    requireCheckoutCwd(result.cwd, cwd, 'check')
    if (result.error) throw new CheckoutAdapterError('check', result.error.message)
    if (!result.status) return { pullRequest: null, state: null }
    if (!result.status.number) {
      throw new CheckoutAdapterError('check', 'Paseo returned pull-request status without a number.')
    }
    return {
      pullRequest: parseGitHubPullRequest(result.status.url, result.status.number, 'check'),
      state: pullRequestState(result.status.state, result.status.isMerged)
    }
  }

  private async fetchAllAgentPages(): Promise<PaseoAgentSnapshot[][]> {
    const pages: PaseoAgentSnapshot[][] = []
    let cursor: string | undefined
    do {
      const result = await this.driver.fetchAgents({
        filter: { includeArchived: true },
        page: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) }
      })
      pages.push(result.entries.map(({ agent }) => toAgentSnapshot(agent)))
      cursor = result.pageInfo.nextCursor ?? undefined
    } while (cursor)
    return pages
  }

  private async fetchAllWorkspacePages(): Promise<PaseoWorkspaceSnapshot[][]> {
    const pages: PaseoWorkspaceSnapshot[][] = []
    let cursor: string | undefined
    do {
      const result = await this.driver.fetchWorkspaces({
        page: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) }
      })
      pages.push(result.entries.map((workspace) => toWorkspaceSnapshot(workspace, this.now())))
      cursor = result.pageInfo.nextCursor ?? undefined
    } while (cursor)
    return pages
  }

  private async fetchWorkspaceById(workspaceId: string): Promise<PaseoWorkspace | null> {
    let cursor: string | undefined
    do {
      const result = await this.driver.fetchWorkspaces({
        page: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) }
      })
      const workspace = result.entries.find(({ id }) => id === workspaceId)
      if (workspace) return workspace
      cursor = result.pageInfo.nextCursor ?? undefined
    } while (cursor)
    return null
  }

  private async requireWorkspace(workspaceId: string): Promise<PaseoWorkspace & { workspaceDirectory: string }> {
    const workspace = await this.fetchWorkspaceById(workspaceId)
    if (!workspace?.workspaceDirectory) {
      throw new CheckoutAdapterError(
        'missing-workspace',
        `Paseo workspace ${workspaceId} is missing or has no checkout directory.`
      )
    }
    return workspace as PaseoWorkspace & { workspaceDirectory: string }
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

// Client 0.9 routes providers_snapshot_update only to owned subscriptions, so readiness is
// polled; only the provider being spawned has to finish discovery.
async function waitForProviderReady(driver: PaseoDaemonDriver, cwd: string, provider: string): Promise<void> {
  if (driver.getLastServerInfoMessage()?.features?.providersSnapshotCwd !== true) {
    throw new Error('Update the host to wait for provider discovery.')
  }
  const deadline = Date.now() + PROVIDER_READY_TIMEOUT_MS
  for (;;) {
    const snapshot = await driver.getProvidersSnapshot({ cwd })
    const status = snapshot.entries.find((entry) => entry.provider === provider)?.status
    if (status && status !== 'loading') return
    if (Date.now() >= deadline) {
      throw new Error(status ? `Timed out waiting for provider: ${provider}` : `Provider is not registered: ${provider}`)
    }
    await new Promise((resolve) => setTimeout(resolve, PROVIDER_READY_POLL_MS))
  }
}

function requireCheckoutCwd(
  actual: string,
  expected: string,
  kind: 'check' | 'mutation'
): void {
  if (actual !== expected) {
    throw new CheckoutAdapterError(kind, 'Paseo returned checkout data for a different directory.')
  }
}

function checkoutObservationWarning(
  action: string,
  detail: string,
  error: unknown
): CheckoutAdapterError {
  const message = error instanceof Error ? error.message : 'Paseo returned an invalid response.'
  return new CheckoutAdapterError(
    'check',
    `Paseo ${action} the checkout, but SPADE could not read the resulting ${detail}: ${message}`
  )
}

function requireCheckoutMutation(
  result: { cwd: string; success: boolean; error: { message: string } | null },
  cwd: string
): void {
  requireCheckoutCwd(result.cwd, cwd, 'mutation')
  if (result.error) throw new CheckoutAdapterError('mutation', result.error.message)
  if (!result.success) throw new CheckoutAdapterError('mutation', 'Paseo checkout mutation failed.')
}

function latestCheckoutRevision(
  commits: readonly { sha: string; isOnBase?: boolean }[]
): string | null {
  return commits[0]?.sha ?? null
}

function parseGitHubPullRequest(
  value: string,
  number: number,
  kind: 'check' | 'mutation'
): CheckoutPullRequestIdentity {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new CheckoutAdapterError(kind, 'Paseo returned an invalid pull-request URL.')
  }
  const hostname = url.hostname.toLowerCase()
  const match = hostname === 'github.com'
    ? /^\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(url.pathname)
    : hostname === 'api.github.com'
      ? /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/.exec(url.pathname)
      : null
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !match ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(match[1]) ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(match[2]) ||
    Number(match[3]) !== number
  ) {
    throw new CheckoutAdapterError(kind, 'Paseo returned a mismatched pull-request identity.')
  }
  const repository = `${match[1]}/${match[2]}`.toLowerCase()
  return {
    repository,
    number,
    url: `https://github.com/${repository}/pull/${number}`
  }
}

function pullRequestState(state: string, isMerged: boolean): CheckoutPullRequestStatus['state'] {
  if (isMerged) return 'MERGED'
  const normalized = state.toUpperCase()
  if (normalized === 'OPEN' || normalized === 'CLOSED') return normalized
  throw new CheckoutAdapterError('check', `Paseo returned unknown pull-request state “${state}”.`)
}

function upstreamRemote(upstreamRef: string | null | undefined): string | null {
  if (!upstreamRef) return null
  const normalized = upstreamRef.startsWith('refs/remotes/')
    ? upstreamRef.slice('refs/remotes/'.length)
    : upstreamRef
  const separator = normalized.indexOf('/')
  return separator > 0 ? normalized.slice(0, separator) : null
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0)
}
