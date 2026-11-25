import type { AgentService, WorkspaceGateway } from '../contracts'
import { stableErrorCode } from '../errors'
import { describeNodeForAgent } from '../../shared/agentContext'
import { AGENT_ENTITY } from '../../shared/builtinEntities'
import {
  CanvasCommandError,
  type CanvasCommand,
  type CanvasCommandOutcome,
  type NodeSeed,
  type SpawnTarget
} from '../../shared/commands'
import { parseCanvasCommand } from '../../shared/commandValidation'
import type { Actor, Canvas, CanvasNode, Project } from '../../shared/domain'
import type { EntityRegistry } from '../../shared/entities'
import { indexTree, type TreeIndex } from '../../shared/tree'
import {
  DEFAULT_PAGE_LIMIT,
  DEFAULT_TREE_DEPTH,
  MAX_PAGE_LIMIT,
  MAX_TREE_DEPTH,
  MUTATING_METHODS,
  PASEO_AGENT_ID_ENV,
  type ActivityEntry,
  type ControlError,
  type ControlErrorCode,
  type EdgeSummary,
  type EntitySummary,
  type MutationResult,
  type NodeDetail,
  type NodeSummary,
  type Page,
  type ProjectSummary,
  type RpcMethod,
  type RpcMethods,
  type SpawnedAgent,
  type SpawnPlacement,
  type TreeLine
} from './protocol'

// Maps each RPC method onto WorkspaceGateway / AgentService calls. Holds no graph logic beyond resolving
// the caller, the project, and the spawn source, and shaping bounded read results.

export class ControlFailure extends Error {
  constructor(
    readonly code: ControlErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ControlFailure'
  }
}

// The caller as Paseo knows it. An agent acts as itself whether or not the canvas shows its own node.
export type Caller = {
  actor: Actor
  // The calling agent's own node while it is expanded; null while it is collapsed, and for the user.
  node: CanvasNode | null
  // The node that stands for the agent on its canvas: its own, or its nearest expanded owner's.
  anchorNodeId: string | null
  ownerAgentId: string | null
  projectId: string | null
}

export type ControlMethodsOptions = {
  gateway: WorkspaceGateway
  agentService: AgentService
  entities: EntityRegistry
  // How long to wait for Paseo to report a just-created agent.
  identityLookup: { timeoutMs: number; intervalMs: number }
}

type Handler = (params: unknown, caller: () => Promise<Caller>) => Promise<unknown>

export type ControlMethods = {
  has(method: string): method is RpcMethod
  // `agentId` is the caller's PASEO_AGENT_ID; absent for a person at a terminal, who may only read.
  call(method: RpcMethod, params: unknown, agentId: string | undefined): Promise<unknown>
}

// Commands an agent or the CLI may send through `execute`. Creation goes through `spawn`, which builds the
// seed itself, so callers cannot attach a forged resourceRef; viewport and workspace records are the UI's
// and reconciliation's.
const EXECUTABLE_COMMANDS = new Set<CanvasCommand['type']>([
  'connectNodes',
  'disconnectNodes',
  'moveNodes',
  'resizeNode',
  'reparent',
  'updateNode',
  'collapseNode',
  'expandNode',
  'collapseBranch',
  'expandBranch',
  'archiveNode',
  'archiveBranch',
  'restoreNode',
  'removeNode',
  'removeBranch'
])

// Config fields of the built-in entity types, as the CLI's typed flags fill them.
const CONFIG_FIELDS: Record<string, string> = {
  note: '{ body: string }  (--body)',
  agent:
    '{ prompt: string, provider?: string, model?: string, mode?: string }  (--prompt, --provider, --model, --mode). Not a node: starts a Paseo agent owned by you. Without a provider, the user’s saved default provider and its model apply; an unset mode is left to Paseo',
  image:
    '{ source: { kind: "path", path } | { kind: "asset", assetId }, caption?: string }  (--path, --asset, --caption)',
  webpage: '{ url: http(s) URL }  (--url)'
}

const TITLE_LIMIT = 120
const DETAIL_LIST_LIMIT = MAX_PAGE_LIMIT
const PROMPT_LIMIT = 100_000

