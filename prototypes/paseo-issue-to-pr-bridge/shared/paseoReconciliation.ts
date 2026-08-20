import { applyPrototypeCommand } from './commands'
import {
  DEFAULT_CONVERSATION_EXPANSION,
  PASEO_TIMELINE_LIMIT,
  resourceIdentity,
  type ExternalResourceReference,
  type NormalizedConversationEvent,
  type NormalizedConversationEventKind,
  type PaseoManagedAgentRuntime,
  type PaseoNodeRuntime,
  type PaseoProviderSubagentRuntime,
  type PaseoWorkspaceRuntime,
  type PrototypeLedger,
  type PrototypeNode
} from './model'

export type PaseoAgentSnapshot = {
  id: string
  parentAgentId: string | null
  workspaceId: string | null
  title: string | null
  provider: string
  model: string | null
  status: string
  cwd: string
  updatedAt: string
}

export type PaseoWorkspaceSnapshot = {
  id: string
  projectId: string
  name: string
  directory: string | null
  branch: string | null
  status: string
  updatedAt: string
}

export type PaseoTimelineEntry = {
  timestamp: string
  seqStart?: number
  seqEnd?: number
  item: unknown
}

export type PaseoTimelineSnapshot = {
  agentId: string
  epoch: string | null
  entries: PaseoTimelineEntry[]
}

export type PaseoProviderSubagentSnapshot = {
  id: string
  parentAgentId: string
  provider: string
  title: string | null
  status: string
  cwd: string | null
  updatedAt: string
  timeline: PaseoTimelineEntry[]
  timelineEpoch?: string | null
}

export type PaseoAuthoritativeSnapshot = {
  rootAgentId: string
  agentPages: PaseoAgentSnapshot[][]
  workspacePages: PaseoWorkspaceSnapshot[][]
  providerSubagents: PaseoProviderSubagentSnapshot[]
  timelines: PaseoTimelineSnapshot[]
  refreshedAt: string
}

export function reconcilePaseoWorkItem(
  ledger: PrototypeLedger,
  workItemId: string,
  snapshot: PaseoAuthoritativeSnapshot
): PrototypeLedger {
  const workItem = ledger.groups.find(({ id }) => id === workItemId)
  if (workItem?.kind !== 'work-item') throw new Error(`No WorkItem has stable ID “${workItemId}”.`)

  const agents = snapshot.agentPages.flat()
  const workspaces = snapshot.workspacePages.flat()
  const agentById = uniqueById(agents)
  const workspaceById = uniqueById(workspaces)
  const timelineByAgentId = new Map(snapshot.timelines.map((timeline) => [timeline.agentId, timeline]))
  const managedAgents = descendantClosure(snapshot.rootAgentId, agentById)

  let next = markExistingPaseoResourcesMissing(ledger, workItemId)
  const managedNodeByAgentId = new Map<string, PrototypeNode>()
  for (const agent of managedAgents) {
    const timeline = timelineByAgentId.get(agent.id)
    const runtime: PaseoManagedAgentRuntime = {
      type: 'managed-agent',
      state: 'connected',
      parentAgentId: agent.parentAgentId,
      workspaceId: agent.workspaceId,
      provider: agent.provider,
      model: agent.model,
      status: agent.status,
      cwd: agent.cwd,
      timeline: timeline
        ? normalizeTimelineEvents(timeline.entries, timeline.epoch)
        : existingTimeline(next, managedAgentReference(agent.id))
    }
    const result = putPaseoNode(
      next,
      workItemId,
      'agent',
      agent.title ?? `Agent ${agent.id}`,
      managedAgentReference(agent.id, agent.updatedAt),
      runtime
    )
    next = result.ledger
    managedNodeByAgentId.set(agent.id, result.node)
  }

  const referencedWorkspaceIds = new Set(
    managedAgents.flatMap(({ workspaceId }) => (workspaceId ? [workspaceId] : []))
  )
  for (const workspaceId of referencedWorkspaceIds) {
    const workspace = workspaceById.get(workspaceId)
    const runtime: PaseoWorkspaceRuntime = workspace
      ? {
          type: 'workspace',
          state: 'connected',
          projectId: workspace.projectId,
          directory: workspace.directory,
          branch: workspace.branch,
          status: workspace.status
        }
      : {
          type: 'workspace',
          state: 'missing',
          projectId: '',
          directory: null,
          branch: null,
          status: 'missing'
        }
    const existing = findByReference(next, workspaceReference(workspaceId))
    const result = putPaseoNode(
      next,
      workItemId,
      'workspace',
      workspace?.name ?? existing?.title ?? `Workspace ${workspaceId}`,
      workspaceReference(workspaceId, workspace?.updatedAt),
      runtime
    )
    next = result.ledger
  }

  const providerNodeByKey = new Map<string, PrototypeNode>()
  for (const subagent of snapshot.providerSubagents) {
    if (!managedNodeByAgentId.has(subagent.parentAgentId)) continue
    const runtime: PaseoProviderSubagentRuntime = {
      type: 'provider-subagent',
      state: 'connected',
      parentAgentId: subagent.parentAgentId,
      provider: subagent.provider,
      status: subagent.status,
      cwd: subagent.cwd,
      timeline: normalizeTimelineEvents(subagent.timeline, subagent.timelineEpoch ?? null)
    }
    const reference = providerSubagentReference(
      subagent.parentAgentId,
      subagent.id,
      subagent.updatedAt
    )
    const result = putPaseoNode(
      next,
      workItemId,
      'agent',
      subagent.title ?? `Provider subagent ${subagent.id}`,
      reference,
      runtime
    )
    next = result.ledger
    providerNodeByKey.set(`${subagent.parentAgentId}\u0000${subagent.id}`, result.node)
  }

  const desiredDelegatedEdges: Array<[string, string]> = []
  for (const agent of managedAgents) {
    if (!agent.parentAgentId) continue
    const parent = managedNodeByAgentId.get(agent.parentAgentId)
    const child = managedNodeByAgentId.get(agent.id)
    if (parent && child) desiredDelegatedEdges.push([parent.id, child.id])
  }
  for (const subagent of snapshot.providerSubagents) {
    const parent = managedNodeByAgentId.get(subagent.parentAgentId)
    const child = providerNodeByKey.get(`${subagent.parentAgentId}\u0000${subagent.id}`)
    if (parent && child) desiredDelegatedEdges.push([parent.id, child.id])
  }

  next = reconcileDelegatedEdges(next, workItemId, desiredDelegatedEdges)
  return {
    ...next,
    paseo: {
      ...next.paseo,
      connection: 'connected',
      lastRefreshAt: snapshot.refreshedAt,
      error: null
    }
  }
}

