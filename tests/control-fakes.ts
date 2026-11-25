import type {
  AgentService,
  AgentServiceEvent,
  MainEntityAdapter,
  WorkspaceGateway,
  WorkspaceGatewayEvent
} from '../src/main/contracts'
import type { AgentProviderInfo, AgentRuntime, AgentTimelinePage } from '../src/shared/agents'
import { createBuiltinEntityRegistry, PASEO_AGENT_KIND } from '../src/shared/builtinEntities'
import { applyCanvasCommand } from '../src/shared/canvasReducer'
import { CanvasCommandError, type CanvasCommand, type CanvasCommandOutcome, type NodeSeed } from '../src/shared/commands'
import {
  DEFAULT_APP_SETTINGS,
  DOMAIN_RECORD_VERSION,
  createEmptyCanvas,
  type Actor,
  type AppSettings,
  type Canvas,
  type CanvasNode,
  type Project,
  type ResourceRef
} from '../src/shared/domain'

// In-memory stand-ins for the control server's collaborators. The gateway applies the real reducer,
// so activity and errors are exactly what the production gateway records and raises.

const NOW = '2026-01-01T00:00:00.000Z'
const SYSTEM: Actor = { kind: 'system' }

export type ExecutedCommand = { projectId: string; command: CanvasCommand; actor: Actor }

export class FakeGateway implements WorkspaceGateway {
  readonly entities = createBuiltinEntityRegistry()
  readonly executed: ExecutedCommand[] = []
  settings: AppSettings = DEFAULT_APP_SETTINGS
  // Number of upcoming findNodeByResource calls that report nothing, as if reconciliation were still running.
  resourceMisses = 0
  resourceLookups = 0
  private readonly projects: Project[] = []
  private readonly canvases = new Map<string, Canvas>()
  private nextId = 0

  addProject(id: string, name: string, rootPath = `/work/${name}`): Project {
    const project: Project = { version: DOMAIN_RECORD_VERSION, id, name, rootPath, createdAt: NOW }
    this.projects.push(project)
    this.canvases.set(id, createEmptyCanvas(id))
    return project
  }

  // Applies a command as SPADE itself, without recording it in `executed`.
  seed(projectId: string, command: CanvasCommand): string {
    return this.apply(projectId, command, SYSTEM).nodeId!
  }

  seedTree(projectId: string, node: NodeSeed): string {
    return this.seed(projectId, { type: 'startTree', node })
  }

  seedChild(projectId: string, parentNodeId: string, node: NodeSeed): string {
    return this.seed(projectId, { type: 'spawnChild', sourceNodeId: parentNodeId, node, origin: 'spawned' })
  }

  canvas(projectId: string): Canvas {
    const canvas = this.canvases.get(projectId)
    if (!canvas) throw new Error(`no project ${projectId}`)
    return canvas
  }

  node(nodeId: string): CanvasNode {
    for (const canvas of this.canvases.values()) {
      const node = canvas.nodes.find((candidate) => candidate.id === nodeId)
      if (node) return node
    }
    throw new Error(`no node ${nodeId}`)
  }

  parentOf(nodeId: string): string | null {
    for (const canvas of this.canvases.values()) {
      const edge = canvas.edges.find((candidate) => candidate.relation === 'child' && candidate.toNodeId === nodeId)
      if (edge) return edge.fromNodeId
    }
    return null
  }

  listProjects(): Project[] {
    return [...this.projects]
  }

  getProject(projectId: string): Project | null {
    return this.projects.find((project) => project.id === projectId) ?? null
  }

