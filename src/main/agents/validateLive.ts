// Live check of the agent service against a running Paseo daemon; not part of `npm test`. It uses a real
// app-data store and gateway in temp directories, spawns three throwaway agents in a scratch project,
// restarts SPADE's side over the same data, and archives every agent it created.
//
//   npx esbuild src/main/agents/validateLive.ts --bundle --platform=node --format=esm \
//     --packages=external --outfile=out/agents/validateLive.mjs && node out/agents/validateLive.mjs
//
// Environment: SPADE_PASEO_URL (else discovered), SPADE_AGENTS_VALIDATE_PROVIDER (claude),
// SPADE_AGENTS_VALIDATE_MODEL (claude-haiku-4-5), SPADE_AGENTS_VALIDATE_TIMEOUT_MS (240000).
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SpadeWorkspaceGateway } from '../gateway'
import { createPaseoAdapter, type PaseoAdapter } from '../paseo'
import { AppDataStore } from '../persistence'
import type { AgentRuntime, ConversationItem } from '../../shared/agents'
import { createBuiltinEntityRegistry } from '../../shared/builtinEntities'
import type { Actor, Canvas, Project } from '../../shared/domain'
import { createAgentService, type SpadeAgentService } from '.'

const provider = process.env.SPADE_AGENTS_VALIDATE_PROVIDER ?? 'claude'
const model = process.env.SPADE_AGENTS_VALIDATE_MODEL ?? 'claude-haiku-4-5'
const timeoutMs = Number(process.env.SPADE_AGENTS_VALIDATE_TIMEOUT_MS ?? 240_000)
const mode = 'bypassPermissions'
const INSTRUCTIONS = '(SPADE validation run: there is no SPADE CLI in this session.)'
const user: Actor = { kind: 'user' }
const entities = createBuiltinEntityRegistry()

type Spade = { gateway: SpadeWorkspaceGateway; adapter: PaseoAdapter; service: SpadeAgentService }