export function normalizeTimelineEvents(
  entries: readonly PaseoTimelineEntry[],
  epoch: string | null
): NormalizedConversationEvent[] {
  const byId = new Map<string, NormalizedConversationEvent>()
  for (const entry of entries) {
    const id = timelineEventId(entry, epoch)
    byId.set(id, normalizeTimelineEvent(entry, epoch, id))
  }
  return [...byId.values()].slice(-PASEO_TIMELINE_LIMIT)
}

function normalizeTimelineEvent(
  entry: PaseoTimelineEntry,
  epoch: string | null,
  id: string
): NormalizedConversationEvent {
  const item = isRecord(entry.item) ? entry.item : { type: 'unknown', value: entry.item }
  const kind = conversationKind(item.type)
  const detail = eventDetail(item)
  return {
    id,
    timestamp: entry.timestamp,
    epoch,
    sequenceStart: entry.seqStart ?? null,
    sequenceEnd: entry.seqEnd ?? entry.seqStart ?? null,
    kind,
    summary: eventSummary(kind, item, detail),
    detail,
    initialExpanded: initialExpansion(kind, item)
  }
}

function timelineEventId(entry: PaseoTimelineEntry, epoch: string | null): string {
  if (epoch !== null && entry.seqStart !== undefined) {
    return `seq:${epoch}:${entry.seqStart}:${entry.seqEnd ?? entry.seqStart}`
  }
  return `event:${fingerprint(`${entry.timestamp}\u0000${stableStringify(entry.item)}`)}`
}

function conversationKind(value: unknown): NormalizedConversationEventKind {
  switch (value) {
    case 'user_message':
      return 'user-message'
    case 'assistant_message':
      return 'assistant-message'
    case 'reasoning':
      return 'reasoning'
    case 'tool_call':
      return 'tool-call'
    case 'todo':
      return 'todo'
    case 'error':
      return 'error'
    case 'compaction':
      return 'compaction'
    default:
      return 'unknown'
  }
}

function eventDetail(item: Record<string, unknown>): string {
  if (typeof item.text === 'string') return item.text
  if (typeof item.message === 'string') return item.message
  return stableStringify(item)
}

function eventSummary(
  kind: NormalizedConversationEventKind,
  item: Record<string, unknown>,
  detail: string
): string {
  if (kind === 'tool-call' && typeof item.name === 'string') return item.name
  if (kind === 'todo') return 'Task update'
  if (kind === 'compaction') return 'Conversation compacted'
  const compact = detail.replace(/\s+/g, ' ').trim()
  return compact.length > 80 ? `${compact.slice(0, 77)}…` : compact || kind
}

