import {
  CanvasCommandError,
  type CanvasCommand,
  type CanvasCommandType,
  type NodeSeed,
  type SpawnTarget
} from './commands'
import type { ChildOrigin, Point, ResourceRef, Size, SourceArtifact, Viewport } from './domain'

// Strict runtime validation of a command from an untrusted caller (IPC, the agent CLI).
// Returns a fresh value; entity config is passed through untouched for the entity definition to validate.
export function parseCanvasCommand(value: unknown): CanvasCommand {
  const command = object(value, 'command')
  const type = command.type
  if (typeof type !== 'string' || !Object.hasOwn(PARSERS, type)) {
    throw invalid('type', `must be one of ${Object.keys(PARSERS).join(', ')}`)
  }
  return PARSERS[type as CanvasCommandType](command)
}

type Fields = Record<string, unknown>

type NodeOnlyType =
  | 'collapseNode'
  | 'expandNode'
  | 'collapseBranch'
  | 'expandBranch'
  | 'archiveNode'
  | 'archiveBranch'
  | 'removeNode'
  | 'removeBranch'

function nodeCommand<Type extends NodeOnlyType>(type: Type) {
  return (fields: Fields): Extract<CanvasCommand, { type: Type }> => {
    keys(fields, '', ['type', 'nodeId'])
    return { type, nodeId: id(fields.nodeId, 'nodeId') } as Extract<CanvasCommand, { type: Type }>
  }
}

