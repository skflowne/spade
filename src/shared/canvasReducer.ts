import { AGENT_ENTITY } from './builtinEntities'
import {
  CanvasCommandError,
  type CanvasCommand,
  type CanvasCommandOutcome,
  type NodeSeed
} from './commands'
import {
  CANVAS_ACTIVITY_LIMIT,
  DOMAIN_RECORD_VERSION,
  type Actor,
  type Canvas,
  type CanvasEdge,
  type CanvasNode,
  type ChildOrigin,
  type ResourceRef,
  type SourceArtifact,
  type Workspace
} from './domain'
import type { EntityDefinition, EntityRegistry } from './entities'
import { placeNode, reservedSize } from './layout'
import { indexTree } from './tree'

export type CanvasCommandContext = {
  actor: Actor
  // ISO timestamp.
  now: string
  // Ids for edges, activity entries, and nodes.
  createId(): string
  entities: EntityRegistry
  // Id for the node a creation command creates; defaults to createId().
  nodeId?: string
}

export type CanvasCommandResult = { canvas: Canvas; outcome: CanvasCommandOutcome }

// What one command did, before activity is recorded. `canvas` is the input canvas when nothing changed.
type Change = {
  canvas: Canvas
  outcome?: CanvasCommandOutcome
  summary?: string
  nodeIds?: string[]
}

// Pure: never mutates `canvas` and returns it unchanged (same reference) when the command is a no-op.
export function applyCanvasCommand(
  canvas: Canvas,
  command: CanvasCommand,
  context: CanvasCommandContext
): CanvasCommandResult {
  const change = applyChange(canvas, command, context)
  const outcome = change.outcome ?? {}
  if (change.canvas === canvas || !recordsActivity(command, context.actor) || change.summary === undefined) {
    return { canvas: change.canvas, outcome }
  }

  const activity = [
    ...change.canvas.activity,
    {
      id: context.createId(),
      at: context.now,
      actor: context.actor,
      command: command.type,
      summary: change.summary,
      nodeIds: change.nodeIds ?? []
    }
  ].slice(-CANVAS_ACTIVITY_LIMIT)
  return { canvas: { ...change.canvas, activity }, outcome }
}

function recordsActivity(command: CanvasCommand, actor: Actor): boolean {
  switch (command.type) {
    case 'setViewport':
      return false
    case 'moveNodes':
    case 'resizeNode':
      return actor.kind !== 'user'
    case 'updateNode':
    case 'upsertWorkspace':
      return actor.kind !== 'system'
    default:
      return true
  }
}

