import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { AgentServiceError, createAgentService, type PaseoPort, type SpadeAgentService } from '../../src/main/agents'
import type { AgentServiceEvent, WorkspaceGatewayEvent } from '../../src/main/contracts'
import { SpadeWorkspaceGateway } from '../../src/main/gateway'
import {
  PaseoUnavailableError,
  type PaseoAdapterEvent,
  type PaseoAgentSnapshot,
  type PaseoTimelinePage,
  type ProviderSubagentListing,
  type SpawnAgentInput
} from '../../src/main/paseo'
import { AppDataStore, nodeFileOperations, type PersistenceFileOperations } from '../../src/main/persistence'
import { buildAgentContext, formatAgentContext } from '../../src/shared/agentContext'
import type { AgentProviderInfo, AgentRuntime, PaseoConnection, ProviderSubagentInfo } from '../../src/shared/agents'
import { createBuiltinEntityRegistry } from '../../src/shared/builtinEntities'
import { CanvasCommandError, type CanvasCommand } from '../../src/shared/commands'
import type { Actor, Canvas, CanvasNode, Project } from '../../src/shared/domain'

const entities = createBuiltinEntityRegistry()
const user: Actor = { kind: 'user' }
const OLD = '2026-11-20T10:00:00.000Z'

// A scripted stand-in for the Paseo adapter with the adapter's observable semantics: every operation
// rejects with PaseoUnavailableError unless connected, and events fire only when the script says so.
class FakePaseo implements PaseoPort {
  connectOnStart = true
  readonly agents = new Map<string, PaseoAgentSnapshot>()
  readonly subagents = new Map<string, ProviderSubagentListing>()
  readonly spawns: SpawnAgentInput[] = []
  readonly prompts: Array<{ agentId: string; text: string }> = []
  readonly calls: string[] = []
  watched: string[] = []
  // Runs inside spawnAgent after the agent exists in Paseo and before the call resolves.
  onSpawn: ((agent: PaseoAgentSnapshot) => Promise<void> | void) | null = null
  private current: PaseoConnection = { state: 'disconnected', url: 'ws://fake/ws', error: null }
  private readonly listeners = new Set<(event: PaseoAdapterEvent) => void>()
  private nextId = 1

  constructor(agents: PaseoAgentSnapshot[] = []) {
    for (const agent of agents) this.agents.set(agent.id, agent)
  }

  connection(): PaseoConnection {
    return this.current
  }