const PARSERS: { [Type in CanvasCommandType]: (fields: Fields) => Extract<CanvasCommand, { type: Type }> } = {
  spawnChild(fields) {
    keys(fields, '', ['type', 'sourceNodeId', 'node', 'target', 'origin', 'sourceArtifact'])
    return {
      type: 'spawnChild',
      sourceNodeId: id(fields.sourceNodeId, 'sourceNodeId'),
      node: seed(fields.node, 'node'),
      ...optional(fields, 'target', '', target),
      origin: origin(fields.origin, 'origin'),
      ...optional(fields, 'sourceArtifact', '', sourceArtifact)
    }
  },
  startTree(fields) {
    keys(fields, '', ['type', 'node'])
    return { type: 'startTree', node: seed(fields.node, 'node') }
  },
  connectNodes(fields) {
    keys(fields, '', ['type', 'fromNodeId', 'toNodeId', 'label'])
    return {
      type: 'connectNodes',
      fromNodeId: id(fields.fromNodeId, 'fromNodeId'),
      toNodeId: id(fields.toNodeId, 'toNodeId'),
      ...optional(fields, 'label', '', string)
    }
  },
  disconnectNodes(fields) {
    keys(fields, '', ['type', 'edgeId'])
    return { type: 'disconnectNodes', edgeId: id(fields.edgeId, 'edgeId') }
  },
  moveNodes(fields) {
    keys(fields, '', ['type', 'moves'])
    if (!Array.isArray(fields.moves) || fields.moves.length === 0) throw invalid('moves', 'must be a non-empty array')
    return {
      type: 'moveNodes',
      moves: fields.moves.map((entry: unknown, index) => {
        const path = `moves[${index}]`
        const move = object(entry, path)
        keys(move, path, ['nodeId', 'position'])
        return { nodeId: id(move.nodeId, `${path}.nodeId`), position: point(move.position, `${path}.position`) }
      })
    }
  },
  resizeNode(fields) {
    keys(fields, '', ['type', 'nodeId', 'size'])
    return { type: 'resizeNode', nodeId: id(fields.nodeId, 'nodeId'), size: size(fields.size, 'size') }
  },
  reparent(fields) {
    keys(fields, '', ['type', 'nodeId', 'newParentId'])
    return {
      type: 'reparent',
      nodeId: id(fields.nodeId, 'nodeId'),
      newParentId: nullable(fields.newParentId, 'newParentId', id)
    }
  },
  setNodeWorkspace(fields) {
    keys(fields, '', ['type', 'nodeId', 'workspaceId'])
    return {
      type: 'setNodeWorkspace',
      nodeId: id(fields.nodeId, 'nodeId'),
      workspaceId: nullable(fields.workspaceId, 'workspaceId', id)
    }
  },
  updateNode(fields) {
    keys(fields, '', ['type', 'nodeId', 'patch'])
    const patch = object(fields.patch, 'patch')
    keys(patch, 'patch', ['title', 'shortDescription', 'config', 'cachedPresentation'])
    const parsed: Extract<CanvasCommand, { type: 'updateNode' }>['patch'] = {}
    if (patch.title !== undefined) parsed.title = text(patch.title, 'patch.title')
    if (patch.shortDescription !== undefined) {
      parsed.shortDescription = nullable(patch.shortDescription, 'patch.shortDescription', string)
    }
    if (Object.hasOwn(patch, 'config')) parsed.config = patch.config
    if (patch.cachedPresentation !== undefined) {
      parsed.cachedPresentation = nullable(patch.cachedPresentation, 'patch.cachedPresentation', (value, path) => {
        const presentation = object(value, path)
        keys(presentation, path, ['revision', 'summary'])
        return {
          ...optional(presentation, 'revision', path, string),
          ...optional(presentation, 'summary', path, string)
        }
      })
    }
    return { type: 'updateNode', nodeId: id(fields.nodeId, 'nodeId'), patch: parsed }
  },
  collapseNode: nodeCommand('collapseNode'),
  expandNode: nodeCommand('expandNode'),
  collapseBranch: nodeCommand('collapseBranch'),
  expandBranch: nodeCommand('expandBranch'),
  archiveNode: nodeCommand('archiveNode'),
  archiveBranch: nodeCommand('archiveBranch'),
  removeNode: nodeCommand('removeNode'),
  removeBranch: nodeCommand('removeBranch'),
  restoreNode(fields) {
    keys(fields, '', ['type', 'nodeId', 'branch'])
    return {
      type: 'restoreNode',
      nodeId: id(fields.nodeId, 'nodeId'),
      ...optional(fields, 'branch', '', boolean)
    }
  },
  upsertWorkspace(fields) {
    keys(fields, '', ['type', 'workspace'])
    const workspace = object(fields.workspace, 'workspace')
    keys(workspace, 'workspace', ['id', 'cwd', 'name', 'paseoWorkspaceId'])
    return {
      type: 'upsertWorkspace',
      workspace: {
        id: id(workspace.id, 'workspace.id'),
        cwd: text(workspace.cwd, 'workspace.cwd'),
        name: text(workspace.name, 'workspace.name'),
        ...optional(workspace, 'paseoWorkspaceId', 'workspace', id)
      }
    }
  },
  setViewport(fields) {
    keys(fields, '', ['type', 'viewport'])
    const viewport = object(fields.viewport, 'viewport')
    keys(viewport, 'viewport', ['x', 'y', 'zoom'])
    const parsed: Viewport = {
      x: finite(viewport.x, 'viewport.x'),
      y: finite(viewport.y, 'viewport.y'),
      zoom: positive(viewport.zoom, 'viewport.zoom')
    }
    return { type: 'setViewport', viewport: parsed }
  }
}

function seed(value: unknown, path: string): NodeSeed {
  const fields = object(value, path)
  keys(fields, path, [
    'entityType',
    'config',
    'title',
    'shortDescription',
    'position',
    'size',
    'collapsed',
    'workspaceId',
    'resourceRef',
    'ifResourceAbsent'
  ])
  if (!Object.hasOwn(fields, 'config')) throw invalid(`${path}.config`, 'is required')
  return {
    entityType: id(fields.entityType, `${path}.entityType`),
    config: fields.config,
    ...optional(fields, 'title', path, text),
    ...optional(fields, 'shortDescription', path, string),
    ...optional(fields, 'position', path, point),
    ...optional(fields, 'size', path, size),
    ...optional(fields, 'collapsed', path, boolean),
    ...optional(fields, 'workspaceId', path, (entry, entryPath) => nullable(entry, entryPath, id)),
    ...optional(fields, 'resourceRef', path, (entry, entryPath) => nullable(entry, entryPath, resourceRef)),
    ...optional(fields, 'ifResourceAbsent', path, boolean)
  }
}