function applyChange(canvas: Canvas, command: CanvasCommand, context: CanvasCommandContext): Change {
  switch (command.type) {
    case 'startTree':
      return createNode(canvas, command.node, null, { kind: 'root' }, context)
    case 'spawnChild': {
      const source = requireNode(canvas, command.sourceNodeId)
      const target = command.target ?? { kind: 'child', parentNodeId: source.id }
      const parentId =
        target.kind === 'child'
          ? requireNode(canvas, target.parentNodeId).id
          : target.kind === 'tree'
            ? indexTree(canvas).rootOf(requireNode(canvas, target.nodeId).id)
            : null
      const placement: Placement =
        parentId === null
          ? { kind: 'root', source }
          : { kind: 'child', parentId, origin: command.origin, sourceArtifact: command.sourceArtifact }
      return createNode(canvas, command.node, source.workspaceId, placement, context)
    }
    case 'connectNodes':
      return connectNodes(canvas, command, context)
    case 'disconnectNodes': {
      const edge = canvas.edges.find((candidate) => candidate.id === command.edgeId)
      if (!edge) throw new CanvasCommandError('unknown-edge', `Unknown edge: ${command.edgeId}`)
      if (edge.relation !== 'references') {
        throw new CanvasCommandError(
          'invalid-command',
          'Only references edges can be disconnected; reparent or remove the node instead'
        )
      }
      return {
        canvas: { ...canvas, edges: canvas.edges.filter((candidate) => candidate.id !== edge.id) },
        summary: `Disconnected ${nameOf(canvas, edge.fromNodeId)} from ${nameOf(canvas, edge.toNodeId)}`,
        nodeIds: [edge.fromNodeId, edge.toNodeId]
      }
    }
    case 'moveNodes': {
      const positions = new Map(command.moves.map((move) => [requireNode(canvas, move.nodeId).id, move.position]))
      const changed = updateNodes(canvas, [...positions.keys()], context.now, (node) => {
        const position = positions.get(node.id)!
        const unchanged = position.x === node.position.x && position.y === node.position.y
        return unchanged ? node : { ...node, position: { ...position } }
      })
      const ids = changedIds(canvas, changed)
      return {
        canvas: changed,
        summary: ids.length === 1 ? `Moved ${nameOf(canvas, ids[0])}` : `Moved ${ids.length} nodes`,
        nodeIds: ids
      }
    }
    case 'resizeNode': {
      const node = requireNode(canvas, command.nodeId)
      const { width, height } = command.size
      return {
        canvas: updateNodes(canvas, [node.id], context.now, (current) =>
          current.size?.width === width && current.size?.height === height
            ? current
            : { ...current, size: { width, height } }
        ),
        summary: `Resized ${quote(node)}`,
        nodeIds: [node.id]
      }
    }
    case 'reparent':
      return reparent(canvas, command.nodeId, command.newParentId, context)
    case 'setNodeWorkspace': {
      const node = requireNode(canvas, command.nodeId)
      const workspace = command.workspaceId === null ? null : requireWorkspace(canvas, command.workspaceId)
      return {
        canvas: updateNodes(canvas, [node.id], context.now, (current) =>
          current.workspaceId === command.workspaceId ? current : { ...current, workspaceId: command.workspaceId }
        ),
        summary: workspace
          ? `Set the workspace of ${quote(node)} to "${clip(workspace.name)}"`
          : `Cleared the workspace of ${quote(node)}`,
        nodeIds: [node.id]
      }
    }
    case 'updateNode':
      return updateNode(canvas, command.nodeId, command.patch, context)
    case 'collapseNode':
      return setFlag(canvas, command.nodeId, 'collapsed', true, false, 'Collapsed', context)
    case 'expandNode':
      return setFlag(canvas, command.nodeId, 'collapsed', false, false, 'Expanded', context)
    case 'collapseBranch':
      return setFlag(canvas, command.nodeId, 'branchCollapsed', true, false, 'Collapsed the branch under', context)
    case 'expandBranch':
      return setFlag(canvas, command.nodeId, 'branchCollapsed', false, false, 'Expanded the branch under', context)
    case 'archiveNode':
      return setFlag(canvas, command.nodeId, 'archived', true, false, 'Archived', context)
    case 'archiveBranch':
      return setFlag(canvas, command.nodeId, 'archived', true, true, 'Archived the branch', context)
    case 'restoreNode':
      return setFlag(
        canvas,
        command.nodeId,
        'archived',
        false,
        command.branch === true,
        command.branch ? 'Restored the branch' : 'Restored',
        context
      )
    case 'removeNode':
      return removeNode(canvas, command.nodeId)
    case 'removeBranch': {
      const node = requireNode(canvas, command.nodeId)
      const removed = indexTree(canvas).branchOf(node.id)
      const gone = new Set(removed)
      return {
        canvas: {
          ...canvas,
          nodes: canvas.nodes.filter((candidate) => !gone.has(candidate.id)),
          edges: canvas.edges.filter((edge) => !gone.has(edge.fromNodeId) && !gone.has(edge.toNodeId))
        },
        outcome: { removedNodeIds: removed },
        summary: `Removed the branch ${quote(node)} (${removed.length} ${removed.length === 1 ? 'node' : 'nodes'})`,
        nodeIds: removed
      }
    }
    case 'upsertWorkspace':
      return upsertWorkspace(canvas, command.workspace, context)
    case 'setViewport':
      return { canvas: { ...canvas, viewport: { ...command.viewport } } }
  }
}

type Placement =
  | { kind: 'root'; source?: CanvasNode }
  | { kind: 'child'; parentId: string; origin: ChildOrigin; sourceArtifact?: SourceArtifact }

