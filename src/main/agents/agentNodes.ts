import type { PaseoAgentSnapshot } from '../paseo'
import { agentActivity } from '../paseo'
import type {
  AgentActivity,
  AgentResourceState,
  AgentRuntime,
  ChildAgentInfo,
  ProviderSubagentInfo
} from '../../shared/agents'
import {
  AGENT_ENTITY,
  PASEO_AGENT_KIND,
  PASEO_PROVIDER_SUBAGENT_KIND,
  agentEntity,
  type AgentConfig
} from '../../shared/builtinEntities'
import type { CanvasNode, ResourceRef } from '../../shared/domain'

// What an agent node points at in Paseo.
export type AgentNodeTarget =
  | { kind: 'agent'; agentId: string }
  | { kind: 'provider-subagent'; parentAgentId: string; subagentId: string }

export function agentResourceRef(agentId: string): ResourceRef {
  return { provider: 'paseo', kind: PASEO_AGENT_KIND, id: agentId }
}

export function providerSubagentResourceRef(parentAgentId: string, subagentId: string): ResourceRef {
  return { provider: 'paseo', kind: PASEO_PROVIDER_SUBAGENT_KIND, id: `${parentAgentId}/${subagentId}` }
}

export function agentTargetOf(node: CanvasNode): AgentNodeTarget | null {
  const ref = node.resourceRef
  if (node.entityType !== AGENT_ENTITY || !ref || ref.provider !== 'paseo') return null
  if (ref.kind === PASEO_AGENT_KIND) return { kind: 'agent', agentId: ref.id }
  if (ref.kind !== PASEO_PROVIDER_SUBAGENT_KIND) return null
  // Paseo agent ids never contain a slash; the provider's sub-agent id may.
  const slash = ref.id.indexOf('/')
  if (slash <= 0 || slash === ref.id.length - 1) return null
  return { kind: 'provider-subagent', parentAgentId: ref.id.slice(0, slash), subagentId: ref.id.slice(slash + 1) }
}

export function agentConfigOf(node: CanvasNode): AgentConfig | null {
  try {
    return agentEntity.parseConfig(node.config)
  } catch {
    return null
  }
}

const TITLE_LIMIT = 200
const PROMPT_TITLE_LIMIT = 60

export function clipText(text: string, limit: number): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > limit ? `${single.slice(0, limit - 1)}…` : single
}

export function paseoTitle(title: string | null | undefined): string | null {
  const clipped = title ? clipText(title, TITLE_LIMIT) : ''
  return clipped.length > 0 ? clipped : null
}

// The title a spawned agent gets when neither the caller nor Paseo named it.
export function promptTitle(prompt: string | null): string | null {
  const firstLine = prompt?.split(/\r?\n/).find((line) => line.trim().length > 0)
  return firstLine ? clipText(firstLine, PROMPT_TITLE_LIMIT) : null
}

// True when the node's title is one SPADE or Paseo chose, so a newer Paseo title may replace it.
export function hasAutomaticTitle(node: CanvasNode, knownPaseoTitles: ReadonlySet<string> | undefined): boolean {
  if (node.title === agentEntity.displayName) return true
  if (knownPaseoTitles?.has(node.title)) return true
  const config = agentConfigOf(node)
  return config !== null && node.title === promptTitle(config.prompt)
}

export function subagentActivity(status: string): AgentActivity {
  switch (status) {
    case 'running':
      return 'running'
    case 'completed':
      return 'idle'
    case 'failed':
      return 'error'
    case 'canceled':
      return 'closed'
    default:
      return 'unknown'
  }
}