  subscribe(listener: (event: PaseoAdapterEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start(): Promise<void> {
    this.calls.push('start')
    if (this.connectOnStart) this.connect()
    else this.setState('connecting', 'connect ECONNREFUSED')
  }

  async stop(): Promise<void> {
    this.calls.push('stop')
    this.setState('disconnected', null)
  }

  connect(): void {
    this.setState('connected', null)
  }

  drop(): void {
    this.setState('reconnecting', 'socket closed')
  }

  emit(event: PaseoAdapterEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }

  updated(agentId: string, created = false): void {
    this.emit({ type: 'agent-updated', agentId, agent: this.agents.get(agentId)!, created })
  }

  async watchTimelines(agentIds: readonly string[]): Promise<void> {
    this.watched = [...agentIds]
  }

  async listProviders(cwd: string): Promise<AgentProviderInfo[]> {
    this.require(`listProviders ${cwd}`)
    return [{ id: 'claude', label: 'Claude', available: true, status: 'ready', error: null, models: [], modes: [], defaultModeId: 'default' }]
  }

  async spawnAgent(input: SpawnAgentInput): Promise<PaseoAgentSnapshot> {
    this.require('spawnAgent')
    this.spawns.push(input)
    const agent = snapshot(`spawned-${this.nextId++}`, {
      parentAgentId: input.parentAgentId ?? null,
      provider: input.provider,
      model: input.model ?? 'provider-default-model',
      mode: input.mode ?? 'provider-default-mode',
      title: input.title ?? null,
      cwd: input.cwd,
      status: 'running'
    })
    this.agents.set(agent.id, agent)
    await this.onSpawn?.(agent)
    return agent
  }

  async archiveAgent(agentId: string): Promise<string> {
    this.require(`archiveAgent ${agentId}`)
    const agent = this.agents.get(agentId)
    if (!agent) throw new Error(`Agent ${agentId} not found`)
    this.agents.set(agentId, { ...agent, archivedAt: OLD, status: 'closed' })
    return OLD
  }

  async getAgent(agentId: string): Promise<PaseoAgentSnapshot | null> {
    this.require(`getAgent ${agentId}`)
    return this.agents.get(agentId) ?? null
  }

  async listChildAgents(parentAgentIds: readonly string[]): Promise<PaseoAgentSnapshot[]> {
    this.require(`listChildAgents ${[...parentAgentIds].sort().join(',')}`)
    return [...this.agents.values()].filter((agent) => agent.parentAgentId && parentAgentIds.includes(agent.parentAgentId))
  }

  async sendPrompt(agentId: string, text: string): Promise<void> {
    this.require(`sendPrompt ${agentId}`)
    this.prompts.push({ agentId, text })
  }

  async interrupt(agentId: string): Promise<void> {
    this.require(`interrupt ${agentId}`)
  }

  async respondToPermission(agentId: string, requestId: string, behavior: 'allow' | 'deny'): Promise<void> {
    this.require(`respondToPermission ${agentId} ${requestId} ${behavior}`)
    const agent = this.agents.get(agentId)
    if (agent) this.agents.set(agentId, { ...agent, pendingPermissions: [], status: 'running' })
  }

  async agentTimeline(agentId: string): Promise<PaseoTimelinePage> {
    this.require(`agentTimeline ${agentId}`)
    return page(`agent ${agentId}`)
  }

  async listProviderSubagents(parentAgentId: string): Promise<ProviderSubagentListing> {
    this.require(`listProviderSubagents ${parentAgentId}`)
    return this.subagents.get(parentAgentId) ?? { observable: true, subagents: [] }
  }

  async providerSubagentTimeline(parentAgentId: string, subagentId: string): Promise<PaseoTimelinePage> {
    this.require(`providerSubagentTimeline ${parentAgentId} ${subagentId}`)
    return page(`sub-agent ${parentAgentId}/${subagentId}`)
  }

  count(prefix: string): number {
    return this.calls.filter((call) => call.startsWith(prefix)).length
  }

  private require(call: string): void {
    this.calls.push(call)
    if (this.current.state !== 'connected') throw new PaseoUnavailableError(`Paseo is not connected (${this.current.state}).`)
  }

  private setState(state: PaseoConnection['state'], error: string | null): void {
    this.current = { state, url: this.current.url, error }
    this.emit({ type: 'connection', connection: this.current })
  }
}

function snapshot(id: string, overrides: Partial<PaseoAgentSnapshot> = {}): PaseoAgentSnapshot {
  return {
    id,
    parentAgentId: null,
    workspaceId: 'paseo-workspace-1',
    title: null,
    provider: 'claude',
    model: 'claude-haiku-4-5',
    mode: 'default',
    status: 'idle',
    archivedAt: null,
    cwd: '/somewhere',
    createdAt: OLD,
    updatedAt: OLD,
    pendingPermissions: [],
    lastError: null,
    ...overrides
  }
}

function subagent(id: string, overrides: Partial<ProviderSubagentInfo> = {}): ProviderSubagentInfo {
  return { id, parentSubagentId: null, title: 'general-purpose', description: `Task ${id}`, status: 'running', updatedAt: OLD, ...overrides }
}

function page(text: string): PaseoTimelinePage {
  return {
    epoch: 'epoch-1',
    items: [{ id: 'item-1', timestamp: OLD, kind: 'assistant-message', text, images: [] }],
    olderCursor: null
  }
}

type Session = {
  gateway: SpadeWorkspaceGateway
  service: SpadeAgentService
  paseo: FakePaseo
  events: AgentServiceEvent[]
  gatewayEvents: WorkspaceGatewayEvent[]
  stop(): Promise<void>
}

type Fixture = {
  root: string
  projectDirectory: string
  project: Project
  instructionCalls: Array<{ nodeId: string; projectId: string }>
  // Delays every record write, to hold a command inside the gateway while events arrive.
  writeDelay: { ms: number }
  open(paseo: FakePaseo): Promise<Session>
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'spade-agents-'))
  const dataDirectory = join(root, 'data')
  const projectDirectory = join(root, 'project')
  await mkdir(projectDirectory)
  const instructionCalls: Array<{ nodeId: string; projectId: string }> = []
  const writeDelay = { ms: 0 }
  const files: PersistenceFileOperations = {
    ...nodeFileOperations,
    async writeNewFile(path, data) {
      if (writeDelay.ms > 0) await new Promise((resolve) => setTimeout(resolve, writeDelay.ms))
      return nodeFileOperations.writeNewFile(path, data)
    }
  }
  const openGateway = (): Promise<SpadeWorkspaceGateway> =>
    SpadeWorkspaceGateway.open({ store: new AppDataStore({ directory: dataDirectory, files }), entities })
  const sessions: Session[] = []
  try {
    const first = await openGateway()
    const { project } = await first.createProject(projectDirectory, 'Project')
    await first.flush()
    let firstGateway: SpadeWorkspaceGateway | null = first
    await run({
      root,
      projectDirectory,
      project,
      instructionCalls,
      writeDelay,
      async open(paseo) {
        const gateway = firstGateway ?? (await openGateway())
        firstGateway = null
        const service = createAgentService({
          gateway,
          paseo,
          entities,
          agentInstructions: ({ nodeId, project: owner }) => {
            instructionCalls.push({ nodeId, projectId: owner.id })
            return `Reach SPADE as node ${nodeId}.`
          },
          timing: { coalesceMs: 0, timelineDebounceMs: 20, providerCacheMs: 60_000 }
        })
        gateway.registerEntityAdapter(service.entityAdapter)
        const events: AgentServiceEvent[] = []
        const gatewayEvents: WorkspaceGatewayEvent[] = []
        service.subscribe((event) => events.push(event))
        gateway.subscribe((event) => gatewayEvents.push(event))
        await service.start()
        await service.whenIdle()
        const session: Session = {
          gateway,
          service,
          paseo,
          events,
          gatewayEvents,
          async stop() {
            await service.stop()
            await gateway.flush()
          }
        }
        sessions.push(session)
        return session
      }
    })
  } finally {
    for (const session of sessions) await session.service.stop()
    await rm(root, { recursive: true, force: true })
  }
}

async function canvasOf(session: Session, project: Project): Promise<Canvas> {
  return session.gateway.getCanvas(project.id)
}

