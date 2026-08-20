export const PROTOTYPE_LEDGER_VERSION = 1 as const

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

export type Group = {
  id: string
  kind: 'group'
  projectId: string
  name: string
  position: Point
}

export type WorkItemStatus = 'active' | 'blocked' | 'review' | 'done'

export type WorkItem = {
  id: string
  kind: 'work-item'
  projectId: string
  name: string
  position: Point
  task: string
  sourceRef: ExternalResourceReference | null
  status: WorkItemStatus
}

export type PrototypeGroup = Group | WorkItem
export type PlaceholderKind = 'agent' | 'workspace'

export type PrototypeNode = {
  id: string
  projectId: string
  groupId: string | null
  workItemId: string | null
  kind: PlaceholderKind
  title: string
  position: Point
  resourceRef: ExternalResourceReference
}

export type ProvenanceRelation = 'spawned' | 'attached' | 'connected'

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
    ['active', 'blocked', 'review', 'done'].includes(String(value.status))
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
    isResourceReference(value.resourceRef)
  )
}

function isEdge(value: unknown): value is PrototypeEdge {
  return (
    isRecord(value) &&
    hasString(value, 'id') &&
    hasString(value, 'fromNodeId') &&
    hasString(value, 'toNodeId') &&
    ['spawned', 'attached', 'connected'].includes(String(value.relation))
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
    !value.edges.every(isEdge)
  ) {
    return false
  }

  const project = value.project
  const groupById = new Map(value.groups.map((group) => [group.id, group]))
  const nodeIds = new Set(value.nodes.map((node) => node.id))
  return (
    value.groups.every((group) => group.projectId === project.id) &&
    value.nodes.every((node) => {
      const group = node.groupId === null ? null : groupById.get(node.groupId)
      return (
        node.projectId === project.id &&
        (node.groupId === null || Boolean(group)) &&
        (node.workItemId === null || (group?.kind === 'work-item' && group.id === node.workItemId))
      )
    }) &&
    value.edges.every((edge) => nodeIds.has(edge.fromNodeId) && nodeIds.has(edge.toNodeId))
  )
}
