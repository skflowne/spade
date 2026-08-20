export const PROTOTYPE_LEDGER_VERSION = 2 as const
export const PASEO_TIMELINE_LIMIT = 40

export type Point = { x: number; y: number }
export type Size = { width: number; height: number }

export type ExternalResourceReference = {
  provider: string
  kind: string
  id: string
  revision: string | null
}

export type ProjectRecord = {
  id: string
  name: string
}

export type GroupContainer = {
  id: string
  projectId: string
  name: string
  position: Point
}

export type Group = GroupContainer & {
  kind: 'group'
}

export type WorkItemStatus = 'active' | 'blocked' | 'review' | 'done'

export function isWorkItemStatus(value: unknown): value is WorkItemStatus {
  return typeof value === 'string' && ['active', 'blocked', 'review', 'done'].includes(value)
}

export type WorkItem = GroupContainer & {
  kind: 'work-item'
  task: string
  sourceRef: ExternalResourceReference | null
  status: WorkItemStatus
}

export type PrototypeGroup = Group | WorkItem
export type PlaceholderKind = 'agent' | 'workspace'
export type PaseoResourceState = 'connected' | 'reconnecting' | 'stale' | 'missing' | 'error'
export type PaseoConnectionState = 'connected' | 'reconnecting' | 'stale' | 'error'
export type PaseoCapabilityState = 'available' | 'unavailable' | 'error'
export type PaseoCapabilityName =
  | 'agents'
  | 'workspaces'
  | 'providers'
  | 'timeline-fetch'
  | 'agent-workspace-subscriptions'
  | 'provider-subagents'
  | 'live-timeline'
  | 'server-info'

export type PaseoCapability = {
  name: PaseoCapabilityName
  state: PaseoCapabilityState
  detail: string | null
}

export type PaseoWorkItemBinding = {
  workItemId: string
  rootAgentId: string
}

export type PaseoAdapterState = {
  connection: PaseoConnectionState
  daemonUrl: string | null
  lastRefreshAt: string | null
  error: string | null
  capabilities: PaseoCapability[]
  bindings: PaseoWorkItemBinding[]
}

export type ConversationExpansionPreferences = {
  toolCall: boolean
  diff: boolean
  html: boolean
  thinking: boolean
  read: boolean
}

export const DEFAULT_CONVERSATION_EXPANSION: ConversationExpansionPreferences = {
  toolCall: true,
  diff: true,
  html: true,
  thinking: true,
  read: false
}

export type NormalizedConversationEventKind =
  | 'user-message'
  | 'assistant-message'
  | 'reasoning'
  | 'tool-call'
  | 'todo'
  | 'error'
  | 'compaction'
  | 'unknown'

export type NormalizedConversationEvent = {
  id: string
  timestamp: string
  epoch: string | null
  sequenceStart: number | null
  sequenceEnd: number | null
  kind: NormalizedConversationEventKind
  summary: string
  detail: string
  initialExpanded: boolean
}

export type PaseoManagedAgentRuntime = {
  type: 'managed-agent'
  state: PaseoResourceState
  parentAgentId: string | null
  workspaceId: string | null
  provider: string
  model: string | null
  status: string
  cwd: string
  timeline: NormalizedConversationEvent[]
}

export type PaseoProviderSubagentRuntime = {
  type: 'provider-subagent'
  state: PaseoResourceState
  parentAgentId: string
  provider: string
  status: string
  cwd: string | null
  timeline: NormalizedConversationEvent[]
}

export type PaseoWorkspaceRuntime = {
  type: 'workspace'
  state: PaseoResourceState
  projectId: string
  directory: string | null
  branch: string | null
  status: string
}

export type PaseoNodeRuntime =
  | PaseoManagedAgentRuntime
  | PaseoProviderSubagentRuntime
  | PaseoWorkspaceRuntime

export type PrototypeNode = {
  id: string
  projectId: string
  groupId: string | null
  workItemId: string | null
  kind: PlaceholderKind
  title: string
  position: Point
  resourceRef: ExternalResourceReference
  paseo: PaseoNodeRuntime | null
}

export type ProvenanceRelation = 'spawned' | 'attached' | 'connected' | 'delegated'

export function isProvenanceRelation(value: unknown): value is ProvenanceRelation {
  return (
    typeof value === 'string' &&
    ['spawned', 'attached', 'connected', 'delegated'].includes(value)
  )
}

export type PrototypeEdge = {
  id: string
  fromNodeId: string
  toNodeId: string
  relation: ProvenanceRelation
}

export type PrototypeLedger = {
  version: typeof PROTOTYPE_LEDGER_VERSION
  nextSequence: number
  project: ProjectRecord
  groups: PrototypeGroup[]
  nodes: PrototypeNode[]
  edges: PrototypeEdge[]
  paseo: PaseoAdapterState
}