function createNode(
  canvas: Canvas,
  seed: NodeSeed,
  inheritedWorkspaceId: string | null,
  placement: Placement,
  context: CanvasCommandContext
): Change {
  const definition = resolveDefinition(context.entities, seed.entityType)
  const config = parseConfig(definition, seed.config)
  const workspaceId = seed.workspaceId === undefined ? inheritedWorkspaceId : seed.workspaceId
  if (workspaceId !== null) requireWorkspace(canvas, workspaceId)

  const resourceRef = seed.resourceRef ?? null
  if (seed.ifResourceAbsent && resourceRef) {
    const existing = canvas.nodes.find((node) => node.resourceRef !== null && sameResource(node.resourceRef, resourceRef))
    if (existing) return { canvas, outcome: { nodeId: existing.id, created: false } }
  }

  const id = context.nodeId ?? context.createId()
  if (canvas.nodes.some((node) => node.id === id)) {
    throw new CanvasCommandError('invalid-command', `Node id already exists: ${id}`)
  }

  const parentId = placement.kind === 'child' ? placement.parentId : null
  const position =
    seed.position ??
    placeNode(canvas, context.entities, { parentId, size: reservedSize({ size: seed.size }, definition) })
  const title = seed.title ?? definition.displayName

  const node: CanvasNode = {
    version: DOMAIN_RECORD_VERSION,
    id,
    entityType: definition.type,
    entityVersion: definition.version,
    title,
    ...(seed.shortDescription === undefined ? {} : { shortDescription: seed.shortDescription }),
    position: { x: position.x, y: position.y },
    ...(seed.size === undefined ? {} : { size: { ...seed.size } }),
    collapsed: seed.collapsed ?? false,
    branchCollapsed: false,
    archived: false,
    projectId: canvas.projectId,
    groupId: null,
    workspaceId,
    config,
    resourceRef: resourceRef && { ...resourceRef },
    createdAt: context.now,
    updatedAt: context.now
  }

  const edges = [...canvas.edges]
  let edgeId: string | undefined
  if (placement.kind === 'child') {
    edgeId = context.createId()
    const { parentId: from, origin, sourceArtifact } = placement
    edges.push(childEdge(edgeId, from, id, origin, sourceArtifact, undefined, context.now))
  }

  const subject = `${definition.displayName} "${clip(title)}"`
  const summary =
    placement.kind === 'child'
      ? `Spawned ${subject} under ${nameOf(canvas, placement.parentId)}`
      : placement.source
        ? `Spawned ${subject} from ${quote(placement.source)} as a new tree`
        : `Started a new tree with ${subject}`
  const related = placement.kind === 'child' ? [placement.parentId] : placement.source ? [placement.source.id] : []

  return {
    canvas: { ...canvas, nodes: [...canvas.nodes, node], edges },
    outcome: { nodeId: id, created: true, ...(edgeId === undefined ? {} : { edgeId }) },
    summary,
    nodeIds: [id, ...related]
  }
}

function connectNodes(
  canvas: Canvas,
  command: Extract<CanvasCommand, { type: 'connectNodes' }>,
  context: CanvasCommandContext
): Change {
  const from = requireNode(canvas, command.fromNodeId)
  const to = requireNode(canvas, command.toNodeId)
  if (from.id === to.id) throw new CanvasCommandError('invalid-command', 'A node cannot reference itself')
  const duplicate = canvas.edges.some(
    (edge) =>
      edge.relation === 'references' &&
      edge.fromNodeId === from.id &&
      edge.toNodeId === to.id &&
      edge.label === command.label
  )
  if (duplicate) throw new CanvasCommandError('invalid-command', `${quote(from)} already references ${quote(to)}`)

  const edge: CanvasEdge = {
    version: DOMAIN_RECORD_VERSION,
    id: context.createId(),
    fromNodeId: from.id,
    toNodeId: to.id,
    relation: 'references',
    ...(command.label === undefined ? {} : { label: command.label }),
    createdAt: context.now
  }
  return {
    canvas: { ...canvas, edges: [...canvas.edges, edge] },
    outcome: { edgeId: edge.id },
    summary: `Connected ${quote(from)} to ${quote(to)}`,
    nodeIds: [from.id, to.id]
  }
}

function reparent(canvas: Canvas, nodeId: string, newParentId: string | null, context: CanvasCommandContext): Change {
  const node = requireNode(canvas, nodeId)
  const parent = newParentId === null ? null : requireNode(canvas, newParentId)
  const tree = indexTree(canvas)
  if (tree.wouldCreateCycle(node.id, newParentId)) {
    throw new CanvasCommandError('cycle', `${quote(node)} cannot move under itself or its own descendant`)
  }

  const oldEdge = tree.parentEdgeOf(node.id)
  if ((oldEdge?.fromNodeId ?? null) === newParentId) return { canvas }

  const edges = canvas.edges.filter((edge) => edge !== oldEdge)
  let edgeId: string | undefined
  if (parent) {
    edgeId = context.createId()
    edges.push(
      childEdge(
        edgeId,
        parent.id,
        node.id,
        oldEdge?.origin ?? 'spawned',
        oldEdge?.sourceArtifact,
        oldEdge?.label,
        context.now
      )
    )
  }
  return {
    canvas: { ...canvas, edges },
    outcome: edgeId === undefined ? {} : { edgeId },
    summary: parent ? `Moved ${quote(node)} under ${quote(parent)}` : `Made ${quote(node)} the root of a new tree`,
    nodeIds: parent ? [node.id, parent.id] : [node.id]
  }
}