function nodesFor(canvas: Canvas, kind: string, id: string): CanvasNode[] {
  return canvas.nodes.filter((node) => node.resourceRef?.provider === 'paseo' && node.resourceRef.kind === kind && node.resourceRef.id === id)
}

function onlyNode(canvas: Canvas, id: string, kind = 'agent'): CanvasNode {
  const nodes = nodesFor(canvas, kind, id)
  expect(nodes, `nodes for ${kind} ${id}`).toHaveLength(1)
  return nodes[0]
}

function parentEdgeOf(canvas: Canvas, nodeId: string) {
  return canvas.edges.find((edge) => edge.relation === 'child' && edge.toNodeId === nodeId) ?? null
}

function runtimeOf(session: Session, project: Project, nodeId: string): AgentRuntime | undefined {
  return session.service.runtimes(project.id).find((runtime) => runtime.nodeId === nodeId)
}

const agentSeed = (prompt: string, extra: Record<string, unknown> = {}) => ({
  entityType: 'agent',
  config: { provider: 'claude', model: 'claude-haiku-4-5', mode: null, prompt, ...extra }
})

async function spawnRoot(session: Session, project: Project, prompt = 'Plan the work'): Promise<string> {
  const outcome = await session.gateway.execute(project.id, { type: 'startTree', node: agentSeed(prompt) }, user)
  await session.service.whenIdle()
  return outcome.nodeId!
}

async function rejection(action: Promise<unknown>): Promise<{ code?: unknown; message: string }> {
  const error = await action.then(
    () => null,
    (reason: unknown) => reason as Error
  )
  expect(error, 'expected a rejection').not.toBeNull()
  return error as { code?: unknown; message: string }
}

test('spawns an agent in the project root and keeps the caller prompt unmodified', async () => {
  await withFixture(async ({ project, projectDirectory, instructionCalls, open }) => {
    const session = await open(new FakePaseo())
    await session.gateway.updateSettings({ agentDefaults: { provider: 'claude', model: 'claude-haiku-4-5', mode: 'bypassPermissions' } })

    const nodeId = await spawnRoot(session, project, 'Plan the work\nin detail')
    const canvas = await canvasOf(session, project)
    const [spawn] = session.paseo.spawns
    expect(spawn).toEqual({
      cwd: projectDirectory,
      provider: 'claude',
      model: 'claude-haiku-4-5',
      mode: 'bypassPermissions',
      prompt: `Plan the work\nin detail\n\nReach SPADE as node ${nodeId}.`
    })
    expect(instructionCalls).toEqual([{ nodeId, projectId: project.id }])

    const node = onlyNode(canvas, 'spawned-1')
    expect(node.id).toBe(nodeId)
    expect(node.config).toEqual({ provider: 'claude', model: 'claude-haiku-4-5', mode: 'bypassPermissions', prompt: 'Plan the work\nin detail' })
    expect(node.title).toBe('Plan the work')
    expect(canvas.workspaces).toHaveLength(1)
    expect(canvas.workspaces[0]).toMatchObject({ cwd: projectDirectory, paseoWorkspaceId: 'paseo-workspace-1' })
    expect(node.workspaceId).toBe(canvas.workspaces[0].id)
    expect(runtimeOf(session, project, nodeId)).toMatchObject({ resourceState: 'live', agentId: 'spawned-1', status: 'running', activity: 'running' })

    // The saved default mode belongs to its provider; another provider gets its own default.
    const second = await session.gateway.execute(
      project.id,
      { type: 'startTree', node: { ...agentSeed('Review'), config: { provider: 'codex', model: null, mode: null, prompt: 'Review', expansion: { read: true } }, title: 'Reviewer' } },
      user
    )
    expect(session.paseo.spawns[1]).toEqual({
      cwd: projectDirectory,
      provider: 'codex',
      prompt: `Review\n\nReach SPADE as node ${second.nodeId}.`,
      title: 'Reviewer'
    })
    const after = await canvasOf(session, project)
    expect(after.workspaces).toHaveLength(1)
    expect(after.nodes.find((candidate) => candidate.id === second.nodeId)).toMatchObject({
      title: 'Reviewer',
      workspaceId: canvas.workspaces[0].id,
      // The conversation's expansion override survives the adapter's config normalization.
      config: { provider: 'codex', model: 'provider-default-model', mode: 'provider-default-mode', prompt: 'Review', expansion: { read: true } }
    })
  })
})

test('a spawn Paseo cannot serve fails with a clear error and creates no node', async () => {
  await withFixture(async ({ project, open }) => {
    const paseo = new FakePaseo()
    paseo.connectOnStart = false
    const session = await open(paseo)
    const error = await rejection(session.gateway.execute(project.id, { type: 'startTree', node: agentSeed('Plan') }, user))
    expect(error).toBeInstanceOf(CanvasCommandError)
    expect(error.code).toBe('entity-create-failed')
    expect(error.message).toContain('Paseo is not connected')
    expect((await canvasOf(session, project)).nodes).toHaveLength(0)
  })
})