function target(value: unknown, path: string): SpawnTarget {
  const fields = object(value, path)
  switch (fields.kind) {
    case 'child':
      keys(fields, path, ['kind', 'parentNodeId'])
      return { kind: 'child', parentNodeId: id(fields.parentNodeId, `${path}.parentNodeId`) }
    case 'tree':
      keys(fields, path, ['kind', 'nodeId'])
      return { kind: 'tree', nodeId: id(fields.nodeId, `${path}.nodeId`) }
    case 'new-tree':
      keys(fields, path, ['kind'])
      return { kind: 'new-tree' }
    default:
      throw invalid(`${path}.kind`, 'must be "child", "tree", or "new-tree"')
  }
}

const ORIGINS: readonly ChildOrigin[] = ['spawned', 'delegated', 'artifact']

function origin(value: unknown, path: string): ChildOrigin {
  if (!ORIGINS.includes(value as ChildOrigin)) throw invalid(path, `must be one of ${ORIGINS.join(', ')}`)
  return value as ChildOrigin
}

function sourceArtifact(value: unknown, path: string): SourceArtifact {
  const fields = object(value, path)
  keys(fields, path, ['kind', 'value'])
  return { kind: text(fields.kind, `${path}.kind`), value: text(fields.value, `${path}.value`) }
}

function resourceRef(value: unknown, path: string): ResourceRef {
  const fields = object(value, path)
  keys(fields, path, ['provider', 'kind', 'id', 'revision'])
  return {
    provider: text(fields.provider, `${path}.provider`),
    kind: text(fields.kind, `${path}.kind`),
    id: text(fields.id, `${path}.id`),
    ...optional(fields, 'revision', path, string)
  }
}

function point(value: unknown, path: string): Point {
  const fields = object(value, path)
  keys(fields, path, ['x', 'y'])
  return { x: finite(fields.x, `${path}.x`), y: finite(fields.y, `${path}.y`) }
}

function size(value: unknown, path: string): Size {
  const fields = object(value, path)
  keys(fields, path, ['width', 'height'])
  return { width: positive(fields.width, `${path}.width`), height: positive(fields.height, `${path}.height`) }
}

function object(value: unknown, path: string): Fields {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid(path, 'must be an object')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw invalid(path, 'must be a plain object')
  return value as Fields
}

function keys(fields: Fields, path: string, allowed: readonly string[]): void {
  for (const key of Object.keys(fields)) {
    if (!allowed.includes(key)) throw invalid(path ? `${path}.${key}` : key, 'is not a known field')
  }
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string') throw invalid(path, 'must be a string')
  return value
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) throw invalid(path, 'must be a non-empty string')
  return value
}

const id = text

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw invalid(path, 'must be a boolean')
  return value
}

function finite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid(path, 'must be a finite number')
  return value
}

function positive(value: unknown, path: string): number {
  if (finite(value, path) <= 0) throw invalid(path, 'must be greater than zero')
  return value as number
}

function nullable<Value>(value: unknown, path: string, parse: (value: unknown, path: string) => Value): Value | null {
  if (value === undefined) throw invalid(path, 'is required (use null for none)')
  return value === null ? null : parse(value, path)
}

// The field as `{ [key]: parsed }` when present, `{}` when absent.
function optional<Key extends string, Value>(
  fields: Fields,
  key: Key,
  path: string,
  parse: (value: unknown, path: string) => Value
): { [K in Key]?: Value } {
  if (fields[key] === undefined) return {}
  return { [key]: parse(fields[key], path ? `${path}.${key}` : key) } as { [K in Key]?: Value }
}

function invalid(field: string, problem: string): CanvasCommandError {
  return new CanvasCommandError('invalid-command', `${field} ${problem}`)
}