function updateNode(
  canvas: Canvas,
  nodeId: string,
  patch: Extract<CanvasCommand, { type: 'updateNode' }>['patch'],
  context: CanvasCommandContext
): Change {
  const node = requireNode(canvas, nodeId)
  let next: CanvasNode = node

  if (patch.title !== undefined && patch.title !== node.title) next = { ...next, title: patch.title }
  if (patch.shortDescription === null && next.shortDescription !== undefined) {
    next = without(next, 'shortDescription')
  } else if (typeof patch.shortDescription === 'string' && patch.shortDescription !== next.shortDescription) {
    next = { ...next, shortDescription: patch.shortDescription }
  }
  if (patch.config !== undefined) {
    const definition = resolveDefinition(context.entities, node.entityType)
    next = { ...next, config: parseConfig(definition, patch.config), entityVersion: definition.version }
  }
  if (patch.cachedPresentation === null && next.cachedPresentation !== undefined) {
    next = without(next, 'cachedPresentation')
  } else if (patch.cachedPresentation) {
    const { revision, summary } = patch.cachedPresentation
    next = {
      ...next,
      cachedPresentation: {
        ...(revision === undefined ? {} : { revision }),
        ...(summary === undefined ? {} : { summary }),
        updatedAt: context.now
      }
    }
  }

  if (next === node) return { canvas }
  const renamed = next.title !== node.title
  return {
    canvas: replaceNode(canvas, { ...next, updatedAt: context.now }),
    summary: renamed ? `Renamed ${quote(node)} to ${quote(next)}` : `Updated ${quote(node)}`,
    nodeIds: [node.id]
  }
}

type NodeFlag = 'collapsed' | 'branchCollapsed' | 'archived'

function setFlag(
  canvas: Canvas,
  nodeId: string,
  flag: NodeFlag,
  value: boolean,
  wholeBranch: boolean,
  verb: string,
  context: CanvasCommandContext
): Change {
  const node = requireNode(canvas, nodeId)
  const ids = wholeBranch ? indexTree(canvas).branchOf(node.id) : [node.id]
  const changed = updateNodes(canvas, ids, context.now, (current) =>
    current[flag] === value ? current : { ...current, [flag]: value }
  )
  return { canvas: changed, summary: `${verb} ${quote(node)}`, nodeIds: changedIds(canvas, changed) }
}

// Children move up to the removed node's parent, except that ownership is direct: an agent's delegated
// agent children (and theirs) are removed with it, so they return to its list instead of being promoted
// under the grandparent. Whatever those agents spawned is promoted to the nearest surviving ancestor.
function removeNode(canvas: Canvas, nodeId: string): Change {
  const node = requireNode(canvas, nodeId)
  const tree = indexTree(canvas)
  const types = new Map(canvas.nodes.map((candidate) => [candidate.id, candidate.entityType]))
  const removed = [node.id]
  for (let index = 0; index < removed.length; index += 1) {
    if (types.get(removed[index]) !== AGENT_ENTITY) continue
    for (const edge of canvas.edges) {
      if (edge.relation === 'child' && edge.fromNodeId === removed[index] && edge.origin === 'delegated') {
        if (types.get(edge.toNodeId) === AGENT_ENTITY) removed.push(edge.toNodeId)
      }
    }
  }
  const gone = new Set(removed)
  const newParent = tree.parentEdgeOf(node.id)?.fromNodeId ?? null
  const edges: CanvasEdge[] = []
  for (const edge of canvas.edges) {
    if (edge.relation === 'child' && gone.has(edge.fromNodeId) && !gone.has(edge.toNodeId)) {
      if (newParent !== null) edges.push({ ...edge, fromNodeId: newParent })
    } else if (!gone.has(edge.fromNodeId) && !gone.has(edge.toNodeId)) {
      edges.push(edge)
    }
  }
  const delegated = removed.length - 1
  return {
    canvas: { ...canvas, nodes: canvas.nodes.filter((candidate) => !gone.has(candidate.id)), edges },
    outcome: { removedNodeIds: removed },
    summary:
      delegated === 0
        ? `Removed ${quote(node)}`
        : `Removed ${quote(node)} and ${delegated} delegated agent ${delegated === 1 ? 'node' : 'nodes'}`,
    nodeIds: removed
  }
}