test('a spawn whose node cannot be created archives the agent it just created, which is then never adopted', async () => {
  await withFixture(async ({ project, open }) => {
    const session = await open(new FakePaseo())
    const rootNodeId = await spawnRoot(session, project)
    const { nodeId: planNodeId } = await session.gateway.execute(
      project.id,
      { type: 'spawnChild', sourceNodeId: rootNodeId, node: { entityType: 'note', config: { body: 'plan' } }, origin: 'spawned' },
      user
    )
    // The source node is removed while Paseo creates the agent.
    session.paseo.onSpawn = async () => {
      await session.gateway.execute(project.id, { type: 'removeNode', nodeId: planNodeId! }, user)
    }
    const actor: Actor = { kind: 'agent', nodeId: rootNodeId, agentId: 'spawned-1' }

    const error = await rejection(
      session.gateway.execute(project.id, { type: 'spawnChild', sourceNodeId: planNodeId!, node: agentSeed('Orphan'), origin: 'spawned' }, actor)
    )
    expect(error.code).toBe('unknown-node')
    expect(session.paseo.calls.filter((call) => call.startsWith('archiveAgent'))).toEqual(['archiveAgent spawned-2'])

    // Paseo still lists it as a child of the root agent; reconciliation must not give it a node.
    session.paseo.updated('spawned-2')
    session.paseo.updated('spawned-1')
    await session.service.whenIdle()
    const canvas = await canvasOf(session, project)
    expect(nodesFor(canvas, 'agent', 'spawned-2')).toHaveLength(0)
    expect(canvas.nodes.map((node) => node.id)).toEqual([rootNodeId])
    // Only the agent created by the failed call was archived.
    expect(session.paseo.count('archiveAgent')).toBe(1)
    expect(session.paseo.agents.get('spawned-1')?.archivedAt).toBeNull()
  })
})

test('an agent spawning through SPADE becomes the Paseo parent and the new node is attributed to it', async () => {
  await withFixture(async ({ project, open }) => {
    const session = await open(new FakePaseo())
    const rootNodeId = await spawnRoot(session, project)
    const actor: Actor = { kind: 'agent', nodeId: rootNodeId, agentId: 'spawned-1' }

    const outcome = await session.gateway.execute(
      project.id,
      { type: 'spawnChild', sourceNodeId: rootNodeId, node: agentSeed('Write tests'), origin: 'spawned' },
      actor
    )
    await session.service.whenIdle()
    expect(session.paseo.spawns[1].parentAgentId).toBe('spawned-1')

    const canvas = await canvasOf(session, project)
    expect(onlyNode(canvas, 'spawned-2').id).toBe(outcome.nodeId)
    expect(parentEdgeOf(canvas, outcome.nodeId!)).toMatchObject({ fromNodeId: rootNodeId, origin: 'spawned' })
    const spawned = canvas.activity.find((entry) => entry.nodeIds[0] === outcome.nodeId)
    expect(spawned?.actor).toEqual(actor)
  })
})

for (const order of ['before', 'after'] as const) {
  test(`an agent-spawned agent gets exactly one node when Paseo reports it ${order} the spawn resolves`, async () => {
    await withFixture(async ({ project, writeDelay, open }) => {
      const session = await open(new FakePaseo())
      const rootNodeId = await spawnRoot(session, project)
      session.paseo.onSpawn = async (agent) => {
        const report = (): void => session.paseo.emit({ type: 'agent-updated', agentId: agent.id, agent, created: true })
        if (order === 'before') {
          report()
          // Long enough for reconciliation to react while the spawn is still pending.
          await new Promise((resolve) => setTimeout(resolve, 50))
        } else {
          // Reported once the spawn resolved, while SPADE is still recording the workspace Paseo placed the
          // agent in (slowed down here) and the gateway has not persisted the node yet.
          agent.workspaceId = 'paseo-workspace-2'
          setTimeout(report, 0)
          writeDelay.ms = 50
        }
      }

      // A new tree, so a duplicate added by reconciliation (under the parent's node) would be visible.
      const outcome = await session.gateway.execute(
        project.id,
        {
          type: 'spawnChild',
          sourceNodeId: rootNodeId,
          node: agentSeed('Side quest'),
          origin: 'spawned',
          target: { kind: 'new-tree' }
        },
        { kind: 'agent', nodeId: rootNodeId, agentId: 'spawned-1' }
      )
      writeDelay.ms = 0
      await session.service.whenIdle()
      session.paseo.updated('spawned-2')
      await session.service.whenIdle()

      const canvas = await canvasOf(session, project)
      expect(onlyNode(canvas, 'spawned-2').id).toBe(outcome.nodeId)
      expect(parentEdgeOf(canvas, outcome.nodeId!)).toBeNull()
      expect(canvas.nodes).toHaveLength(2)
    })
  })
}