function initialExpansion(
  kind: NormalizedConversationEventKind,
  item: Record<string, unknown>
): boolean {
  if (kind === 'reasoning') return DEFAULT_CONVERSATION_EXPANSION.thinking
  if (kind !== 'tool-call') return true

  const detail = isRecord(item.detail) ? item.detail : null
  const detailType = detail?.type
  if (detailType === 'read' || detailType === 'file_read') {
    return DEFAULT_CONVERSATION_EXPANSION.read
  }
  if (detailType === 'diff') return DEFAULT_CONVERSATION_EXPANSION.diff
  if (detailType === 'html') return DEFAULT_CONVERSATION_EXPANSION.html
  return DEFAULT_CONVERSATION_EXPANSION.toolCall
}

function descendantClosure(
  rootAgentId: string,
  agentById: ReadonlyMap<string, PaseoAgentSnapshot>
): PaseoAgentSnapshot[] {
  const root = agentById.get(rootAgentId)
  if (!root) return []

  const result: PaseoAgentSnapshot[] = []
  const included = new Set<string>()
  const queue = [root]
  while (queue.length > 0) {
    const current = queue.shift()!
    if (included.has(current.id)) continue
    included.add(current.id)
    result.push(current)
    for (const candidate of agentById.values()) {
      if (candidate.parentAgentId === current.id && !included.has(candidate.id)) queue.push(candidate)
    }
  }
  return result
}

function markExistingPaseoResourcesMissing(
  ledger: PrototypeLedger,
  workItemId: string
): PrototypeLedger {
  return {
    ...ledger,
    nodes: ledger.nodes.map((node) => {
      if (node.workItemId !== workItemId || node.paseo === null) return node
      return { ...node, paseo: { ...node.paseo, state: 'missing' } }
    })
  }
}

function putPaseoNode(
  ledger: PrototypeLedger,
  workItemId: string,
  kind: 'agent' | 'workspace',
  title: string,
  resourceRef: ExternalResourceReference,
  paseo: PaseoNodeRuntime
): { ledger: PrototypeLedger; node: PrototypeNode } {
  const placed = applyPrototypeCommand(ledger, {
    type: 'attach-placeholder',
    targetGroup: workItemId,
    nodeKind: kind,
    title,
    resourceRef
  }).ledger
  const node = placed.nodes.find(
    ({ resourceRef: candidate }) => resourceIdentity(candidate) === resourceIdentity(resourceRef)
  )!
  const updatedNode = { ...node, paseo }
  return {
    ledger: {
      ...placed,
      nodes: placed.nodes.map((candidate) => (candidate.id === node.id ? updatedNode : candidate))
    },
    node: updatedNode
  }
}

function reconcileDelegatedEdges(
  ledger: PrototypeLedger,
  workItemId: string,
  desiredPairs: readonly [string, string][]
): PrototypeLedger {
  const desired = new Set(desiredPairs.map(([from, to]) => `${from}\u0000${to}`))
  const nodeById = new Map(ledger.nodes.map((node) => [node.id, node]))
  let next: PrototypeLedger = {
    ...ledger,
    edges: ledger.edges.filter((edge) => {
      if (edge.relation !== 'delegated') return true
      const target = nodeById.get(edge.toNodeId)
      if (target?.workItemId !== workItemId) return true
      if (target.paseo?.state === 'missing') return true
      return desired.has(`${edge.fromNodeId}\u0000${edge.toNodeId}`)
    })
  }

  for (const [fromNodeId, toNodeId] of desiredPairs) {
    next = applyPrototypeCommand(next, {
      type: 'connect-nodes',
      fromNodeId,
      toNodeId,
      relation: 'delegated'
    }).ledger
  }
  return next
}

function existingTimeline(
  ledger: PrototypeLedger,
  reference: ExternalResourceReference
): NormalizedConversationEvent[] {
  const runtime = findByReference(ledger, reference)?.paseo
  return runtime && runtime.type !== 'workspace' ? runtime.timeline : []
}

function findByReference(
  ledger: PrototypeLedger,
  reference: ExternalResourceReference
): PrototypeNode | undefined {
  const identity = resourceIdentity(reference)
  return ledger.nodes.find(({ resourceRef }) => resourceIdentity(resourceRef) === identity)
}

function managedAgentReference(id: string, revision?: string): ExternalResourceReference {
  return { provider: 'paseo', kind: 'agent', id, revision: revision ?? null }
}

function providerSubagentReference(
  parentAgentId: string,
  id: string,
  revision?: string
): ExternalResourceReference {
  return {
    provider: 'paseo',
    kind: `provider-subagent:${parentAgentId}`,
    id,
    revision: revision ?? null
  }
}

function workspaceReference(id: string, revision?: string): ExternalResourceReference {
  return { provider: 'paseo', kind: 'workspace', id, revision: revision ?? null }
}

function uniqueById<T extends { id: string }>(values: readonly T[]): Map<string, T> {
  return new Map(values.map((value) => [value.id, value]))
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

function fingerprint(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