function upsertWorkspace(
  canvas: Canvas,
  input: Extract<CanvasCommand, { type: 'upsertWorkspace' }>['workspace'],
  context: CanvasCommandContext
): Change {
  const existing = canvas.workspaces.find((workspace) => workspace.id === input.id)
  const paseoWorkspaceId = input.paseoWorkspaceId ?? existing?.paseoWorkspaceId
  const workspace: Workspace = {
    version: DOMAIN_RECORD_VERSION,
    id: input.id,
    projectId: existing?.projectId ?? canvas.projectId,
    cwd: input.cwd,
    ...(paseoWorkspaceId === undefined ? {} : { paseoWorkspaceId }),
    name: input.name,
    createdAt: existing?.createdAt ?? context.now
  }
  if (
    existing &&
    existing.cwd === workspace.cwd &&
    existing.name === workspace.name &&
    existing.paseoWorkspaceId === workspace.paseoWorkspaceId
  ) {
    return { canvas }
  }
  return {
    canvas: {
      ...canvas,
      workspaces: existing
        ? canvas.workspaces.map((candidate) => (candidate === existing ? workspace : candidate))
        : [...canvas.workspaces, workspace]
    },
    summary: `${existing ? 'Updated' : 'Added'} workspace "${clip(workspace.name)}"`,
    nodeIds: []
  }
}

// Provider, kind, and id identify a resource; the revision does not.
function sameResource(a: ResourceRef, b: ResourceRef): boolean {
  return a.provider === b.provider && a.kind === b.kind && a.id === b.id
}

function childEdge(
  id: string,
  fromNodeId: string,
  toNodeId: string,
  origin: ChildOrigin,
  sourceArtifact: SourceArtifact | undefined,
  label: string | undefined,
  createdAt: string
): CanvasEdge {
  return {
    version: DOMAIN_RECORD_VERSION,
    id,
    fromNodeId,
    toNodeId,
    relation: 'child',
    origin,
    ...(sourceArtifact === undefined ? {} : { sourceArtifact: { ...sourceArtifact } }),
    ...(label === undefined ? {} : { label }),
    createdAt
  }
}

// Applies `update` to the named nodes, stamping `updatedAt` on those it actually replaced.
function updateNodes(
  canvas: Canvas,
  ids: readonly string[],
  now: string,
  update: (node: CanvasNode) => CanvasNode
): Canvas {
  const targets = new Set(ids)
  let changed = false
  const nodes = canvas.nodes.map((node) => {
    if (!targets.has(node.id)) return node
    const next = update(node)
    if (next === node) return node
    changed = true
    return { ...next, updatedAt: now }
  })
  return changed ? { ...canvas, nodes } : canvas
}

function changedIds(before: Canvas, after: Canvas): string[] {
  return after.nodes.filter((node, index) => node !== before.nodes[index]).map((node) => node.id)
}

function without(node: CanvasNode, key: 'shortDescription' | 'cachedPresentation'): CanvasNode {
  const copy = { ...node }
  delete copy[key]
  return copy
}

function replaceNode(canvas: Canvas, next: CanvasNode): Canvas {
  return { ...canvas, nodes: canvas.nodes.map((node) => (node.id === next.id ? next : node)) }
}

function requireNode(canvas: Canvas, nodeId: string): CanvasNode {
  const node = canvas.nodes.find((candidate) => candidate.id === nodeId)
  if (!node) throw new CanvasCommandError('unknown-node', `Unknown node: ${nodeId}`)
  return node
}

function requireWorkspace(canvas: Canvas, workspaceId: string): Workspace {
  const workspace = canvas.workspaces.find((candidate) => candidate.id === workspaceId)
  if (!workspace) throw new CanvasCommandError('unknown-workspace', `Unknown workspace: ${workspaceId}`)
  return workspace
}

function resolveDefinition(entities: EntityRegistry, type: string): EntityDefinition {
  if (!entities.has(type)) throw new CanvasCommandError('unknown-entity-type', `Unknown entity type: ${type}`)
  return entities.resolve(type)
}

function parseConfig(definition: EntityDefinition, value: unknown): unknown {
  try {
    return definition.parseConfig(value)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new CanvasCommandError('invalid-config', `Invalid ${definition.displayName} config: ${reason}`)
  }
}

const TITLE_SUMMARY_LIMIT = 80

function clip(text: string): string {
  return text.length > TITLE_SUMMARY_LIMIT ? `${text.slice(0, TITLE_SUMMARY_LIMIT - 1)}…` : text
}

function quote(node: CanvasNode): string {
  return `"${clip(node.title)}"`
}

function nameOf(canvas: Canvas, nodeId: string): string {
  const node = canvas.nodes.find((candidate) => candidate.id === nodeId)
  return node ? quote(node) : nodeId
}