test('managed children and grandchildren appear once as collapsed delegated children, also across a restart', async () => {
  await withFixture(async ({ project, open }) => {
    const paseo = new FakePaseo()
    const session = await open(paseo)
    const rootNodeId = await spawnRoot(session, project)
    paseo.agents.set('child', snapshot('child', { parentAgentId: 'spawned-1', title: 'Child task', model: 'sonnet', mode: 'plan' }))
    paseo.agents.set('grandchild', snapshot('grandchild', { parentAgentId: 'child' }))
    paseo.agents.set('stranger', snapshot('stranger', { parentAgentId: 'someone-else' }))

    for (let round = 0; round < 3; round += 1) {
      paseo.updated('child', round === 0)
      paseo.updated('grandchild', round === 0)
      paseo.updated('stranger', round === 0)
    }
    await session.service.whenIdle()

    const canvas = await canvasOf(session, project)
    const child = onlyNode(canvas, 'child')
    const grandchild = onlyNode(canvas, 'grandchild')
    expect(nodesFor(canvas, 'agent', 'stranger')).toHaveLength(0)
    expect(child).toMatchObject({
      collapsed: true,
      title: 'Child task',
      workspaceId: canvas.nodes.find((node) => node.id === rootNodeId)!.workspaceId,
      config: { provider: 'claude', model: 'sonnet', mode: 'plan', prompt: null }
    })
    expect(grandchild.collapsed).toBe(true)
    expect(parentEdgeOf(canvas, child.id)).toMatchObject({ fromNodeId: rootNodeId, origin: 'delegated' })
    expect(parentEdgeOf(canvas, grandchild.id)).toMatchObject({ fromNodeId: child.id, origin: 'delegated' })
    expect(canvas.activity.find((entry) => entry.nodeIds[0] === child.id)?.actor).toEqual({ kind: 'system' })
    expect(runtimeOf(session, project, grandchild.id)).toMatchObject({ resourceState: 'live', parentAgentId: 'child' })

    await session.stop()
    const restarted = await open(new FakePaseo([...paseo.agents.values()]))
    restarted.paseo.updated('child')
    await restarted.service.whenIdle()
    const after = await canvasOf(restarted, project)
    expect(after.nodes.map((node) => node.id).sort()).toEqual(canvas.nodes.map((node) => node.id).sort())
    expect(after.edges).toHaveLength(canvas.edges.length)
    expect(runtimeOf(restarted, project, child.id)).toMatchObject({ resourceState: 'live', title: 'Child task' })
  })
})

test('after a restart with Paseo down nodes keep their cached summary and recover when it connects', async () => {
  await withFixture(async ({ project, open }) => {
    const paseo = new FakePaseo()
    const session = await open(paseo)
    const rootNodeId = await spawnRoot(session, project)
    const summary = (await canvasOf(session, project)).nodes[0].cachedPresentation?.summary
    expect(summary).toBe('claude · claude-haiku-4-5 · Running')
    await session.stop()

    const down = new FakePaseo([...paseo.agents.values(), snapshot('late-child', { parentAgentId: 'spawned-1' })])
    down.connectOnStart = false
    const restarted = await open(down)
    expect(restarted.service.connection().state).toBe('connecting')
    expect(runtimeOf(restarted, project, rootNodeId)).toMatchObject({ resourceState: 'stale', provider: 'claude', model: 'claude-haiku-4-5' })
    let canvas = await canvasOf(restarted, project)
    expect(canvas.nodes).toHaveLength(1)
    expect(canvas.nodes[0].cachedPresentation?.summary).toBe(summary)

    down.connect()
    await restarted.service.whenIdle()
    canvas = await canvasOf(restarted, project)
    expect(parentEdgeOf(canvas, onlyNode(canvas, 'late-child').id)).toMatchObject({ fromNodeId: rootNodeId, origin: 'delegated' })
    expect(runtimeOf(restarted, project, rootNodeId)?.resourceState).toBe('live')
    expect(restarted.events.some((event) => event.type === 'connection' && event.connection.state === 'connected')).toBe(true)
  })
})

test('agents become stale while Paseo is unreachable and missing when Paseo lost them, never removed', async () => {
  await withFixture(async ({ project, open }) => {
    const paseo = new FakePaseo()
    const session = await open(paseo)
    const nodeId = await spawnRoot(session, project)

    paseo.drop()
    await session.service.whenIdle()
    expect(runtimeOf(session, project, nodeId)).toMatchObject({ resourceState: 'stale', status: 'running' })
    expect((await rejection(session.service.prompt(nodeId, { text: 'hi' }, user))).code).toBe('paseo-unavailable')

    paseo.agents.delete('spawned-1')
    paseo.connect()
    await session.service.whenIdle()
    expect(runtimeOf(session, project, nodeId)).toMatchObject({ resourceState: 'missing', activity: 'closed' })
    expect((await canvasOf(session, project)).nodes.map((node) => node.id)).toEqual([nodeId])
    expect(paseo.watched).toEqual([])
    const error = await rejection(session.service.prompt(nodeId, { text: 'hi' }, user))
    expect(error.code).toBe('agent-missing')
    expect(paseo.prompts).toEqual([])
  })
})

