import {
  CANVAS_ACTIVITY_LIMIT,
  CANVAS_DISMISSED_RESOURCE_LIMIT,
  DOMAIN_RECORD_VERSION,
  type Actor,
  type AgentDefaults,
  type AppSettings,
  type Canvas,
  type CanvasActivity,
  type CanvasEdge,
  type CanvasNode,
  type ConversationExpansionPreferences,
  type Point,
  type Project,
  type ResourceRef,
  type Size,
  type Viewport,
  type Workspace
} from './domain'

// Strict runtime guards for the persisted domain records. Each `parse*` returns its input, typed,
// or throws a RecordValidationError naming the first problem. Unknown keys are rejected so that
// transient UI state can never leak into a persisted record.

export class RecordValidationError extends Error {
  constructor(
    readonly path: string,
    readonly problem: string
  ) {
    super(`${path} ${problem}`)
    this.name = 'RecordValidationError'
  }
}

type Fields = Record<string, unknown>

function fail(path: string, problem: string): never {
  throw new RecordValidationError(path, problem)
}

function shape(value: unknown, path: string, required: readonly string[], optional: readonly string[] = []): Fields {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'must be an object')
  const fields = value as Fields
  for (const key of required) {
    if (fields[key] === undefined) fail(`${path}.${key}`, 'is required')
  }
  for (const key of Object.keys(fields)) {
    if (!required.includes(key) && !optional.includes(key)) fail(`${path}.${key}`, 'is not a known field')
  }
  return fields
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, 'must be an array')
  return value
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, 'must be a string')
  return value
}

function nonEmptyString(value: unknown, path: string): string {
  if (string(value, path).length === 0) fail(path, 'must not be empty')
  return value as string
}

function optionalString(value: unknown, path: string): void {
  if (value !== undefined) string(value, path)
}

function nullableString(value: unknown, path: string): void {
  if (value !== null) string(value, path)
}

function boolean(value: unknown, path: string): void {
  if (typeof value !== 'boolean') fail(path, 'must be a boolean')
}

function finite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'must be a finite number')
  return value
}

function positive(value: unknown, path: string): void {
  if (finite(value, path) <= 0) fail(path, 'must be greater than zero')
}

function timestamp(value: unknown, path: string): void {
  if (Number.isNaN(Date.parse(nonEmptyString(value, path)))) fail(path, 'must be an ISO timestamp')
}

function recordVersion(value: unknown, path: string): void {
  if (value !== DOMAIN_RECORD_VERSION) fail(path, `must be ${DOMAIN_RECORD_VERSION}`)
}

function oneOf<Value extends string>(value: unknown, allowed: readonly Value[], path: string): Value {
  if (!allowed.includes(value as Value)) fail(path, `must be one of ${allowed.join(', ')}`)
  return value as Value
}

function parsePoint(value: unknown, path: string): Point {
  const point = shape(value, path, ['x', 'y'])
  finite(point.x, `${path}.x`)
  finite(point.y, `${path}.y`)
  return value as Point
}

function parseSize(value: unknown, path: string): Size {
  const size = shape(value, path, ['width', 'height'])
  positive(size.width, `${path}.width`)
  positive(size.height, `${path}.height`)
  return value as Size
}

export function parseViewport(value: unknown, path = 'viewport'): Viewport {
  const viewport = shape(value, path, ['x', 'y', 'zoom'])
  finite(viewport.x, `${path}.x`)
  finite(viewport.y, `${path}.y`)
  positive(viewport.zoom, `${path}.zoom`)
  return value as Viewport
}

export function parseResourceRef(value: unknown, path = 'resourceRef'): ResourceRef {
  const ref = shape(value, path, ['provider', 'kind', 'id'], ['revision'])
  nonEmptyString(ref.provider, `${path}.provider`)
  nonEmptyString(ref.kind, `${path}.kind`)
  nonEmptyString(ref.id, `${path}.id`)
  optionalString(ref.revision, `${path}.revision`)
  return value as ResourceRef
}

export function parseProject(value: unknown, path = 'project'): Project {
  const project = shape(value, path, ['version', 'id', 'name', 'rootPath', 'createdAt'])
  recordVersion(project.version, `${path}.version`)
  nonEmptyString(project.id, `${path}.id`)
  string(project.name, `${path}.name`)
  nonEmptyString(project.rootPath, `${path}.rootPath`)
  timestamp(project.createdAt, `${path}.createdAt`)
  return value as Project
}

export function parseWorkspace(value: unknown, path = 'workspace'): Workspace {
  const workspace = shape(
    value,
    path,
    ['version', 'id', 'projectId', 'cwd', 'name', 'createdAt'],
    ['paseoWorkspaceId']
  )
  recordVersion(workspace.version, `${path}.version`)
  nonEmptyString(workspace.id, `${path}.id`)
  nonEmptyString(workspace.projectId, `${path}.projectId`)
  nonEmptyString(workspace.cwd, `${path}.cwd`)
  optionalString(workspace.paseoWorkspaceId, `${path}.paseoWorkspaceId`)
  string(workspace.name, `${path}.name`)
  timestamp(workspace.createdAt, `${path}.createdAt`)
  return value as Workspace
}

