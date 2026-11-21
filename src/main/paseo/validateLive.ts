// Live check of the Paseo adapter against a running daemon; not part of `npm test`. It spawns two
// throwaway agents in a scratch directory, exercises every adapter operation, and archives them.
//
//   npx esbuild src/main/paseo/validateLive.ts --bundle --platform=node --format=esm \
//     --packages=external --outfile=out/paseo/validateLive.mjs && node out/paseo/validateLive.mjs
//
// Environment: SPADE_PASEO_URL (else discovered), SPADE_PASEO_VALIDATE_PROVIDER (claude),
// SPADE_PASEO_VALIDATE_MODEL (claude-haiku-4-5), SPADE_PASEO_VALIDATE_TIMEOUT_MS (240000).
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConversationItem } from '../../shared/agents'
import { PaseoAdapter, type PaseoAdapterEvent } from './PaseoAdapter'
import type { PaseoAgentSnapshot } from './snapshots'
import { resolvePaseoUrl } from './url'

const provider = process.env.SPADE_PASEO_VALIDATE_PROVIDER ?? 'claude'
const model = process.env.SPADE_PASEO_VALIDATE_MODEL ?? 'claude-haiku-4-5'
const timeoutMs = Number(process.env.SPADE_PASEO_VALIDATE_TIMEOUT_MS ?? 240_000)
const SETTLED = new Set(['idle', 'error', 'closed', 'archived'])

function log(step: string, data: unknown): void {
  process.stdout.write(`${step}: ${JSON.stringify(data)}\n`)
}