test('provider sub-agents are listed, kept while unobservable, and opened on demand exactly once', async () => {
  await withFixture(async ({ project, open }) => {
    const paseo = new FakePaseo()
    const session = await open(paseo)
    const nodeId = await spawnRoot(session, project)
    paseo.subagents.set('spawned-1', { observable: true, subagents: [subagent('toolu_1'), subagent('toolu_2', { parentSubagentId: 'toolu_1' })] })
    paseo.emit({ type: 'provider-subagents', parentAgentId: 'spawned-1', subagentId: 'toolu_1' })
    await session.service.whenIdle()
    expect(runtimeOf(session, project, nodeId)?.providerSubagents.map((row) => row.id)).toEqual(['toolu_1', 'toolu_2'])
    expect((await canvasOf(session, project)).nodes).toHaveLength(1)

    paseo.subagents.set('spawned-1', { observable: false, reason: 'agent archived' })
    paseo.emit({ type: 'provider-subagents', parentAgentId: 'spawned-1', subagentId: 'toolu_1' })
    await session.service.whenIdle()
    expect(runtimeOf(session, project, nodeId)?.providerSubagents.map((row) => row.id)).toEqual(['toolu_1', 'toolu_2'])

    const first = await session.service.openProviderSubagent(nodeId, 'toolu_1', user)
    const again = await session.service.openProviderSubagent(nodeId, 'toolu_1', user)
    expect(again.nodeId).toBe(first.nodeId)
    await session.service.whenIdle()
    const canvas = await canvasOf(session, project)
    const opened = onlyNode(canvas, 'spawned-1/toolu_1', 'provider-subagent')
    expect(opened).toMatchObject({ id: first.nodeId, title: 'Task toolu_1', collapsed: false, config: { provider: 'claude', model: null, mode: null, prompt: null } })
    expect(parentEdgeOf(canvas, opened.id)).toMatchObject({ fromNodeId: nodeId, origin: 'delegated' })
    // The parent's list is unobservable, so the sub-agent shows its last known row as stale.
    expect(runtimeOf(session, project, opened.id)).toMatchObject({
      resourceState: 'stale',
      agentId: 'toolu_1',
      parentAgentId: 'spawned-1',
      status: 'running',
      providerSubagents: [expect.objectContaining({ id: 'toolu_2' })]
    })

    paseo.subagents.set('spawned-1', { observable: true, subagents: [subagent('toolu_1', { status: 'completed' })] })
    paseo.emit({ type: 'provider-subagents', parentAgentId: 'spawned-1', subagentId: 'toolu_1' })
    await session.service.whenIdle()
    expect(runtimeOf(session, project, opened.id)).toMatchObject({ resourceState: 'live', status: 'completed', activity: 'idle' })

    expect((await rejection(session.service.openProviderSubagent(nodeId, 'toolu_9', user))).code).toBe('unknown-subagent')
    for (const action of [
      session.service.prompt(opened.id, { text: 'hi' }, user),
      session.service.interrupt(opened.id),
      session.service.respondToPermission(opened.id, 'request', 'allow')
    ]) {
      expect((await rejection(action)).code).toBe('unsupported-agent-action')
    }
  })
})

test('runtime events and cached summaries are written only when something changed', async () => {
  await withFixture(async ({ project, open }) => {
    const paseo = new FakePaseo()
    const session = await open(paseo)
    const nodeId = await spawnRoot(session, project)
    const runtimeEvents = (): number => session.events.filter((event) => event.type === 'runtime' && event.runtime.nodeId === nodeId).length
    const summaryWrites = (): number =>
      session.gatewayEvents.filter((event) => event.type === 'canvas-changed' && event.command.type === 'updateNode').length
    const events = runtimeEvents()
    const writes = summaryWrites()
    expect(writes).toBe(1)

    for (let round = 0; round < 3; round += 1) paseo.updated('spawned-1')
    await session.service.whenIdle()
    expect(runtimeEvents()).toBe(events)
    expect(summaryWrites()).toBe(writes)

    // A timestamp-only change is a runtime change, not a summary change.
    paseo.agents.set('spawned-1', { ...paseo.agents.get('spawned-1')!, updatedAt: '2026-11-21T09:00:00.000Z' })
    paseo.updated('spawned-1')
    await session.service.whenIdle()
    expect(runtimeEvents()).toBe(events + 1)
    expect(summaryWrites()).toBe(writes)

    paseo.agents.set('spawned-1', { ...paseo.agents.get('spawned-1')!, status: 'idle', title: 'Planning the work' })
    paseo.updated('spawned-1')
    paseo.updated('spawned-1')
    await session.service.whenIdle()
    expect(runtimeEvents()).toBe(events + 2)
    expect(summaryWrites()).toBe(writes + 1)
    const node = (await canvasOf(session, project)).nodes[0]
    expect(node.title).toBe('Planning the work')
    expect(node.cachedPresentation?.summary).toBe('claude · claude-haiku-4-5 · Idle')

    // A title the user chose is never replaced.
    await session.gateway.execute(project.id, { type: 'updateNode', nodeId, patch: { title: 'My planner' } }, user)
    paseo.agents.set('spawned-1', { ...paseo.agents.get('spawned-1')!, title: 'Something else' })
    paseo.updated('spawned-1')
    await session.service.whenIdle()
    expect((await canvasOf(session, project)).nodes[0].title).toBe('My planner')
  })
})

test('a service started again after a stop watches its agents’ timelines again', async () => {
  await withFixture(async ({ project, open }) => {
    const paseo = new FakePaseo()
    const session = await open(paseo)
    await spawnRoot(session, project)
    expect(paseo.watched).toEqual(['spawned-1'])

    await session.service.stop()
    paseo.watched = []
    await session.service.start()
    await session.service.whenIdle()
    expect(paseo.watched).toEqual(['spawned-1'])
  })
})