export function createControlMethods(options: ControlMethodsOptions): ControlMethods {
  const { gateway, agentService, entities } = options

  async function resolveCaller(agentId: string | undefined): Promise<Caller> {
    if (agentId === undefined) {
      return { actor: { kind: 'user' }, node: null, anchorNodeId: null, ownerAgentId: null, projectId: null }
    }
    const deadline = Date.now() + options.identityLookup.timeoutMs
    for (;;) {
      const location = await agentService.locateAgent(agentId)
      const placement = location?.placements[0]
      if (location && placement) {
        const node = placement.nodeId === null ? null : ((await gateway.findNode(placement.nodeId))?.node ?? null)
        return {
          actor: { kind: 'agent', nodeId: node?.id ?? null, agentId },
          node,
          anchorNodeId: placement.anchorNodeId,
          ownerAgentId: location.parentAgentId,
          projectId: placement.projectId
        }
      }
      if (Date.now() + options.identityLookup.intervalMs > deadline) {
        throw new ControlFailure(
          'unknown-agent',
          `SPADE shows neither Paseo agent ${agentId} nor an agent that owns it. Only agents on a SPADE canvas, and the agents they own, can use this CLI; if this agent was just created, retry in a moment.`
        )
      }
      await delay(options.identityLookup.intervalMs)
    }
  }

  async function findProject(reference: string): Promise<Project> {
    const projects = gateway.listProjects()
    const byId = projects.find((project) => project.id === reference)
    if (byId) return byId
    const byName = projects.filter((project) => project.name === reference)
    if (byName.length === 1) return byName[0]
    if (byName.length > 1) {
      throw new ControlFailure('invalid-params', `Several projects are named "${reference}"; use the project id`)
    }
    throw new CanvasCommandError('unknown-project', `Unknown project: ${reference}`)
  }

  async function projectFor(caller: Caller, explicit: string | undefined): Promise<Project> {
    if (explicit !== undefined) return findProject(explicit)
    const project = caller.projectId === null ? null : gateway.getProject(caller.projectId)
    if (project) return project
    throw new ControlFailure(
      'project-required',
      'Name a project with --project <id|name> (run `spade projects` to list them)'
    )
  }

  async function locateNode(nodeId: string): Promise<{ projectId: string; node: CanvasNode }> {
    const found = await gateway.findNode(nodeId)
    if (!found) throw new CanvasCommandError('unknown-node', `Unknown node: ${nodeId}`)
    return found
  }

  async function locateEdge(edgeId: string): Promise<string> {
    for (const project of gateway.listProjects()) {
      const canvas = await gateway.getCanvas(project.id)
      if (canvas.edges.some((edge) => edge.id === edgeId)) return project.id
    }
    throw new CanvasCommandError('unknown-edge', `Unknown edge: ${edgeId}`)
  }

  async function execute(projectId: string, command: CanvasCommand, actor: Actor): Promise<MutationResult> {
    const outcome: CanvasCommandOutcome = await gateway.execute(projectId, command, actor)
    return { projectId, ...outcome }
  }

  // A pass-through to Paseo with the caller as parent. SPADE fills in only the provider Paseo requires,
  // from the user's saved default; Paseo applies its own rules to everything left unset.
  async function spawnAgent(input: Record<string, unknown>, caller: Caller): Promise<SpawnedAgent> {
    for (const [field, flag] of [
      ['placement', '--parent, --tree, --new-tree'],
      ['description', '--description'],
      ['project', '--project']
    ] as const) {
      if (input[field] !== undefined) {
        throw new ControlFailure('invalid-params', `An agent takes no ${flag}: it is not placed on the canvas but listed under you`)
      }
    }
    const config = fields(input.config, ['prompt', 'provider', 'model', 'mode'], 'config')
    const prompt = requiredText(config, 'prompt', 'config')
    if (prompt.length > PROMPT_LIMIT) throw new ControlFailure('invalid-params', `config.prompt exceeds ${PROMPT_LIMIT} characters`)
    const title = optionalText(input, 'title')
    if (caller.actor.kind !== 'agent') throw new ControlFailure('identity-required', 'Only an agent can start an agent it owns')
    const defaults = gateway.getSettings().agentDefaults
    const provider = optionalSetting(config, 'provider') ?? defaults?.provider
    if (provider === undefined) {
      throw new ControlFailure(
        'invalid-params',
        'Name the agent’s provider with --provider <id> (run `spade providers` to list them); the user has saved no default provider in SPADE'
      )
    }
    const model = optionalSetting(config, 'model') ?? (defaults?.provider === provider && defaults.model ? defaults.model : undefined)
    const mode = optionalSetting(config, 'mode')
    const { agentId } = await agentService.spawnChildAgent(caller.actor.agentId, {
      prompt,
      provider,
      ...(model === undefined ? {} : { model }),
      ...(mode === undefined ? {} : { mode }),
      ...(title === undefined ? {} : { title })
    })
    return { agentId, ownerAgentId: caller.actor.agentId }
  }

  async function spawnCommand(
    caller: Caller,
    placement: SpawnPlacement,
    node: NodeSeed,
    explicitProject: string | undefined
  ): Promise<{ projectId: string; command: CanvasCommand }> {
    // While the caller is collapsed, what it spawns belongs to its nearest expanded owner.
    const spawnFrom = (projectId: string, fallbackSource: string, target?: SpawnTarget) => {
      const sourceNodeId = caller.anchorNodeId !== null && caller.projectId === projectId ? caller.anchorNodeId : fallbackSource
      const command: CanvasCommand = {
        type: 'spawnChild',
        sourceNodeId,
        node,
        origin: 'spawned',
        ...(target === undefined ? {} : { target })
      }
      return { projectId, command }
    }

    switch (placement.kind) {
      case 'self':
        if (caller.anchorNodeId === null || caller.projectId === null) {
          throw new ControlFailure(
            'invalid-params',
            'Only an agent has a place on the canvas; name a target with --parent, --tree, or --new-tree'
          )
        }
        return spawnFrom(caller.projectId, caller.anchorNodeId)
      case 'child': {
        const { projectId } = await locateNode(placement.parentNodeId)
        return spawnFrom(projectId, placement.parentNodeId, { kind: 'child', parentNodeId: placement.parentNodeId })
      }
      case 'tree': {
        const { projectId } = await locateNode(placement.nodeId)
        return spawnFrom(projectId, placement.nodeId, { kind: 'tree', nodeId: placement.nodeId })
      }
      case 'new-tree': {
        const project = await projectFor(caller, explicitProject)
        if (caller.anchorNodeId !== null && caller.projectId === project.id) {
          return spawnFrom(project.id, caller.anchorNodeId, { kind: 'new-tree' })
        }
        return { projectId: project.id, command: { type: 'startTree', node } }
      }
    }
  }

  async function canvasOf(caller: Caller, explicit: string | undefined): Promise<Canvas> {
    return gateway.getCanvas((await projectFor(caller, explicit)).id)
  }

  const handlers: { [Method in RpcMethod]: Handler } = {
    async whoami(params, caller): Promise<RpcMethods['whoami']['result']> {
      fields(params, [])
      const self = await caller()
      const project = self.projectId === null ? null : gateway.getProject(self.projectId)
      const identity = {
        actor: self.actor,
        project: project && projectSummary(project),
        ownerAgentId: self.ownerAgentId,
        anchorNodeId: self.anchorNodeId
      }
      if (!self.node || self.projectId === null) return { ...identity, node: null, childIds: [] }
      const canvas = await gateway.getCanvas(self.projectId)
      const tree = indexTree(canvas)
      const node = canvas.nodes.find((candidate) => candidate.id === self.node!.id) ?? self.node
      return { ...identity, node: summarize(node, tree), childIds: tree.childrenOf(node.id).slice(0, DETAIL_LIST_LIMIT) }
    },

    async projects(params): Promise<RpcMethods['projects']['result']> {
      fields(params, [])
      return gateway.listProjects().map(projectSummary)
    },

    async tree(params, caller): Promise<RpcMethods['tree']['result']> {
      const input = fields(params, ['project', 'rootNodeId', 'depth', 'cursor', 'limit'])
      const rootNodeId = optionalText(input, 'rootNodeId')
      const depth = optionalInteger(input, 'depth', 0, MAX_TREE_DEPTH) ?? DEFAULT_TREE_DEPTH
      const self = await caller()
      const canvas =
        rootNodeId === undefined
          ? await canvasOf(self, optionalText(input, 'project'))
          : await gateway.getCanvas((await locateNode(rootNodeId)).projectId)
      const tree = indexTree(canvas)
      const nodes = new Map(canvas.nodes.map((node) => [node.id, node]))
      const lines: TreeLine[] = []
      const visit = (nodeId: string, level: number): void => {
        const node = nodes.get(nodeId)
        if (!node) return
        const atLimit = level >= depth
        lines.push({
          ...summarize(node, tree),
          depth: level,
          hiddenDescendants: atLimit ? tree.descendantsOf(nodeId).length : 0
        })
        if (!atLimit) for (const child of tree.childrenOf(nodeId)) visit(child, level + 1)
      }
      for (const root of rootNodeId === undefined ? tree.roots() : [rootNodeId]) visit(root, 0)
      return {
        ...page(lines, input),
        projectId: canvas.projectId,
        selfNodeId: self.projectId === canvas.projectId ? (self.node?.id ?? null) : null
      }
    },

    async nodes(params, caller): Promise<RpcMethods['nodes']['result']> {
      const input = fields(params, ['project', 'type', 'cursor', 'limit'])
      const type = optionalText(input, 'type')
      const canvas = await canvasOf(await caller(), optionalText(input, 'project'))
      const tree = indexTree(canvas)
      const matching = canvas.nodes.filter((node) => type === undefined || node.entityType === type)
      const result = page(matching, input)
      return { ...result, items: result.items.map((node) => summarize(node, tree)), projectId: canvas.projectId }
    },

    async node(params): Promise<RpcMethods['node']['result']> {
      const input = fields(params, ['nodeId'])
      const nodeId = requiredText(input, 'nodeId')
      const { projectId } = await locateNode(nodeId)
      const canvas = await gateway.getCanvas(projectId)
      const node = canvas.nodes.find((candidate) => candidate.id === nodeId)
      if (!node) throw new CanvasCommandError('unknown-node', `Unknown node: ${nodeId}`)
      const tree = indexTree(canvas)
      const runtime = agentService.runtimes(projectId).find((candidate) => candidate.nodeId === nodeId)
      const references: NodeDetail['references'] = canvas.edges
        .filter((edge) => edge.relation === 'references' && (edge.fromNodeId === nodeId || edge.toNodeId === nodeId))
        .slice(0, DETAIL_LIST_LIMIT)
        .map((edge) => ({
          edgeId: edge.id,
          direction: edge.fromNodeId === nodeId ? 'out' : 'in',
          nodeId: edge.fromNodeId === nodeId ? edge.toNodeId : edge.fromNodeId,
          ...(edge.label === undefined ? {} : { label: edge.label })
        }))
      return {
        ...summarize(node, tree),
        projectId,
        position: node.position,
        size: node.size ?? null,
        workspaceId: node.workspaceId,
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
        childIds: tree.childrenOf(nodeId).slice(0, DETAIL_LIST_LIMIT),
        references,
        context: describeNodeForAgent(canvas, entities, nodeId),
        runtime: runtime
          ? {
              status: runtime.status,
              activity: runtime.activity,
              resourceState: runtime.resourceState,
              provider: runtime.provider,
              model: runtime.model,
              mode: runtime.mode,
              pendingPermissions: runtime.pendingPermissions.length,
              lastError: runtime.lastError === null ? null : clip(runtime.lastError, 400)
            }
          : null
      }
    },

    async edges(params, caller): Promise<RpcMethods['edges']['result']> {
      const input = fields(params, ['project', 'nodeId', 'relation', 'cursor', 'limit'])
      const nodeId = optionalText(input, 'nodeId')
      const relation = optionalText(input, 'relation')
      if (relation !== undefined && relation !== 'child' && relation !== 'references') {
        throw new ControlFailure('invalid-params', 'relation must be "child" or "references"')
      }
      const canvas =
        nodeId === undefined
          ? await canvasOf(await caller(), optionalText(input, 'project'))
          : await gateway.getCanvas((await locateNode(nodeId)).projectId)
      const matching = canvas.edges.filter(
        (edge) =>
          (relation === undefined || edge.relation === relation) &&
          (nodeId === undefined || edge.fromNodeId === nodeId || edge.toNodeId === nodeId)
      )
      const result = page(matching, input)
      return {
        ...result,
        items: result.items.map(
          (edge): EdgeSummary => ({
            id: edge.id,
            relation: edge.relation,
            fromNodeId: edge.fromNodeId,
            toNodeId: edge.toNodeId,
            ...(edge.label === undefined ? {} : { label: edge.label }),
            ...(edge.origin === undefined ? {} : { origin: edge.origin })
          })
        ),
        projectId: canvas.projectId
      }
    },

    async activity(params, caller): Promise<RpcMethods['activity']['result']> {
      const input = fields(params, ['project', 'cursor', 'limit'])
      const canvas = await canvasOf(await caller(), optionalText(input, 'project'))
      const newestFirst = [...canvas.activity].reverse()
      const result = page(newestFirst, input)
      return {
        ...result,
        items: result.items.map(
          (entry): ActivityEntry => ({
            at: entry.at,
            actor: entry.actor,
            command: entry.command,
            summary: entry.summary,
            nodeIds: entry.nodeIds
          })
        ),
        projectId: canvas.projectId
      }
    },

    async entities(params): Promise<RpcMethods['entities']['result']> {
      fields(params, [])
      return entities.list().map(
        (definition): EntitySummary => ({
          type: definition.type,
          displayName: definition.displayName,
          version: definition.version,
          config: CONFIG_FIELDS[definition.type] ?? 'an object validated by the entity definition (use --config <json>)'
        })
      )
    },

    async providers(params): Promise<RpcMethods['providers']['result']> {
      fields(params, [])
      return agentService.listProviders()
    },

    async spawn(params, caller): Promise<RpcMethods['spawn']['result']> {
      const input = fields(params, ['project', 'entityType', 'config', 'title', 'description', 'placement'])
      const entityType = requiredText(input, 'entityType')
      if (!Object.hasOwn(input, 'config')) throw new ControlFailure('invalid-params', 'config is required')
      if (entityType === AGENT_ENTITY) return spawnAgent(input, await caller())
      const title = optionalText(input, 'title')
      const description = optionalText(input, 'description')
      const placement = spawnPlacement(input.placement)
      const self = await caller()
      const node: NodeSeed = {
        entityType,
        config: input.config,
        ...(title === undefined ? {} : { title }),
        ...(description === undefined ? {} : { shortDescription: description })
      }
      const { projectId, command } = await spawnCommand(self, placement, node, optionalText(input, 'project'))
      return execute(projectId, parseCanvasCommand(command), self.actor)
    },

    async execute(params, caller): Promise<RpcMethods['execute']['result']> {
      const input = fields(params, ['command'])
      const command = parseCanvasCommand(input.command)
      if (!EXECUTABLE_COMMANDS.has(command.type)) {
        throw new CanvasCommandError(
          'invalid-command',
          command.type === 'spawnChild' || command.type === 'startTree'
            ? 'Create nodes with the spawn method'
            : `${command.type} is not available to the CLI`
        )
      }
      if (command.type === 'updateNode' && command.patch.cachedPresentation !== undefined) {
        throw new CanvasCommandError('invalid-command', 'patch.cachedPresentation is managed by SPADE')
      }
      const projectId =
        command.type === 'disconnectNodes'
          ? await locateEdge(command.edgeId)
          : (await locateNode(firstNodeId(command))).projectId
      return execute(projectId, command, (await caller()).actor)
    }
  }

  return {
    has: (method): method is RpcMethod => Object.hasOwn(handlers, method),
    async call(method, params, agentId) {
      if (agentId === undefined && MUTATING_METHODS.includes(method)) {
        throw new ControlFailure(
          'identity-required',
          `This command makes a change but carries no agent identity (${PASEO_AGENT_ID_ENV} is not set), so SPADE cannot attribute it. Only an agent running in SPADE changes the canvas through this CLI; the user does so in SPADE itself. An agent must stop and tell the user.`
        )
      }
      let resolved: Promise<Caller> | null = null
      return handlers[method](params ?? {}, () => (resolved ??= resolveCaller(agentId)))
    }
  }
}

