import type { PrototypeCommand } from './commands'
import {
  isProvenanceRelation,
  isWorkItemStatus,
  type ExternalResourceReference,
  type PrototypeLedger
} from './model'

export const P3_SNAPSHOT_CHANNEL = 'spade:p3:snapshot'
export const P3_COMMAND_CHANNEL = 'spade:p3:command'
export const P3_SNAPSHOT_EVENT_CHANNEL = 'spade:p3:snapshot-event'

export type P3PrototypeBridge = {
  snapshot(): Promise<PrototypeLedger>
  execute(command: PrototypeCommand): Promise<PrototypeLedger>
  subscribe(listener: (ledger: PrototypeLedger) => void): () => void
}

export function isPrototypeCommand(value: unknown): value is PrototypeCommand {
  if (!isRecord(value) || typeof value.type !== 'string') return false

  switch (value.type) {
    case 'create-group':
      return hasOnlyKeys(value, ['type', 'name']) && hasText(value.name)
    case 'create-work-item':
      return (
        hasOnlyKeys(value, ['type', 'name', 'task', 'sourceRef', 'status']) &&
        hasText(value.name) &&
        hasText(value.task) &&
        (value.sourceRef === undefined || isResourceReference(value.sourceRef)) &&
        (value.status === undefined || isWorkItemStatus(value.status))
      )
    case 'spawn-placeholder':
    case 'attach-placeholder':
      return (
        hasOnlyKeys(value, ['type', 'targetGroup', 'nodeKind', 'title', 'resourceRef']) &&
        hasText(value.targetGroup) &&
        (value.nodeKind === 'agent' || value.nodeKind === 'workspace') &&
        hasText(value.title) &&
        isResourceReference(value.resourceRef)
      )
    case 'connect-nodes':
      return (
        hasOnlyKeys(value, ['type', 'fromNodeId', 'toNodeId', 'relation']) &&
        hasText(value.fromNodeId) &&
        hasText(value.toNodeId) &&
        isProvenanceRelation(value.relation)
      )
    case 'set-work-item-status':
      return (
        hasOnlyKeys(value, ['type', 'workItemId', 'status']) &&
        hasText(value.workItemId) &&
        isWorkItemStatus(value.status)
      )
    default:
      return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(record).every((key) => keys.includes(key))
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isResourceReference(value: unknown): value is ExternalResourceReference {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['provider', 'kind', 'id', 'revision']) &&
    hasText(value.provider) &&
    hasText(value.kind) &&
    hasText(value.id) &&
    (value.revision === null || typeof value.revision === 'string')
  )
}