test('timelines route to the agent or the provider sub-agent and growth is reported per node, debounced', async () => {
  await withFixture(async ({ project, open }) => {
    const paseo = new FakePaseo()
    const session = await open(paseo)
    const nodeId = await spawnRoot(session, project)
    expect(paseo.watched).toEqual(['spawned-1'])
    paseo.subagents.set('spawned-1', { observable: true, subagents: [subagent('toolu_1')] })
    const { nodeId: subNodeId } = await session.service.openProviderSubagent(nodeId, 'toolu_1', user)

    const agentPage = await session.service.timeline(nodeId)
    expect(agentPage).toMatchObject({ nodeId, epoch: 'epoch-1', items: [{ text: 'agent spawned-1' }] })
    const subPage = await session.service.timeline(subNodeId)
    expect(subPage).toMatchObject({ nodeId: subNodeId, items: [{ text: 'sub-agent spawned-1/toolu_1' }] })

    for (let burst = 0; burst < 5; burst += 1) {
      paseo.emit({ type: 'timeline', agentId: 'spawned-1', reset: false })
      paseo.emit({ type: 'provider-subagent-timeline', parentAgentId: 'spawned-1', subagentId: 'toolu_1' })
    }
    await new Promise((resolve) => setTimeout(resolve, 60))
    const timelineEvents = session.events.filter((event) => event.type === 'timeline')
    expect(timelineEvents).toEqual([
      { type: 'timeline', nodeId },
      { type: 'timeline', nodeId: subNodeId }
    ])

    const note = await session.gateway.execute(project.id, { type: 'startTree', node: { entityType: 'note', config: { body: 'x' } } }, user)
    expect((await rejection(session.service.timeline(note.nodeId!))).code).toBe('not-an-agent')
    expect((await rejection(session.service.timeline('nope'))).code).toBe('unknown-node')
  })
})

test('a prompt carries the bounded context block for nodes on the same canvas and rejects unknown ones', async () => {
  await withFixture(async ({ root, project, open }) => {
    const paseo = new FakePaseo()
    const session = await open(paseo)
    const nodeId = await spawnRoot(session, project)
    const note = await session.gateway.execute(
      project.id,
      { type: 'spawnChild', sourceNodeId: nodeId, node: { entityType: 'note', config: { body: 'Use the blue button' }, title: 'Hint' }, origin: 'spawned' },
      user
    )
    await session.service.prompt(nodeId, { text: 'Continue', contextNodeIds: [note.nodeId!] }, user)
    const canvas = await canvasOf(session, project)
    const block = formatAgentContext(buildAgentContext(canvas, entities, nodeId, [note.nodeId!]))
    expect(block).toContain('Use the blue button')
    expect(paseo.prompts).toEqual([{ agentId: 'spawned-1', text: `Continue\n\n${block}` }])

    await session.service.prompt(nodeId, { text: 'Plain' }, user)
    expect(paseo.prompts[1]).toEqual({ agentId: 'spawned-1', text: 'Plain' })

    // A node on another project's canvas is not this agent's context.
    const otherDirectory = join(root, 'other')
    await mkdir(otherDirectory)
    const { project: other } = await session.gateway.createProject(otherDirectory)
    const foreign = await session.gateway.execute(other.id, { type: 'startTree', node: { entityType: 'note', config: { body: 'secret' } } }, user)
    for (const ids of [['missing-node'], [note.nodeId!, foreign.nodeId!]]) {
      const error = await rejection(session.service.prompt(nodeId, { text: 'Again', contextNodeIds: ids }, user))
      expect(error).toBeInstanceOf(AgentServiceError)
      expect(error.code).toBe('unknown-node')
    }
    expect((await rejection(session.service.prompt(note.nodeId!, { text: 'hi' }, user))).code).toBe('not-an-agent')
    expect((await rejection(session.service.prompt('nope', { text: 'hi' }, user))).code).toBe('unknown-node')
    expect((await rejection(session.service.prompt(nodeId, { text: '  ' }, user))).code).toBe('invalid-argument')
    expect(paseo.prompts).toHaveLength(2)
  })
})

test('a prompt from an agent starts with one line naming the sending node; a user prompt is sent unchanged', async () => {
  await withFixture(async ({ project, open }) => {
    const paseo = new FakePaseo()
    const session = await open(paseo)
    const receiver = await spawnRoot(session, project, 'Receive work')
    const sender = await spawnRoot(session, project, 'Send work')
    await session.gateway.execute(project.id, { type: 'updateNode', nodeId: sender, patch: { title: 'Lead\n  planner' } }, user)
    const note = await session.gateway.execute(
      project.id,
      { type: 'spawnChild', sourceNodeId: receiver, node: { entityType: 'note', config: { body: 'Use the blue button' }, title: 'Hint' }, origin: 'spawned' },
      user
    )

    await session.service.prompt(receiver, { text: 'Run the tests' }, { kind: 'agent', nodeId: sender, agentId: 'spawned-2' })
    await session.service.prompt(receiver, { text: 'And this', contextNodeIds: [note.nodeId!] }, { kind: 'agent', nodeId: sender, agentId: 'spawned-2' })
    await session.service.prompt(receiver, { text: 'From me' }, user)

    const block = formatAgentContext(buildAgentContext(await canvasOf(session, project), entities, receiver, [note.nodeId!]))
    const from = `[Prompt from SPADE agent node "Lead planner" (${sender})]`
    expect(paseo.prompts).toEqual([
      { agentId: 'spawned-1', text: `${from}\nRun the tests` },
      { agentId: 'spawned-1', text: `${from}\nAnd this\n\n${block}` },
      { agentId: 'spawned-1', text: 'From me' }
    ])
  })
})