// Every failure that carries a stable code (the reducer's, the agent service's, the control methods' own)
// reaches the CLI with that code; anything else is internal.
export function toControlError(error: unknown): ControlError {
  const code = stableErrorCode(error)
  if (code !== null) return { code: code as ControlErrorCode, message: (error as Error).message }
  return { code: 'internal', message: error instanceof Error ? error.message : String(error) }
}

function firstNodeId(command: CanvasCommand): string {
  switch (command.type) {
    case 'connectNodes':
      return command.fromNodeId
    case 'moveNodes':
      return command.moves[0].nodeId
    case 'spawnChild':
      return command.sourceNodeId
    case 'startTree':
    case 'disconnectNodes':
    case 'upsertWorkspace':
    case 'setViewport':
      throw new CanvasCommandError('invalid-command', `${command.type} names no node`)
    default:
      return command.nodeId
  }
}

function spawnPlacement(value: unknown): SpawnPlacement {
  const input = record(value, 'placement')
  switch (input.kind) {
    case 'self':
    case 'new-tree':
      fields(input, ['kind'], 'placement')
      return { kind: input.kind }
    case 'child':
      fields(input, ['kind', 'parentNodeId'], 'placement')
      return { kind: 'child', parentNodeId: requiredText(input, 'parentNodeId', 'placement') }
    case 'tree':
      fields(input, ['kind', 'nodeId'], 'placement')
      return { kind: 'tree', nodeId: requiredText(input, 'nodeId', 'placement') }
    default:
      throw new ControlFailure('invalid-params', 'placement.kind must be "self", "child", "tree", or "new-tree"')
  }
}