async function waitFor<T>(label: string, read: () => Promise<T | null>, limitMs = timeoutMs): Promise<{ value: T; ms: number }> {
  const started = Date.now()
  for (;;) {
    const value = await read()
    if (value !== null) return { value, ms: Date.now() - started }
    if (Date.now() - started > limitMs) throw new Error(`Timed out after ${limitMs} ms waiting for ${label}.`)
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
}

function kinds(items: ConversationItem[]): string[] {
  return items.map((item) => (item.kind === 'tool-call' ? `tool:${item.toolKind}:${item.name}:${item.status}` : item.kind))
}

function lastAssistantText(items: ConversationItem[]): string | null {
  const last = [...items].reverse().find((item) => item.kind === 'assistant-message')
  return last?.kind === 'assistant-message' ? last.text : null
}

async function main(): Promise<void> {
  const resolved = resolvePaseoUrl()
  log('url', resolved)
  const adapter = new PaseoAdapter({ url: resolved.url })
  const events: PaseoAdapterEvent[] = []
  adapter.subscribe((event) => events.push(event))
  const scratch = await mkdtemp(join(tmpdir(), 'spade-paseo-validate-'))
  const created: PaseoAgentSnapshot[] = []
  const failures: unknown[] = []

  try {
    await adapter.start()
    await adapter.ready()
    log('connection', adapter.connection())

    const providers = await adapter.listProviders(scratch)
    log('providers', providers.map(({ id, status, available, models, modes, defaultModeId }) =>
      ({ id, status, available, models: models.length, modes: modes.map((mode) => mode.id), defaultModeId })))

    // A root that delegates to a provider-native sub-agent.
    const spawnedAt = Date.now()
    const root = await adapter.spawnAgent({
      cwd: scratch,
      provider,
      model,
      mode: 'bypassPermissions',
      background: true,
      title: 'SPADE adapter validation root',
      prompt: 'Use your Agent tool exactly once to launch a sub-agent whose only job is to reply with the single word OK. When it returns, reply with the single word OK.'
    })
    created.push(root)
    await adapter.watchTimelines([root.id])
    log('root.spawned', { id: root.id, status: root.status, mode: root.mode, workspaceId: root.workspaceId, spawnMs: Date.now() - spawnedAt })
    const rootDone = await waitFor('the root turn', async () => {
      const agent = await adapter.getAgent(root.id)
      return agent && SETTLED.has(agent.status) && agent.updatedAt !== root.updatedAt ? agent : null
    })
    log('root.settled', { status: rootDone.value.status, lastError: rootDone.value.lastError, turnMs: rootDone.ms })

    const rootTimeline = await adapter.agentTimeline(root.id)
    log('root.timeline', { epoch: rootTimeline.epoch, olderCursor: rootTimeline.olderCursor, kinds: kinds(rootTimeline.items) })
    const delegation = rootTimeline.items.find((item) => item.kind === 'tool-call' && item.toolKind === 'subagent')
    log('root.delegation', delegation ?? null)

    const subagents = await adapter.listProviderSubagents(root.id)
    log('root.providerSubagents', subagents)
    if (subagents.observable && subagents.subagents[0]) {
      const subTimeline = await adapter.providerSubagentTimeline(root.id, subagents.subagents[0].id)
      log('subagent.timeline', { epoch: subTimeline.epoch, kinds: kinds(subTimeline.items), reply: lastAssistantText(subTimeline.items) })
      log('subagent.matchesToolCall', delegation?.kind === 'tool-call' && delegation.callId === subagents.subagents[0].id)
    }

    // A managed child that needs a permission, created with the root as its durable parent.
    const child = await adapter.spawnAgent({
      cwd: scratch,
      provider,
      model,
      mode: 'default',
      background: true,
      title: 'SPADE adapter validation child',
      parentAgentId: root.id,
      prompt: 'Use the Write tool to create a file named ok.txt containing the single word OK in your current working directory. Then reply with the single word OK.'
    })
    created.push(child)
    await adapter.watchTimelines([root.id, child.id])
    log('child.spawned', { id: child.id, parentAgentId: child.parentAgentId, cwd: child.cwd, mode: child.mode })
    const pending = await waitFor('a pending permission', async () => {
      const agent = await adapter.getAgent(child.id)
      if (agent && agent.pendingPermissions.length > 0) return agent
      if (agent && SETTLED.has(agent.status) && agent.updatedAt !== child.updatedAt) return agent
      return null
    })
    log('child.permission', { waitedMs: pending.ms, status: pending.value.status, pendingPermissions: pending.value.pendingPermissions })
    const request = pending.value.pendingPermissions[0]
    if (request) {
      await adapter.respondToPermission(child.id, request.id, 'allow')
      const answered = await waitFor('the child turn', async () => {
        const agent = await adapter.getAgent(child.id)
        return agent && agent.pendingPermissions.length === 0 && SETTLED.has(agent.status) ? agent : null
      })
      const file = join(scratch, 'ok.txt')
      log('child.afterAllow', {
        status: answered.value.status,
        turnMs: answered.ms,
        fileWritten: existsSync(file) ? (await readFile(file, 'utf8')).trim() : null
      })
    }

    const children = await adapter.listChildAgents([root.id])
    log('root.children', children.map(({ id, parentAgentId, status }) => ({ id, parentAgentId, status })))

    // Interrupt a running turn.
    await adapter.sendPrompt(child.id, 'Write the numbers from 1 to 400, one per line, with no other text.')
    await waitFor('the child to run', async () => ((await adapter.getAgent(child.id))?.status === 'running' ? true : null), 60_000)
    await adapter.interrupt(child.id)
    const interrupted = await waitFor('the interrupted child', async () => {
      const agent = await adapter.getAgent(child.id)
      return agent && SETTLED.has(agent.status) ? agent : null
    }, 60_000)
    log('child.interrupted', { status: interrupted.value.status, settleMs: interrupted.ms })

    // Follow-up prompt to an idle agent.
    const beforeFollowUp = await adapter.getAgent(root.id)
    await adapter.sendPrompt(root.id, 'Reply with the single word DONE.')
    const followUp = await waitFor('the follow-up turn', async () => {
      const agent = await adapter.getAgent(root.id)
      return agent && SETTLED.has(agent.status) && agent.updatedAt !== beforeFollowUp?.updatedAt ? agent : null
    })
    const afterFollowUp = await adapter.agentTimeline(root.id)
    log('root.followUp', { status: followUp.value.status, turnMs: followUp.ms, reply: lastAssistantText(afterFollowUp.items) })

    // Paging and a cursor from another epoch.
    const small = await adapter.agentTimeline(root.id, { limit: 3 })
    const older = small.olderCursor ? await adapter.agentTimeline(root.id, { before: small.olderCursor, limit: 3 }) : null
    const foreign = await adapter.agentTimeline(root.id, { before: '5@not-this-epoch', limit: 3 })
    log('root.paging', {
      newest: small.items.map(({ id }) => id),
      older: older?.items.map(({ id }) => id) ?? null,
      foreignCursorGaveNewest: JSON.stringify(foreign.items.map(({ id }) => id)) === JSON.stringify(small.items.map(({ id }) => id))
    })
  } catch (error) {
    failures.push(error)
  } finally {
    for (const agent of [...created].reverse()) {
      try {
        log('archived', { id: agent.id, archivedAt: await adapter.archiveAgent(agent.id) })
      } catch (error) {
        failures.push(error)
      }
    }
    const root = created[0]
    if (root && adapter.connection().state === 'connected') {
      log('archivedRoot.agent', (await adapter.getAgent(root.id))?.status ?? null)
      log('archivedRoot.providerSubagents', await adapter.listProviderSubagents(root.id))
      log('archivedRoot.children', (await adapter.listChildAgents([root.id])).map(({ id, status }) => ({ id, status })))
    }
    const ours = new Set(created.map(({ id }) => id))
    const counts: Record<string, number> = {}
    for (const event of events) {
      const agentId = 'agentId' in event ? event.agentId : 'parentAgentId' in event ? event.parentAgentId : null
      if (event.type !== 'connection' && (!agentId || !ours.has(agentId))) continue
      const key = event.type === 'agent-updated' && event.created ? 'agent-updated(created)' : event.type
      counts[key] = (counts[key] ?? 0) + 1
    }
    log('events', counts)
    log('workspaces', [...new Set(created.map(({ workspaceId }) => workspaceId))])
    await adapter.stop()
    await rm(scratch, { recursive: true, force: true })
  }
  if (failures.length > 0) throw new AggregateError(failures, failures.map(String).join('; '))
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
