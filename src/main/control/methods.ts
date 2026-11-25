import type { AgentService, WorkspaceGateway } from '../contracts'
import { stableErrorCode } from '../errors'
import { describeNodeForAgent } from '../../shared/agentContext'
import { AGENT_ENTITY, PASEO_AGENT_KIND, type AgentConfig } from '../../shared/builtinEntities'
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

export type Caller = {
  actor: Actor
  // The calling agent's own node; null for the user.
  node: CanvasNode | null
  projectId: string | null
}

export type ControlMethodsOptions = {
  gateway: WorkspaceGateway
  agentService: AgentService
  entities: EntityRegistry
  // How long to wait for a just-created agent's node to be reconciled onto the canvas.
  identityLookup: { timeoutMs: number; intervalMs: number }
}

type Handler = (params: unknown, caller: () => Promise<Caller>) => Promise<unknown>

// Who the request says is calling: an agent by its Paseo id, or a person who explicitly acts as the user.
export type CallerIdentity = { agentId: string | undefined; asUser: boolean }

export type ControlMethods = {
  has(method: string): method is RpcMethod
  call(method: RpcMethod, params: unknown, identity: CallerIdentity): Promise<unknown>
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
    '{ provider: string, model: string|null, mode: string|null, prompt: string|null }  (--prompt, --provider, --model, --mode; unset fields default to the caller’s own)',
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
    if (agentId === undefined) return { actor: { kind: 'user' }, node: null, projectId: null }
    const deadline = Date.now() + options.identityLookup.timeoutMs
    for (;;) {
      const found = await gateway.findNodeByResource({ provider: 'paseo', kind: PASEO_AGENT_KIND, id: agentId })
      if (found) {
        return { actor: { kind: 'agent', nodeId: found.node.id, agentId }, node: found.node, projectId: found.projectId }
      }
      if (Date.now() + options.identityLookup.intervalMs > deadline) {
        throw new ControlFailure(
          'unknown-agent',
          `No SPADE canvas node represents Paseo agent ${agentId}. Only agents shown on the SPADE canvas can use this CLI; if this agent was just created, retry in a moment.`
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

  function inheritedAgentSettings(caller: Caller): { provider: string; model: string | null; mode: string | null } | null {
    if (caller.node && caller.projectId) {
      const runtime = agentService.runtimes(caller.projectId).find((candidate) => candidate.nodeId === caller.node!.id)
      if (runtime) return { provider: runtime.provider, model: runtime.model, mode: runtime.mode }
      if (caller.node.entityType === AGENT_ENTITY && entities.has(AGENT_ENTITY)) {
        try {
          const config = entities.resolve<AgentConfig>(AGENT_ENTITY).parseConfig(caller.node.config)
          return { provider: config.provider, model: config.model, mode: config.mode }
        } catch {
          // Fall through to the app defaults.
        }
      }
    }
    return gateway.getSettings().agentDefaults
  }

  // Unset provider/model/mode follow the caller; model and mode follow only when the provider does.
  function agentConfig(raw: unknown, caller: Caller): unknown {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw
    const fields = raw as Record<string, unknown>
    const inherited = inheritedAgentSettings(caller)
    const provider = fields.provider ?? inherited?.provider
    const same = inherited !== null && provider === inherited.provider
    return {
      provider,
      model: fields.model !== undefined ? fields.model : same ? inherited.model : null,
      mode: fields.mode !== undefined ? fields.mode : same ? inherited.mode : null,
      prompt: fields.prompt ?? null
    }
  }

  async function spawnCommand(
    caller: Caller,
    placement: SpawnPlacement,
    node: NodeSeed,
    explicitProject: string | undefined
  ): Promise<{ projectId: string; command: CanvasCommand }> {
    const spawnFrom = (projectId: string, fallbackSource: string, target?: SpawnTarget) => {
      const sourceNodeId = caller.node && caller.projectId === projectId ? caller.node.id : fallbackSource
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
        if (!caller.node || caller.projectId === null) {
          throw new ControlFailure(
            'invalid-params',
            'Only an agent has a node of its own; name a target with --parent, --tree, or --new-tree'
          )
        }
        return spawnFrom(caller.projectId, caller.node.id)
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
        if (caller.node && caller.projectId === project.id) {
          return spawnFrom(project.id, caller.node.id, { kind: 'new-tree' })
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
      if (!self.node || self.projectId === null) return { actor: self.actor, project: null, node: null, childIds: [] }
      const canvas = await gateway.getCanvas(self.projectId)
      const tree = indexTree(canvas)
      const node = canvas.nodes.find((candidate) => candidate.id === self.node!.id) ?? self.node
      const project = gateway.getProject(self.projectId)
      return {
        actor: self.actor,
        project: project && projectSummary(project),
        node: summarize(node, tree),
        childIds: tree.childrenOf(node.id).slice(0, DETAIL_LIST_LIMIT)
      }
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
      const title = optionalText(input, 'title')
      const description = optionalText(input, 'description')
      const placement = spawnPlacement(input.placement)
      const self = await caller()
      const node: NodeSeed = {
        entityType,
        config: entityType === AGENT_ENTITY ? agentConfig(input.config, self) : input.config,
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
    },

    async prompt(params, caller): Promise<RpcMethods['prompt']['result']> {
      const input = fields(params, ['nodeId', 'text'])
      const nodeId = requiredText(input, 'nodeId')
      const text = requiredText(input, 'text')
      if (text.length > PROMPT_LIMIT) throw new ControlFailure('invalid-params', `text exceeds ${PROMPT_LIMIT} characters`)
      const { node } = await locateNode(nodeId)
      if (node.entityType !== AGENT_ENTITY) {
        throw new CanvasCommandError('invalid-command', `Node ${nodeId} is a ${node.entityType}, not an agent`)
      }
      await agentService.prompt(nodeId, { text }, (await caller()).actor)
      return { nodeId }
    }
  }

  return {
    has: (method): method is RpcMethod => Object.hasOwn(handlers, method),
    async call(method, params, { agentId, asUser }) {
      if (agentId !== undefined && asUser) {
        throw new ControlFailure('invalid-params', 'An agent acts as itself; --as-user is only for a person at a terminal')
      }
      if (agentId === undefined && !asUser && MUTATING_METHODS.includes(method)) {
        throw new ControlFailure(
          'identity-required',
          `This command changes the canvas but carries no agent identity (${PASEO_AGENT_ID_ENV} is not set), so SPADE cannot attribute it. An agent must stop and tell the user. A person at a terminal passes --as-user to act as the user.`
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
