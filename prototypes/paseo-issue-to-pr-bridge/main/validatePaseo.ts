import { writeFile } from 'node:fs/promises'
import { SpadePaseoAdapter } from './SpadePaseoAdapter'
import { PASEO_TIMELINE_LIMIT } from '../shared/model'
import type { PaseoAuthoritativeSnapshot } from '../shared/paseoReconciliation'

const POLL_INTERVAL_MS = 500

async function run(): Promise<void> {
  const url = requiredEnvironment('SPADE_P3_PASEO_URL')
  const cwd = requiredEnvironment('SPADE_P3_VALIDATION_CWD')
  const provider = requiredEnvironment('SPADE_P3_VALIDATION_PROVIDER')
  const model = requiredEnvironment('SPADE_P3_VALIDATION_MODEL')
  const timeoutMs = Number(process.env.SPADE_P3_VALIDATION_TIMEOUT_MS ?? 180_000)
  const outputPath = process.env.SPADE_P3_VALIDATION_OUTPUT
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('SPADE_P3_VALIDATION_TIMEOUT_MS must be a positive number.')
  }

  const adapter = new SpadePaseoAdapter({ url, pollIntervalMs: 0 })
  const createdAgentIds: string[] = []
  const archivedAgents: Array<{ id: string; archivedAt: string }> = []
  let evidence: Record<string, unknown> | null = null
  let failure: unknown = null

  try {
    await adapter.connect()
    const workspace = await adapter.openProjectCheckout(cwd)
    const root = await adapter.spawnAgent({
      workspaceId: workspace.id,
      cwd,
      provider,
      model,
      prompt: 'Reply exactly SPADE_ROOT_OK. Do not use tools or modify files.',
      title: 'SPADE 0.4 validation root'
    })
    createdAgentIds.push(root.id)
    const child = await adapter.spawnAgent({
      workspaceId: workspace.id,
      cwd,
      provider,
      model,
      parentAgentId: root.id,
      prompt: 'Reply exactly SPADE_CHILD_OK. Do not use tools or modify files.',
      title: 'SPADE 0.4 validation child'
    })
    createdAgentIds.push(child.id)

    const completedRoot = await waitForTerminalAgent(adapter, root.id, timeoutMs)
    const completedChild = await waitForTerminalAgent(adapter, child.id, timeoutMs)
    const references = {
      agentIds: [root.id, child.id],
      workspaceIds: [workspace.id]
    }
    const first = await adapter.fetchAuthoritative(root.id, references)
    const second = await adapter.fetchAuthoritative(root.id, references)
    verifySnapshots(first, second, root.id, child.id, workspace.id)

    evidence = {
      clientVersion: '0.4.0',
      daemonUrl: url,
      provider,
      model,
      workspaceId: workspace.id,
      rootAgentId: root.id,
      childAgentId: child.id,
      childParentAgentId: completedChild.parentAgentId,
      rootStatus: completedRoot.status,
      childStatus: completedChild.status,
      agentIds: sortedAgentIds(first),
      workspaceIds: sortedWorkspaceIds(first),
      timelineEntryCounts: Object.fromEntries(
        first.timelines.map(({ agentId, entries }) => [agentId, entries.length])
      ),
      repeatedRefetchStable: snapshotIdentity(first) === snapshotIdentity(second),
      authoritativeRefreshAt: first.refreshedAt
    }
  } catch (error) {
    failure = error
  } finally {
    for (const id of [...createdAgentIds].reverse()) {
      try {
        archivedAgents.push({ id, archivedAt: await adapter.archiveAgent(id) })
      } catch (error) {
        archivedAgents.push({ id, archivedAt: `archive failed: ${errorMessage(error)}` })
      }
    }
    await adapter.close().catch(() => undefined)
  }

  if (failure) throw failure
  const result = { ...evidence, archivedAgents }
  const serialized = `${JSON.stringify(result, null, 2)}\n`
  if (outputPath) await writeFile(outputPath, serialized, 'utf8')
  process.stdout.write(serialized)
}

async function waitForTerminalAgent(
  adapter: SpadePaseoAdapter,
  agentId: string,
  timeoutMs: number
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const agent = await adapter.attachAgent(agentId)
    if (!agent) throw new Error(`Paseo validation agent ${agentId} disappeared.`)
    if (agent.status !== 'running') return agent
    await delay(POLL_INTERVAL_MS)
  }
  throw new Error(`Timed out waiting for Paseo validation agent ${agentId}.`)
}

function verifySnapshots(
  first: PaseoAuthoritativeSnapshot,
  second: PaseoAuthoritativeSnapshot,
  rootAgentId: string,
  childAgentId: string,
  workspaceId: string
): void {
  const agents = first.agentPages.flat()
  const root = agents.find(({ id }) => id === rootAgentId)
  const child = agents.find(({ id }) => id === childAgentId)
  if (!root) throw new Error('Authoritative validation snapshot omitted the root agent.')
  if (!child) throw new Error('Authoritative validation snapshot omitted the child agent.')
  if (child.parentAgentId !== rootAgentId) {
    throw new Error(`Expected child parent ${rootAgentId}, received ${child.parentAgentId ?? 'null'}.`)
  }
  if (root.workspaceId !== workspaceId || child.workspaceId !== workspaceId) {
    throw new Error('Authoritative validation snapshot changed an opaque workspace identity.')
  }
  if (!first.workspacePages.flat().some(({ id }) => id === workspaceId)) {
    throw new Error('Authoritative validation snapshot omitted the exact workspace.')
  }
  if (first.timelines.some(({ entries }) => entries.length > PASEO_TIMELINE_LIMIT)) {
    throw new Error(`Authoritative validation timeline exceeded ${PASEO_TIMELINE_LIMIT} events.`)
  }
  if (snapshotIdentity(first) !== snapshotIdentity(second)) {
    throw new Error('Repeated authoritative refetch changed stable resource identity.')
  }
}

function snapshotIdentity(snapshot: PaseoAuthoritativeSnapshot): string {
  return JSON.stringify({
    rootAgentId: snapshot.rootAgentId,
    agentIds: sortedAgentIds(snapshot),
    workspaceIds: sortedWorkspaceIds(snapshot),
    timelineIds: snapshot.timelines.map(({ agentId }) => agentId).sort()
  })
}

function sortedAgentIds(snapshot: PaseoAuthoritativeSnapshot): string[] {
  return snapshot.agentPages.flat().map(({ id }) => id).sort()
}

function sortedWorkspaceIds(snapshot: PaseoAuthoritativeSnapshot): string[] {
  return snapshot.workspacePages.flat().map(({ id }) => id).sort()
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

void run().catch((error: unknown) => {
  process.stderr.write(`${errorMessage(error)}\n`)
  process.exitCode = 1
})