function summarize(node: CanvasNode, tree: TreeIndex): NodeSummary {
  return {
    id: node.id,
    type: node.entityType,
    title: clip(node.title.replace(/\s+/g, ' ').trim(), TITLE_LIMIT),
    parentId: tree.parentOf(node.id),
    childCount: tree.childrenOf(node.id).length,
    collapsed: node.collapsed,
    branchCollapsed: node.branchCollapsed,
    archived: node.archived
  }
}

function projectSummary(project: Project): ProjectSummary {
  return { id: project.id, name: project.name, rootPath: project.rootPath }
}

function page<Item>(items: Item[], input: Record<string, unknown>): Page<Item> {
  const limit = optionalInteger(input, 'limit', 1, Number.MAX_SAFE_INTEGER) ?? DEFAULT_PAGE_LIMIT
  const bounded = Math.min(limit, MAX_PAGE_LIMIT)
  const cursor = input.cursor
  let offset = 0
  if (cursor !== undefined) {
    if (typeof cursor !== 'string' || !/^\d{1,9}$/.test(cursor)) {
      throw new ControlFailure('invalid-params', 'cursor must be a cursor returned by a previous page')
    }
    offset = Number(cursor)
  }
  const end = offset + bounded
  return { items: items.slice(offset, end), total: items.length, nextCursor: end < items.length ? String(end) : null }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ControlFailure('invalid-params', `${path} must be an object`)
  }
  return value as Record<string, unknown>
}

function fields(value: unknown, allowed: readonly string[], path = 'params'): Record<string, unknown> {
  const input = record(value, path)
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) throw new ControlFailure('invalid-params', `${path}.${key} is not a known field`)
  }
  return input
}

function optionalText(input: Record<string, unknown>, key: string, path = 'params'): string | undefined {
  const value = input[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new ControlFailure('invalid-params', `${path}.${key} must be a non-empty string`)
  }
  return value
}

function requiredText(input: Record<string, unknown>, key: string, path = 'params'): string {
  const value = optionalText(input, key, path)
  if (value === undefined) throw new ControlFailure('invalid-params', `${path}.${key} is required`)
  return value
}

// A config setting the caller may leave unset with null as well as by omission.
function optionalSetting(input: Record<string, unknown>, key: string): string | undefined {
  return input[key] === null ? undefined : optionalText(input, key, 'config')
}

function optionalInteger(input: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const value = input[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new ControlFailure('invalid-params', `params.${key} must be an integer of at least ${min}`)
  }
  return Math.min(value, max)
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