export function parseCanvasNode(value: unknown, path = 'node'): CanvasNode {
  const node = shape(
    value,
    path,
    [
      'version',
      'id',
      'entityType',
      'entityVersion',
      'title',
      'position',
      'collapsed',
      'branchCollapsed',
      'archived',
      'projectId',
      'groupId',
      'workspaceId',
      'config',
      'resourceRef',
      'createdAt',
      'updatedAt'
    ],
    ['shortDescription', 'size', 'cachedPresentation']
  )
  recordVersion(node.version, `${path}.version`)
  nonEmptyString(node.id, `${path}.id`)
  nonEmptyString(node.entityType, `${path}.entityType`)
  if (!Number.isInteger(node.entityVersion) || (node.entityVersion as number) < 1) {
    fail(`${path}.entityVersion`, 'must be a positive integer')
  }
  string(node.title, `${path}.title`)
  optionalString(node.shortDescription, `${path}.shortDescription`)
  parsePoint(node.position, `${path}.position`)
  if (node.size !== undefined) parseSize(node.size, `${path}.size`)
  boolean(node.collapsed, `${path}.collapsed`)
  boolean(node.branchCollapsed, `${path}.branchCollapsed`)
  boolean(node.archived, `${path}.archived`)
  nonEmptyString(node.projectId, `${path}.projectId`)
  if (node.groupId !== null) nonEmptyString(node.groupId, `${path}.groupId`)
  if (node.workspaceId !== null) nonEmptyString(node.workspaceId, `${path}.workspaceId`)
  if (node.resourceRef !== null) parseResourceRef(node.resourceRef, `${path}.resourceRef`)
  if (node.cachedPresentation !== undefined) {
    const cache = shape(node.cachedPresentation, `${path}.cachedPresentation`, ['updatedAt'], ['revision', 'summary'])
    optionalString(cache.revision, `${path}.cachedPresentation.revision`)
    optionalString(cache.summary, `${path}.cachedPresentation.summary`)
    timestamp(cache.updatedAt, `${path}.cachedPresentation.updatedAt`)
  }
  timestamp(node.createdAt, `${path}.createdAt`)
  timestamp(node.updatedAt, `${path}.updatedAt`)
  return value as CanvasNode
}

export function parseCanvasEdge(value: unknown, path = 'edge'): CanvasEdge {
  const edge = shape(
    value,
    path,
    ['version', 'id', 'fromNodeId', 'toNodeId', 'relation', 'createdAt'],
    ['origin', 'sourceArtifact', 'label']
  )
  recordVersion(edge.version, `${path}.version`)
  nonEmptyString(edge.id, `${path}.id`)
  nonEmptyString(edge.fromNodeId, `${path}.fromNodeId`)
  nonEmptyString(edge.toNodeId, `${path}.toNodeId`)
  oneOf(edge.relation, ['child', 'references'], `${path}.relation`)
  if (edge.origin !== undefined) oneOf(edge.origin, ['spawned', 'delegated', 'artifact'], `${path}.origin`)
  if (edge.sourceArtifact !== undefined) {
    const artifact = shape(edge.sourceArtifact, `${path}.sourceArtifact`, ['kind', 'value'])
    nonEmptyString(artifact.kind, `${path}.sourceArtifact.kind`)
    string(artifact.value, `${path}.sourceArtifact.value`)
  }
  optionalString(edge.label, `${path}.label`)
  timestamp(edge.createdAt, `${path}.createdAt`)
  return value as CanvasEdge
}

export function parseActor(value: unknown, path = 'actor'): Actor {
  const kind = shape(value, path, ['kind'], ['nodeId', 'agentId']).kind
  oneOf(kind, ['user', 'agent', 'system'], `${path}.kind`)
  if (kind === 'agent') {
    const actor = shape(value, path, ['kind', 'nodeId', 'agentId'])
    nonEmptyString(actor.nodeId, `${path}.nodeId`)
    nonEmptyString(actor.agentId, `${path}.agentId`)
  } else {
    shape(value, path, ['kind'])
  }
  return value as Actor
}

export function parseCanvasActivity(value: unknown, path = 'activity'): CanvasActivity {
  const activity = shape(value, path, ['id', 'at', 'actor', 'command', 'summary', 'nodeIds'])
  nonEmptyString(activity.id, `${path}.id`)
  timestamp(activity.at, `${path}.at`)
  parseActor(activity.actor, `${path}.actor`)
  nonEmptyString(activity.command, `${path}.command`)
  string(activity.summary, `${path}.summary`)
  array(activity.nodeIds, `${path}.nodeIds`).forEach((id, index) => nonEmptyString(id, `${path}.nodeIds[${index}]`))
  return value as CanvasActivity
}

function uniqueIds(records: Array<{ id: string }>, path: string): Set<string> {
  const ids = new Set<string>()
  records.forEach((record, index) => {
    if (ids.has(record.id)) fail(`${path}[${index}].id`, `duplicates ${record.id}`)
    ids.add(record.id)
  })
  return ids
}