export function createInitialPaseoState(): PaseoAdapterState {
  return {
    connection: 'stale',
    daemonUrl: null,
    lastRefreshAt: null,
    error: null,
    capabilities: [
      capability('agents', 'available'),
      capability('workspaces', 'available'),
      capability('providers', 'available'),
      capability('timeline-fetch', 'available'),
      capability('agent-workspace-subscriptions', 'available'),
      capability(
        'provider-subagents',
        'unavailable',
        '@getpaseo/client 0.4.0 exposes provider-subagent RPCs only through its internal client.'
      ),
      capability(
        'live-timeline',
        'unavailable',
        '@getpaseo/client 0.4.0 cannot activate timeline streaming through its public facade.'
      ),
      capability(
        'server-info',
        'unavailable',
        '@getpaseo/client 0.4.0 does not expose server version or feature metadata publicly.'
      )
    ],
    bindings: []
  }
}

function capability(
  name: PaseoCapabilityName,
  state: PaseoCapabilityState,
  detail: string | null = null
): PaseoCapability {
  return { name, state, detail }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasString(record: Record<string, unknown>, key: string): boolean {
  return typeof record[key] === 'string'
}

function isPoint(value: unknown): value is Point {
  return isRecord(value) && Number.isFinite(value.x) && Number.isFinite(value.y)
}

function isResourceReference(value: unknown): value is ExternalResourceReference {
  return (
    isRecord(value) &&
    hasString(value, 'provider') &&
    hasString(value, 'kind') &&
    hasString(value, 'id') &&
    (value.revision === null || typeof value.revision === 'string')
  )
}

function isGroup(value: unknown): value is PrototypeGroup {
  if (
    !isRecord(value) ||
    !hasString(value, 'id') ||
    !hasString(value, 'projectId') ||
    !hasString(value, 'name') ||
    !isPoint(value.position)
  ) {
    return false
  }

  if (value.kind === 'group') return true
  return (
    value.kind === 'work-item' &&
    hasString(value, 'task') &&
    (value.sourceRef === null || isResourceReference(value.sourceRef)) &&
    isWorkItemStatus(value.status)
  )
}

function isConversationEvent(value: unknown): value is NormalizedConversationEvent {
  return (
    isRecord(value) &&
    hasString(value, 'id') &&
    hasString(value, 'timestamp') &&
    (value.epoch === null || typeof value.epoch === 'string') &&
    (value.sequenceStart === null || Number.isFinite(value.sequenceStart)) &&
    (value.sequenceEnd === null || Number.isFinite(value.sequenceEnd)) &&
    typeof value.kind === 'string' &&
    [
      'user-message',
      'assistant-message',
      'reasoning',
      'tool-call',
      'todo',
      'error',
      'compaction',
      'unknown'
    ].includes(value.kind) &&
    hasString(value, 'summary') &&
    hasString(value, 'detail') &&
    typeof value.initialExpanded === 'boolean'
  )
}

function isTimeline(value: unknown): value is NormalizedConversationEvent[] {
  return (
    Array.isArray(value) &&
    value.length <= PASEO_TIMELINE_LIMIT &&
    value.every(isConversationEvent) &&
    hasUniqueValues(value.map(({ id }) => id))
  )
}

function isPaseoRuntime(value: unknown): value is PaseoNodeRuntime {
  if (!isRecord(value) || !isPaseoResourceState(value.state) || typeof value.type !== 'string') {
    return false
  }

  if (value.type === 'workspace') {
    return (
      hasString(value, 'projectId') &&
      (value.directory === null || typeof value.directory === 'string') &&
      (value.branch === null || typeof value.branch === 'string') &&
      hasString(value, 'status')
    )
  }

  if (!hasString(value, 'provider') || !hasString(value, 'status') || !isTimeline(value.timeline)) {
    return false
  }

  if (value.type === 'managed-agent') {
    return (
      (value.parentAgentId === null || typeof value.parentAgentId === 'string') &&
      (value.workspaceId === null || typeof value.workspaceId === 'string') &&
      (value.model === null || typeof value.model === 'string') &&
      hasString(value, 'cwd')
    )
  }

  return (
    value.type === 'provider-subagent' &&
    hasString(value, 'parentAgentId') &&
    (value.cwd === null || typeof value.cwd === 'string')
  )
}

function isPaseoResourceState(value: unknown): value is PaseoResourceState {
  return (
    typeof value === 'string' &&
    ['connected', 'reconnecting', 'stale', 'missing', 'error'].includes(value)
  )
}

function isNode(value: unknown): value is PrototypeNode {
  return (
    isRecord(value) &&
    hasString(value, 'id') &&
    hasString(value, 'projectId') &&
    (value.groupId === null || typeof value.groupId === 'string') &&
    (value.workItemId === null || typeof value.workItemId === 'string') &&
    (value.kind === 'agent' || value.kind === 'workspace') &&
    hasString(value, 'title') &&
    isPoint(value.position) &&
    isResourceReference(value.resourceRef) &&
    (value.paseo === null || isPaseoRuntime(value.paseo))
  )
}

function isEdge(value: unknown): value is PrototypeEdge {
  return (
    isRecord(value) &&
    hasString(value, 'id') &&
    hasString(value, 'fromNodeId') &&
    hasString(value, 'toNodeId') &&
    isProvenanceRelation(value.relation)
  )
}

function isPaseoAdapterState(value: unknown): value is PaseoAdapterState {
  return (
    isRecord(value) &&
    typeof value.connection === 'string' &&
    ['connected', 'reconnecting', 'stale', 'error'].includes(value.connection) &&
    (value.daemonUrl === null || typeof value.daemonUrl === 'string') &&
    (value.lastRefreshAt === null || typeof value.lastRefreshAt === 'string') &&
    (value.error === null || typeof value.error === 'string') &&
    Array.isArray(value.capabilities) &&
    value.capabilities.length === 8 &&
    value.capabilities.every(isCapability) &&
    hasUniqueValues(value.capabilities.map(({ name }) => name)) &&
    Array.isArray(value.bindings) &&
    value.bindings.every(isWorkItemBinding) &&
    hasUniqueValues(value.bindings.map(({ workItemId }) => workItemId))
  )
}

function isWorkItemBinding(value: unknown): value is PaseoWorkItemBinding {
  return isRecord(value) && hasString(value, 'workItemId') && hasString(value, 'rootAgentId')
}

function isCapability(value: unknown): value is PaseoCapability {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    [
      'agents',
      'workspaces',
      'providers',
      'timeline-fetch',
      'agent-workspace-subscriptions',
      'provider-subagents',
      'live-timeline',
      'server-info'
    ].includes(value.name) &&
    typeof value.state === 'string' &&
    ['available', 'unavailable', 'error'].includes(value.state) &&
    (value.detail === null || typeof value.detail === 'string')
  )
}