export function agentRuntimeOf(input: {
  projectId: string
  node: CanvasNode
  agentId: string
  snapshot: PaseoAgentSnapshot | undefined
  state: AgentResourceState
  providerSubagents: ProviderSubagentInfo[]
  children: ChildAgentInfo[]
  fallbackCwd: string | null
}): AgentRuntime {
  const { projectId, node, agentId, snapshot, state, providerSubagents, children } = input
  const base = { projectId, nodeId: node.id, agentId, resourceState: state, providerSubagents, children }
  if (!snapshot) {
    const config = agentConfigOf(node)
    return {
      ...base,
      parentAgentId: null,
      provider: config?.provider ?? 'unknown',
      model: config?.model ?? null,
      mode: config?.mode ?? null,
      title: null,
      status: 'unknown',
      activity: 'unknown',
      cwd: input.fallbackCwd,
      pendingPermissions: [],
      lastError: null,
      updatedAt: node.cachedPresentation?.updatedAt ?? node.updatedAt
    }
  }
  const missing = state === 'missing'
  return {
    ...base,
    parentAgentId: snapshot.parentAgentId,
    provider: snapshot.provider,
    model: snapshot.model,
    mode: snapshot.mode,
    title: snapshot.title,
    status: snapshot.status,
    // A missing agent runs nothing and can answer nothing.
    activity: missing ? 'closed' : agentActivity(snapshot.status, snapshot.pendingPermissions.length),
    cwd: snapshot.cwd,
    pendingPermissions: missing ? [] : snapshot.pendingPermissions,
    lastError: snapshot.lastError,
    updatedAt: snapshot.updatedAt
  }
}

export function providerSubagentRuntimeOf(input: {
  projectId: string
  node: CanvasNode
  parentAgentId: string
  subagentId: string
  parent: PaseoAgentSnapshot | undefined
  // Null when the parent's list was never read.
  listed: ProviderSubagentInfo[] | null
  state: AgentResourceState
}): AgentRuntime {
  const { node, parent, listed, subagentId } = input
  const row = listed?.find((candidate) => candidate.id === subagentId)
  const status = row?.status ?? 'unknown'
  return {
    projectId: input.projectId,
    nodeId: node.id,
    agentId: subagentId,
    resourceState: input.state,
    parentAgentId: input.parentAgentId,
    provider: parent?.provider ?? agentConfigOf(node)?.provider ?? 'unknown',
    model: null,
    mode: null,
    title: row ? (row.description ?? row.title) : null,
    status,
    activity: input.state === 'missing' ? 'closed' : subagentActivity(status),
    cwd: parent?.cwd ?? null,
    pendingPermissions: [],
    providerSubagents: (listed ?? []).filter((candidate) => candidate.parentSubagentId === subagentId),
    children: [],
    lastError: null,
    updatedAt: row?.updatedAt ?? node.updatedAt
  }
}

// A Paseo child as its owner's node lists it. `children` is filled only while the child is collapsed.
export function childAgentInfoOf(input: {
  snapshot: PaseoAgentSnapshot
  state: AgentResourceState
  nodeId: string | null
  children: ChildAgentInfo[]
}): ChildAgentInfo {
  const { snapshot, state } = input
  const missing = state === 'missing'
  return {
    agentId: snapshot.id,
    title: paseoTitle(snapshot.title),
    provider: snapshot.provider,
    model: snapshot.model,
    mode: snapshot.mode,
    status: snapshot.status,
    activity: missing ? 'closed' : agentActivity(snapshot.status, snapshot.pendingPermissions.length),
    resourceState: state,
    pendingPermissions: missing ? [] : snapshot.pendingPermissions,
    lastError: snapshot.lastError,
    updatedAt: snapshot.updatedAt,
    nodeId: input.nodeId,
    children: input.nodeId === null ? input.children : []
  }
}

const ACTIVITY_LABELS: Record<AgentActivity, string> = {
  starting: 'Starting',
  running: 'Running',
  idle: 'Idle',
  attention: 'Needs attention',
  error: 'Error',
  closed: 'Closed',
  unknown: 'Unknown'
}

// The durable one-line summary mirrored onto the node, shown while Paseo is unreachable.
// Only fields that change on meaningful transitions belong here, never timestamps.
export function runtimeSummary(runtime: AgentRuntime): string {
  const parts = [runtime.model ? `${runtime.provider} · ${runtime.model}` : runtime.provider, ACTIVITY_LABELS[runtime.activity]]
  const permissions = runtime.pendingPermissions.length
  if (permissions > 0) parts.push(`${permissions} permission ${permissions === 1 ? 'request' : 'requests'}`)
  if (runtime.activity === 'error' && runtime.lastError) parts.push(clipText(runtime.lastError, 160))
  return parts.join(' · ')
}

export function sameRuntime(left: AgentRuntime | undefined, right: AgentRuntime): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right)
}