test('answering a permission refreshes the agent promptly; interrupting reaches Paseo', async () => {
  await withFixture(async ({ project, open }) => {
    const paseo = new FakePaseo()
    const session = await open(paseo)
    const nodeId = await spawnRoot(session, project)
    const request = { id: 'perm-1', kind: 'tool', name: 'Write', title: 'Write ok.txt', description: null, detail: 'ok.txt' }
    paseo.agents.set('spawned-1', { ...paseo.agents.get('spawned-1')!, status: 'idle', pendingPermissions: [request] })
    paseo.emit({ type: 'permissions', agentId: 'spawned-1' })
    await session.service.whenIdle()
    expect(runtimeOf(session, project, nodeId)).toMatchObject({ activity: 'attention', pendingPermissions: [request] })
    expect((await canvasOf(session, project)).nodes[0].cachedPresentation?.summary).toBe(
      'claude · claude-haiku-4-5 · Needs attention · 1 permission request'
    )

    await session.service.respondToPermission(nodeId, 'perm-1', 'allow')
    expect(paseo.calls).toContain('respondToPermission spawned-1 perm-1 allow')
    await session.service.whenIdle()
    expect(runtimeOf(session, project, nodeId)).toMatchObject({ activity: 'running', pendingPermissions: [] })

    await session.service.interrupt(nodeId)
    expect(paseo.calls).toContain('interrupt spawned-1')
  })
})

test('removing an agent node never touches Paseo and a removed delegated child is not added back', async () => {
  await withFixture(async ({ root, project, open }) => {
    const paseo = new FakePaseo()
    const session = await open(paseo)
    const rootNodeId = await spawnRoot(session, project)
    paseo.agents.set('child', snapshot('child', { parentAgentId: 'spawned-1' }))
    paseo.updated('child', true)
    await session.service.whenIdle()
    const child = onlyNode(await canvasOf(session, project), 'child')
    const callsBefore = paseo.calls.length

    await session.gateway.execute(project.id, { type: 'removeNode', nodeId: child.id }, user)
    paseo.updated('child')
    paseo.updated('spawned-1')
    await session.service.whenIdle()
    expect(nodesFor(await canvasOf(session, project), 'agent', 'child')).toHaveLength(0)
    expect(session.service.runtimes(project.id).map((runtime) => runtime.nodeId)).toEqual([rootNodeId])

    const archive: CanvasCommand = { type: 'archiveNode', nodeId: rootNodeId }
    await session.gateway.execute(project.id, archive, user)
    await session.service.whenIdle()
    const mutations = paseo.calls.slice(callsBefore).filter((call) => /^(interrupt|sendPrompt|respondToPermission|spawnAgent)/.test(call))
    expect(mutations).toEqual([])
    expect(paseo.agents.has('child')).toBe(true)

    // SPADE wrote only into its own data directory.
    expect((await readdir(root)).sort()).toEqual(['data', 'project'])
    expect(await readdir(join(root, 'project'))).toEqual([])
  })
})

test('a removed delegated child stays removed across a restart, and opening a provider sub-agent again brings it back', async () => {
  await withFixture(async ({ project, open }) => {
    const paseo = new FakePaseo()
    const session = await open(paseo)
    const rootNodeId = await spawnRoot(session, project)
    paseo.agents.set('child', snapshot('child', { parentAgentId: 'spawned-1' }))
    paseo.subagents.set('spawned-1', { observable: true, subagents: [subagent('toolu_1')] })
    paseo.updated('child', true)
    await session.service.whenIdle()
    const child = onlyNode(await canvasOf(session, project), 'child')
    const opened = await session.service.openProviderSubagent(rootNodeId, 'toolu_1', user)

    await session.gateway.execute(project.id, { type: 'removeNode', nodeId: child.id }, user)
    await session.gateway.execute(project.id, { type: 'removeNode', nodeId: opened.nodeId }, user)
    await session.service.whenIdle()
    await session.stop()

    // A fresh service over the same records, with Paseo reporting the same agents.
    const restarted = await open(new FakePaseo([...paseo.agents.values()]))
    restarted.paseo.subagents.set('spawned-1', { observable: true, subagents: [subagent('toolu_1')] })
    restarted.paseo.updated('child')
    restarted.paseo.updated('spawned-1')
    await restarted.service.whenIdle()
    let canvas = await canvasOf(restarted, project)
    expect(nodesFor(canvas, 'agent', 'child')).toHaveLength(0)
    expect(nodesFor(canvas, 'provider-subagent', 'spawned-1/toolu_1')).toHaveLength(0)
    expect(canvas.nodes.map((node) => node.id)).toEqual([rootNodeId])

    // The user asking for the sub-agent explicitly is not reconciliation: its node comes back.
    const reopened = await restarted.service.openProviderSubagent(rootNodeId, 'toolu_1', user)
    canvas = await canvasOf(restarted, project)
    expect(onlyNode(canvas, 'spawned-1/toolu_1', 'provider-subagent').id).toBe(reopened.nodeId)
    expect(canvas.dismissedResources).toEqual([{ provider: 'paseo', kind: 'agent', id: 'child' }])
  })
})

test('providers are listed for the project root and cached briefly', async () => {
  await withFixture(async ({ projectDirectory, open }) => {
    const paseo = new FakePaseo()
    const session = await open(paseo)
    const providers = await session.service.listProviders()
    expect(providers.map((provider) => provider.id)).toEqual(['claude'])
    await session.service.listProviders()
    expect(paseo.calls.filter((call) => call.startsWith('listProviders'))).toEqual([`listProviders ${projectDirectory}`])
  })
})