export function isPrototypeLedger(value: unknown): value is PrototypeLedger {
  if (
    !isRecord(value) ||
    value.version !== PROTOTYPE_LEDGER_VERSION ||
    !Number.isSafeInteger(value.nextSequence) ||
    Number(value.nextSequence) < 1 ||
    !isRecord(value.project) ||
    !hasString(value.project, 'id') ||
    !hasString(value.project, 'name') ||
    !Array.isArray(value.groups) ||
    !value.groups.every(isGroup) ||
    !Array.isArray(value.nodes) ||
    !value.nodes.every(isNode) ||
    !Array.isArray(value.edges) ||
    !value.edges.every(isEdge) ||
    !isPaseoAdapterState(value.paseo)
  ) {
    return false
  }

  const project = value.project
  const nextSequence = Number(value.nextSequence)
  const groupById = new Map(value.groups.map((group) => [group.id, group]))
  const nodeIds = new Set(value.nodes.map((node) => node.id))
  const allIds = [
    ...value.groups.map(({ id }) => id),
    ...value.nodes.map(({ id }) => id),
    ...value.edges.map(({ id }) => id)
  ]
  const resourceKeys = value.nodes.map(({ resourceRef }) => resourceIdentity(resourceRef))
  const edgeKeys = value.edges.map(
    ({ fromNodeId, toNodeId, relation }) => `${fromNodeId}\u0000${toNodeId}\u0000${relation}`
  )

  return (
    hasUniqueValues(allIds) &&
    hasUniqueValues(resourceKeys) &&
    hasUniqueValues(edgeKeys) &&
    nextSequence > maximumGeneratedSequence(allIds) &&
    value.groups.every((group) => group.projectId === project.id) &&
    value.paseo.bindings.every(({ workItemId }) => groupById.get(workItemId)?.kind === 'work-item') &&
    value.nodes.every((node) => {
      const workItem = node.workItemId === null ? null : groupById.get(node.workItemId)
      return (
        node.projectId === project.id &&
        (node.groupId === null || groupById.has(node.groupId)) &&
        (node.workItemId === null || workItem?.kind === 'work-item') &&
        (node.paseo?.type !== 'workspace' || node.kind === 'workspace') &&
        (node.paseo === null || node.paseo.type === 'workspace' || node.kind === 'agent')
      )
    }) &&
    value.edges.every((edge) => nodeIds.has(edge.fromNodeId) && nodeIds.has(edge.toNodeId))
  )
}

