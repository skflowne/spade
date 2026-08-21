import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SpadePaseoAdapter } from './SpadePaseoAdapter'
import { PASEO_TIMELINE_LIMIT } from '../shared/model'
import type { PaseoAuthoritativeSnapshot } from '../shared/paseoReconciliation'

const POLL_INTERVAL_MS = 500

type ValidationAdapter = Pick<
  SpadePaseoAdapter,
  | 'connect'
  | 'openProjectCheckout'
  | 'spawnAgent'
  | 'attachAgent'
  | 'fetchAuthoritative'
  | 'archiveAgent'
  | 'close'
>

type ValidationAdapterFactory = (url: string) => ValidationAdapter

export async function runPaseoValidation(
  environment: NodeJS.ProcessEnv = process.env,
  createAdapter: ValidationAdapterFactory = (url) => new SpadePaseoAdapter({ url, pollIntervalMs: 0 })
): Promise<Record<string, unknown>> {
  const url = requiredEnvironment(environment, 'SPADE_P3_PASEO_URL')
  const cwd = requiredEnvironment(environment, 'SPADE_P3_VALIDATION_CWD')
  const provider = requiredEnvironment(environment, 'SPADE_P3_VALIDATION_PROVIDER')
  const model = requiredEnvironment(environment, 'SPADE_P3_VALIDATION_MODEL')
  const rootPrompt = requiredEnvironment(environment, 'SPADE_P3_VALIDATION_ROOT_PROMPT')
  const childPrompt = requiredEnvironment(environment, 'SPADE_P3_VALIDATION_CHILD_PROMPT')
  const timeoutMs = Number(environment.SPADE_P3_VALIDATION_TIMEOUT_MS ?? 180_000)
  const outputPath = environment.SPADE_P3_VALIDATION_OUTPUT
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('SPADE_P3_VALIDATION_TIMEOUT_MS must be a positive number.')
  }

  const adapter = createAdapter(url)
  const createdAgentIds: string[] = []
  const archivedAgents: Array<{ id: string; archivedAt: string }> = []
  const failures: unknown[] = []
  let evidence: Record<string, unknown> | null = null

  try {
    await adapter.connect()
    const workspace = await adapter.openProjectCheckout(cwd)
    const root = await adapter.spawnAgent({
      workspaceId: workspace.id,
      cwd,
      provider,
      model,
      prompt: rootPrompt,
      title: 'SPADE 0.4 validation root'
    })
    createdAgentIds.push(root.id)
    const child = await adapter.spawnAgent({
      workspaceId: workspace.id,
      cwd,
      provider,
      model,
      parentAgentId: root.id,
      prompt: childPrompt,
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
    failures.push(error)
  } finally {
    for (const id of [...createdAgentIds].reverse()) {
      try {
        archivedAgents.push({ id, archivedAt: await adapter.archiveAgent(id) })
      } catch (error) {
        failures.push(new Error(`Failed to archive validation agent ${id}: ${errorMessage(error)}`, {
          cause: error
        }))
      }
    }
    try {
      await adapter.close()
    } catch (error) {
      failures.push(new Error(`Failed to close the Paseo validation client: ${errorMessage(error)}`, {
        cause: error
      }))
    }
  }

  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Paseo validation failed with multiple errors.')
  }
  if (!evidence) throw new Error('Paseo validation completed without evidence.')

  const result = { ...evidence, archivedAgents }
  const serialized = `${JSON.stringify(result, null, 2)}\n`
  if (outputPath) await writeFile(outputPath, serialized, 'utf8')
  process.stdout.write(serialized)
  return result
}

async function waitForTerminalAgent(
  adapter: ValidationAdapter,
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

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const entryPath = process.argv[1]
if (entryPath && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  void runPaseoValidation().catch((error: unknown) => {
    process.stderr.write(`${errorMessage(error)}\n`)
    process.exitCode = 1
  })
}