// Child edges must form a forest: at most one parent per node and no cycles.
function assertChildForest(edges: CanvasEdge[], path: string): void {
  const parentOf = new Map<string, string>()
  edges.forEach((edge, index) => {
    if (edge.relation !== 'child') return
    if (parentOf.has(edge.toNodeId)) fail(`${path}[${index}]`, `gives ${edge.toNodeId} a second parent`)
    parentOf.set(edge.toNodeId, edge.fromNodeId)
  })
  for (const start of parentOf.keys()) {
    const seen = new Set<string>([start])
    for (let current = parentOf.get(start); current !== undefined; current = parentOf.get(current)) {
      if (seen.has(current)) fail(path, `contain a child cycle through ${start}`)
      seen.add(current)
    }
  }
}

export function parseCanvas(value: unknown, path = 'canvas'): Canvas {
  const canvas = shape(value, path, [
    'version',
    'projectId',
    'nodes',
    'edges',
    'workspaces',
    'viewport',
    'activity',
    'dismissedResources'
  ])
  recordVersion(canvas.version, `${path}.version`)
  const projectId = nonEmptyString(canvas.projectId, `${path}.projectId`)
  const nodes = array(canvas.nodes, `${path}.nodes`).map((node, index) => parseCanvasNode(node, `${path}.nodes[${index}]`))
  const edges = array(canvas.edges, `${path}.edges`).map((edge, index) => parseCanvasEdge(edge, `${path}.edges[${index}]`))
  const workspaces = array(canvas.workspaces, `${path}.workspaces`).map((workspace, index) =>
    parseWorkspace(workspace, `${path}.workspaces[${index}]`)
  )
  if (canvas.viewport !== null) parseViewport(canvas.viewport, `${path}.viewport`)
  const activity = array(canvas.activity, `${path}.activity`)
  if (activity.length > CANVAS_ACTIVITY_LIMIT) fail(`${path}.activity`, `exceeds ${CANVAS_ACTIVITY_LIMIT} entries`)
  activity.forEach((entry, index) => parseCanvasActivity(entry, `${path}.activity[${index}]`))
  const dismissed = array(canvas.dismissedResources, `${path}.dismissedResources`)
  if (dismissed.length > CANVAS_DISMISSED_RESOURCE_LIMIT) {
    fail(`${path}.dismissedResources`, `exceeds ${CANVAS_DISMISSED_RESOURCE_LIMIT} entries`)
  }
  dismissed.forEach((ref, index) => parseResourceRef(ref, `${path}.dismissedResources[${index}]`))

  const nodeIds = uniqueIds(nodes, `${path}.nodes`)
  const workspaceIds = uniqueIds(workspaces, `${path}.workspaces`)
  uniqueIds(edges, `${path}.edges`)
  nodes.forEach((node, index) => {
    if (node.projectId !== projectId) fail(`${path}.nodes[${index}].projectId`, `must be ${projectId}`)
    if (node.workspaceId !== null && !workspaceIds.has(node.workspaceId)) {
      fail(`${path}.nodes[${index}].workspaceId`, `names unknown workspace ${node.workspaceId}`)
    }
  })
  workspaces.forEach((workspace, index) => {
    if (workspace.projectId !== projectId) fail(`${path}.workspaces[${index}].projectId`, `must be ${projectId}`)
  })
  edges.forEach((edge, index) => {
    if (!nodeIds.has(edge.fromNodeId)) fail(`${path}.edges[${index}].fromNodeId`, `names unknown node ${edge.fromNodeId}`)
    if (!nodeIds.has(edge.toNodeId)) fail(`${path}.edges[${index}].toNodeId`, `names unknown node ${edge.toNodeId}`)
    if (edge.fromNodeId === edge.toNodeId) fail(`${path}.edges[${index}]`, 'must connect two different nodes')
  })
  assertChildForest(edges, `${path}.edges`)
  return value as Canvas
}

function parseAgentDefaults(value: unknown, path: string): AgentDefaults {
  const defaults = shape(value, path, ['provider', 'model', 'mode'])
  nonEmptyString(defaults.provider, `${path}.provider`)
  string(defaults.model, `${path}.model`)
  nullableString(defaults.mode, `${path}.mode`)
  return value as AgentDefaults
}

function parseConversationExpansion(value: unknown, path: string): ConversationExpansionPreferences {
  const keys = ['toolCall', 'diff', 'html', 'thinking', 'read'] as const
  const expansion = shape(value, path, keys)
  for (const key of keys) boolean(expansion[key], `${path}.${key}`)
  return value as ConversationExpansionPreferences
}

export function parseAppSettings(value: unknown, path = 'settings'): AppSettings {
  const settings = shape(value, path, ['agentDefaults', 'conversationExpansion', 'paseoUrl'])
  if (settings.agentDefaults !== null) parseAgentDefaults(settings.agentDefaults, `${path}.agentDefaults`)
  parseConversationExpansion(settings.conversationExpansion, `${path}.conversationExpansion`)
  if (settings.paseoUrl !== null) nonEmptyString(settings.paseoUrl, `${path}.paseoUrl`)
  return value as AppSettings
}