export function migratePrototypeLedger(value: unknown): PrototypeLedger | null {
  if (isPrototypeLedger(value)) return value
  if (!isVersionOneLedger(value)) return null

  const migrated: PrototypeLedger = {
    version: PROTOTYPE_LEDGER_VERSION,
    nextSequence: Number(value.nextSequence),
    project: structuredClone(value.project) as ProjectRecord,
    groups: structuredClone(value.groups) as PrototypeGroup[],
    nodes: (structuredClone(value.nodes) as Array<Omit<PrototypeNode, 'paseo'>>).map((node) => ({
      ...node,
      paseo: null
    })),
    edges: structuredClone(value.edges) as PrototypeEdge[],
    paseo: createInitialPaseoState()
  }
  return isPrototypeLedger(migrated) ? migrated : null
}

function isVersionOneLedger(value: unknown): value is Record<string, unknown> & {
  nextSequence: number
  project: Record<string, unknown>
  groups: unknown[]
  nodes: unknown[]
  edges: unknown[]
} {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Number.isSafeInteger(value.nextSequence) ||
    Number(value.nextSequence) < 1 ||
    !isRecord(value.project) ||
    !hasString(value.project, 'id') ||
    !hasString(value.project, 'name') ||
    !Array.isArray(value.groups) ||
    !value.groups.every(isGroup) ||
    !Array.isArray(value.nodes) ||
    !value.nodes.every(isVersionOneNode) ||
    !Array.isArray(value.edges) ||
    !value.edges.every(isVersionOneEdge)
  ) {
    return false
  }

  const projectId = value.project.id as string
  const groupById = new Map(
    value.groups.map((group) => [(group as PrototypeGroup).id, group as PrototypeGroup])
  )
  const nodeIds = new Set(value.nodes.map((node) => (node as { id: string }).id))
  const allIds = [
    ...value.groups.map((group) => (group as { id: string }).id),
    ...value.nodes.map((node) => (node as { id: string }).id),
    ...value.edges.map((edge) => (edge as { id: string }).id)
  ]
  const resourceKeys = value.nodes.map((node) =>
    resourceIdentity((node as { resourceRef: ExternalResourceReference }).resourceRef)
  )
  const edgeKeys = value.edges.map((edge) => {
    const record = edge as PrototypeEdge
    return `${record.fromNodeId}\u0000${record.toNodeId}\u0000${record.relation}`
  })

  return (
    hasUniqueValues(allIds) &&
    hasUniqueValues(resourceKeys) &&
    hasUniqueValues(edgeKeys) &&
    Number(value.nextSequence) > maximumGeneratedSequence(allIds) &&
    value.groups.every((group) => (group as PrototypeGroup).projectId === projectId) &&
    value.nodes.every((node) => {
      const record = node as Omit<PrototypeNode, 'paseo'>
      const workItem = record.workItemId === null ? null : groupById.get(record.workItemId)
      return (
        record.projectId === projectId &&
        (record.groupId === null || groupById.has(record.groupId)) &&
        (record.workItemId === null || workItem?.kind === 'work-item')
      )
    }) &&
    value.edges.every((edge) => {
      const record = edge as PrototypeEdge
      return nodeIds.has(record.fromNodeId) && nodeIds.has(record.toNodeId)
    })
  )
}

function isVersionOneEdge(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasString(value, 'id') &&
    hasString(value, 'fromNodeId') &&
    hasString(value, 'toNodeId') &&
    typeof value.relation === 'string' &&
    ['spawned', 'attached', 'connected'].includes(value.relation)
  )
}

function isVersionOneNode(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasString(value, 'id') &&
    hasString(value, 'projectId') &&
    (value.groupId === null || typeof value.groupId === 'string') &&
    (value.workItemId === null || typeof value.workItemId === 'string') &&
    (value.kind === 'agent' || value.kind === 'workspace') &&
    hasString(value, 'title') &&
    isPoint(value.position) &&
    isResourceReference(value.resourceRef) &&
    !('paseo' in value)
  )
}

export function resourceIdentity(reference: ExternalResourceReference): string {
  return `${reference.provider}\u0000${reference.kind}\u0000${reference.id}`
}

function hasUniqueValues(values: readonly string[]): boolean {
  return new Set(values).size === values.length
}

function maximumGeneratedSequence(ids: readonly string[]): number {
  return ids.reduce((maximum, id) => {
    const match = /^(?:group|work-item|node|edge)-(\d+)$/.exec(id)
    return match ? Math.max(maximum, Number(match[1])) : maximum
  }, 0)
}