  getSettings(): AppSettings {
    return this.settings
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<void> {
    this.settings = { ...this.settings, ...patch }
  }

  async getCanvas(projectId: string): Promise<Canvas> {
    const canvas = this.canvases.get(projectId)
    if (!canvas) throw new CanvasCommandError('unknown-project', `Unknown project: ${projectId}`)
    return canvas
  }

  async execute(projectId: string, command: CanvasCommand, actor: Actor): Promise<CanvasCommandOutcome> {
    this.executed.push({ projectId, command, actor })
    return this.apply(projectId, command, actor)
  }

  async findNodeByResource(ref: ResourceRef): Promise<{ projectId: string; node: CanvasNode } | null> {
    this.resourceLookups += 1
    if (this.resourceMisses > 0) {
      this.resourceMisses -= 1
      return null
    }
    for (const [projectId, canvas] of this.canvases) {
      const node = canvas.nodes.find(
        (candidate) =>
          candidate.resourceRef?.provider === ref.provider &&
          candidate.resourceRef.kind === ref.kind &&
          candidate.resourceRef.id === ref.id
      )
      if (node) return { projectId, node }
    }
    return null
  }

  async findNode(nodeId: string): Promise<{ projectId: string; node: CanvasNode } | null> {
    for (const [projectId, canvas] of this.canvases) {
      const node = canvas.nodes.find((candidate) => candidate.id === nodeId)
      if (node) return { projectId, node }
    }
    return null
  }

  registerEntityAdapter(adapter: MainEntityAdapter): void {
    void adapter
  }

  subscribe(listener: (event: WorkspaceGatewayEvent) => void): () => void {
    void listener
    return () => {}
  }

  private apply(projectId: string, command: CanvasCommand, actor: Actor): CanvasCommandOutcome {
    const canvas = this.canvases.get(projectId)
    if (!canvas) throw new CanvasCommandError('unknown-project', `Unknown project: ${projectId}`)
    const result = applyCanvasCommand(canvas, command, {
      actor,
      now: NOW,
      entities: this.entities,
      createId: () => `${projectId}-n${++this.nextId}`
    })
    this.canvases.set(projectId, result.canvas)
    return result.outcome
  }
}

export function agentSeed(agentId: string, title: string, config: Partial<Record<string, unknown>> = {}): NodeSeed {
  return {
    entityType: 'agent',
    title,
    config: { provider: 'claude', model: 'opus', mode: 'default', prompt: `Work on ${title}`, ...config },
    resourceRef: { provider: 'paseo', kind: PASEO_AGENT_KIND, id: agentId }
  }
}

export function noteSeed(title: string, body = `${title} body`): NodeSeed {
  return { entityType: 'note', title, config: { body } }
}

export class FakeAgentService implements AgentService {
  readonly prompts: Array<{ nodeId: string; text: string; actor: Actor }> = []
  // When set, the next calls of that operation reject with it.
  promptFailure: Error | null = null
  providersFailure: Error | null = null
  readonly runtimeList: AgentRuntime[] = []
  providers: AgentProviderInfo[] = [
    {
      id: 'claude',
      label: 'Claude',
      available: true,
      status: 'ready',
      error: null,
      models: [{ id: 'opus', label: 'Opus', isDefault: true }],
      modes: [{ id: 'default', label: 'Default' }],
      defaultModeId: 'default'
    }
  ]

  readonly entityAdapter: MainEntityAdapter = {
    type: 'agent',
    create: async () => ({ resourceRef: null })
  }

  addRuntime(runtime: Partial<AgentRuntime> & { projectId: string; nodeId: string; agentId: string }): void {
    this.runtimeList.push({
      resourceState: 'live',
      parentAgentId: null,
      provider: 'claude',
      model: 'opus',
      mode: 'default',
      title: null,
      status: 'running',
      activity: 'running',
      cwd: null,
      pendingPermissions: [],
      providerSubagents: [],
      lastError: null,
      updatedAt: NOW,
      ...runtime
    })
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  connection() {
    return { state: 'connected' as const, url: 'ws://127.0.0.1:6767', error: null }
  }

  async listProviders(): Promise<AgentProviderInfo[]> {
    if (this.providersFailure) throw this.providersFailure
    return this.providers
  }

  runtimes(projectId: string): AgentRuntime[] {
    return this.runtimeList.filter((runtime) => runtime.projectId === projectId)
  }

  async timeline(nodeId: string): Promise<AgentTimelinePage> {
    return { nodeId, epoch: null, items: [], olderCursor: null }
  }

  async prompt(nodeId: string, input: { text: string }, actor: Actor): Promise<void> {
    if (this.promptFailure) throw this.promptFailure
    this.prompts.push({ nodeId, text: input.text, actor })
  }

  async interrupt(): Promise<void> {}
  async respondToPermission(): Promise<void> {}

  async openProviderSubagent(nodeId: string): Promise<{ nodeId: string }> {
    return { nodeId }
  }

  subscribe(listener: (event: AgentServiceEvent) => void): () => void {
    void listener
    return () => {}
  }
}