function log(step: string, data: unknown): void {
  process.stdout.write(`${step}: ${JSON.stringify(data)}\n`)
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Check failed: ${message}`)
  log('ok', message)
}

async function waitFor<T>(label: string, read: () => Promise<T | null> | T | null, limitMs = timeoutMs): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = await read()
    if (value !== null) {
      log('waited', { label, ms: Date.now() - started })
      return value
    }
    if (Date.now() - started > limitMs) throw new Error(`Timed out after ${limitMs} ms waiting for ${label}.`)
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
}

async function openSpade(dataDirectory: string): Promise<Spade> {
  const gateway = await SpadeWorkspaceGateway.open({ store: new AppDataStore({ directory: dataDirectory }), entities })
  const adapter = createPaseoAdapter({ setting: gateway.getSettings().paseoUrl })
  const service = createAgentService({ gateway, paseo: adapter, entities, agentInstructions: () => INSTRUCTIONS })
  gateway.registerEntityAdapter(service.entityAdapter)
  await service.start()
  await adapter.ready()
  await service.whenIdle()
  return { gateway, adapter, service }
}

async function closeSpade({ gateway, service }: Spade): Promise<void> {
  await service.stop()
  await gateway.flush()
}

function runtimeOf(spade: Spade, project: Project, nodeId: string): AgentRuntime | null {
  return spade.service.runtimes(project.id).find((runtime) => runtime.nodeId === nodeId) ?? null
}

function kinds(items: ConversationItem[]): string[] {
  return items.map((item) => (item.kind === 'tool-call' ? `tool:${item.toolKind}:${item.status}` : item.kind))
}

function lastAssistantText(items: ConversationItem[]): string | null {
  const last = [...items].reverse().find((item) => item.kind === 'assistant-message')
  return last?.kind === 'assistant-message' ? last.text : null
}

function describeCanvas(canvas: Canvas): unknown[] {
  return canvas.nodes.map((node) => {
    const edge = canvas.edges.find((candidate) => candidate.relation === 'child' && candidate.toNodeId === node.id)
    return {
      id: node.id.slice(0, 8),
      type: node.entityType,
      title: node.title,
      ref: node.resourceRef ? `${node.resourceRef.kind}:${node.resourceRef.id}` : null,
      parent: edge ? `${edge.fromNodeId.slice(0, 8)} (${edge.origin})` : null,
      collapsed: node.collapsed,
      summary: node.cachedPresentation?.summary ?? null
    }
  })
}

function refKeys(canvas: Canvas): string[] {
  return canvas.nodes.flatMap((node) => (node.resourceRef ? [`${node.resourceRef.kind}:${node.resourceRef.id}`] : []))
}

async function main(): Promise<void> {
  const projectDirectory = await mkdtemp(join(tmpdir(), 'spade-agents-validate-project-'))
  const dataDirectory = await mkdtemp(join(tmpdir(), 'spade-agents-validate-data-'))
  const created = new Set<string>()
  const failures: unknown[] = []
  let spade: Spade | null = null

  try {
    spade = await openSpade(dataDirectory)
    log('connection', spade.service.connection())
    const { project } = await spade.gateway.createProject(projectDirectory, 'Validation')

    // 1. An agent node that delegates to a provider-native sub-agent.
    const prompt =
      'Use your Agent tool exactly once to launch a sub-agent whose only job is to reply with the single word OK. When it returns, reply with the single word OK.'
    const root = await spade.gateway.execute(
      project.id,
      { type: 'startTree', node: { entityType: 'agent', config: { provider, model, mode, prompt } } },
      user
    )
    const rootNodeId = root.nodeId!
    let canvas = await spade.gateway.getCanvas(project.id)
    const rootNode = canvas.nodes.find((node) => node.id === rootNodeId)!
    const rootAgentId = rootNode.resourceRef!.id
    created.add(rootAgentId)
    log('root.node', { nodeId: rootNodeId, ref: rootNode.resourceRef, config: rootNode.config, workspaces: canvas.workspaces })
    check((rootNode.config as { prompt: string }).prompt === prompt, 'the node stores the caller prompt without SPADE additions')

    const settled = await waitFor('the root turn and its provider sub-agent', () => {
      const runtime = runtimeOf(spade!, project, rootNodeId)
      return runtime && runtime.status === 'idle' && runtime.providerSubagents.length > 0 ? runtime : null
    })
    log('root.runtime', {
      resourceState: settled.resourceState,
      status: settled.status,
      activity: settled.activity,
      cwd: settled.cwd,
      title: settled.title,
      providerSubagents: settled.providerSubagents
    })
    check(settled.cwd === projectDirectory, 'the agent runs in the project root')

    // 2. The provider sub-agent, opened on demand as a delegated child (twice: one node).
    const subagentId = settled.providerSubagents[0].id
    const opened = await spade.service.openProviderSubagent(rootNodeId, subagentId, user)
    const reopened = await spade.service.openProviderSubagent(rootNodeId, subagentId, user)
    check(opened.nodeId === reopened.nodeId, 'opening a provider sub-agent twice yields one node')

    // 3. A child the root agent starts through SPADE: a pass-through to Paseo with the root as parent, no node.
    const spawnedChild = await spade.service.spawnChildAgent(rootAgentId, {
      provider,
      model,
      title: 'Spawned child',
      prompt: 'Reply with the single word CHILD.'
    })
    created.add(spawnedChild.agentId)

    // 4. A child created in Paseo alone (as an agent's own delegation would): listed on the root, no node.
    const managed = await spade.adapter.spawnAgent({
      cwd: projectDirectory,
      provider,
      model,
      mode,
      background: true,
      title: 'Managed child',
      parentAgentId: rootAgentId,
      prompt: 'Reply with the single word MANAGED.'
    })
    created.add(managed.id)
    const listed = await waitFor('both children to settle in the root agent’s list', () => {
      const children = runtimeOf(spade!, project, rootNodeId)?.children ?? []
      const ids = [spawnedChild.agentId, managed.id]
      const settled = children.filter((child) => ids.includes(child.agentId) && child.status === 'idle')
      return settled.length === ids.length ? settled : null
    })
    log('children', listed.map(({ agentId, mode: childMode, status, nodeId }) => ({ agentId, mode: childMode, status, nodeId })))
    check(listed.every((child) => child.nodeId === null), 'children are listed collapsed, without nodes')
    const located = await spade.service.locateAgent(spawnedChild.agentId)
    check(located?.placements[0]?.anchorNodeId === rootNodeId, 'a collapsed child is located on its owner’s node')
    check(located?.parentAgentId === rootAgentId, 'the spawned child has the root as Paseo parent')
    canvas = await spade.gateway.getCanvas(project.id)
    check(!refKeys(canvas).some((key) => key.endsWith(spawnedChild.agentId) || key.endsWith(managed.id)), 'no node was created for either child')

    // The user expands the managed child into a delegated node.
    const expanded = await spade.service.expandChildAgent(rootNodeId, managed.id, user)
    canvas = await spade.gateway.getCanvas(project.id)
    const managedEdge = canvas.edges.find((edge) => edge.toNodeId === expanded.nodeId)
    check(managedEdge?.fromNodeId === rootNodeId && managedEdge.origin === 'delegated', 'an expanded child is a delegated child of its owner')

    // 5. Both timelines.
    const rootTimeline = await spade.service.timeline(rootNodeId)
    const subTimeline = await spade.service.timeline(opened.nodeId)
    const firstUser = rootTimeline.items.find((item) => item.kind === 'user-message')
    log('root.timeline', { kinds: kinds(rootTimeline.items), reply: lastAssistantText(rootTimeline.items) })
    log('subagent.timeline', { kinds: kinds(subTimeline.items), reply: lastAssistantText(subTimeline.items) })
    check(firstUser?.kind === 'user-message' && firstUser.text.endsWith(INSTRUCTIONS), 'Paseo received the prompt with the instructions suffix')
    check(subTimeline.items.length > 0, 'the provider sub-agent timeline is readable')

    // 6. A follow-up prompt with a context reference.
    const note = await spade.gateway.execute(
      project.id,
      { type: 'spawnChild', sourceNodeId: rootNodeId, origin: 'spawned', node: { entityType: 'note', config: { body: 'The secret word is PINEAPPLE.' }, title: 'Secret' } },
      user
    )
    const beforeFollowUp = runtimeOf(spade, project, rootNodeId)!.updatedAt
    await spade.service.prompt(rootNodeId, { text: 'Reply with only the secret word from the canvas context.', contextNodeIds: [note.nodeId!] }, user)
    await waitFor('the follow-up turn', () => {
      const runtime = runtimeOf(spade!, project, rootNodeId)
      return runtime && runtime.status === 'idle' && runtime.updatedAt !== beforeFollowUp ? runtime : null
    })
    const afterFollowUp = await spade.service.timeline(rootNodeId)
    const followUpReply = lastAssistantText(afterFollowUp.items)
    log('root.followUp', { reply: followUpReply })
    check(/pineapple/i.test(followUpReply ?? ''), 'the agent saw the referenced note through the context block')

    // 7. Quit and relaunch SPADE over the same data directory (Paseo keeps running).
    await spade.service.whenIdle()
    const before = await spade.gateway.getCanvas(project.id)
    log('canvas.beforeRestart', describeCanvas(before))
    await closeSpade(spade)
    spade = await openSpade(dataDirectory)
    await waitFor('runtimes to be live again', () =>
      spade!.service.runtimes(project.id).every((runtime) => runtime.resourceState === 'live') ? true : null, 30_000)
    await spade.service.whenIdle()
    const after = await spade.gateway.getCanvas(project.id)
    log('canvas.afterRestart', describeCanvas(after))
    check(JSON.stringify(after.nodes.map((node) => node.id)) === JSON.stringify(before.nodes.map((node) => node.id)), 'the same nodes after a restart')
    check(new Set(refKeys(after)).size === refKeys(after).length, 'no resource appears twice')
    check(after.edges.length === before.edges.length, 'the same edges after a restart')
    log('runtimes.afterRestart', spade.service.runtimes(project.id).map(({ nodeId, resourceState, status, activity }) =>
      ({ nodeId: nodeId.slice(0, 8), resourceState, status, activity })))
    check((await readdir(projectDirectory)).length === 0, 'nothing was written into the project directory by SPADE')
  } catch (error) {
    failures.push(error)
  } finally {
    if (spade) {
      for (const agentId of created) {
        try {
          log('archived', { agentId, archivedAt: await spade.adapter.archiveAgent(agentId) })
        } catch (error) {
          failures.push(error)
        }
      }
      await closeSpade(spade).catch((error: unknown) => failures.push(error))
    }
    await rm(projectDirectory, { recursive: true, force: true })
    await rm(dataDirectory, { recursive: true, force: true })
  }
  if (failures.length > 0) throw new AggregateError(failures, failures.map(String).join('; '))
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
