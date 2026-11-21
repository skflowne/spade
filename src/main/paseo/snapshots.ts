import type { PaseoAgent } from '@getpaseo/client'
import {
  AGENT_PERMISSION_DETAIL_LIMIT,
  type AgentActivity,
  type AgentPermissionRequest,
  type AgentProviderInfo,
  type AgentProviderStatus,
  type ProviderSubagentInfo
} from '../../shared/agents'
import { boundText } from './normalizeTimeline'

// Paseo labels an agent created with a caller agent; the label survives restarts and archival.
export const PARENT_AGENT_ID_LABEL = 'paseo.parent-agent-id'

// An archived agent keeps its last lifecycle status in Paseo; archival is the fact SPADE shows.
export const ARCHIVED_AGENT_STATUS = 'archived'

export type PaseoAgentSnapshot = {
  id: string
  // Durable Paseo parent identity (the `paseo.parent-agent-id` label), never inferred.
  parentAgentId: string | null
  workspaceId: string | null
  title: string | null
  provider: string
  model: string | null
  mode: string | null
  // Paseo lifecycle status, or `archived`.
  status: string
  archivedAt: string | null
  cwd: string
  createdAt: string
  updatedAt: string
  pendingPermissions: AgentPermissionRequest[]
  lastError: string | null
}

export function toAgentSnapshot(agent: PaseoAgent): PaseoAgentSnapshot {
  return {
    id: agent.id,
    parentAgentId: agent.labels?.[PARENT_AGENT_ID_LABEL]?.trim() || null,
    workspaceId: agent.workspaceId ?? null,
    title: agent.title ?? null,
    provider: agent.provider,
    model: agent.model ?? null,
    mode: agent.currentModeId ?? null,
    status: agent.archivedAt ? ARCHIVED_AGENT_STATUS : agent.status,
    archivedAt: agent.archivedAt ?? null,
    cwd: agent.cwd,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
    pendingPermissions: (agent.pendingPermissions ?? []).map(toPermissionRequest),
    lastError: agent.lastError ?? null
  }
}

type PaseoPermissionRequest = PaseoAgent['pendingPermissions'][number]

export function toPermissionRequest(request: PaseoPermissionRequest): AgentPermissionRequest {
  return {
    id: request.id,
    kind: request.kind,
    name: request.name,
    title: request.title ?? null,
    description: request.description ?? null,
    detail: permissionDetail(request)
  }
}

// What is being approved: the tool's own detail when Paseo normalized it, else the raw input.
function permissionDetail(request: PaseoPermissionRequest): string | null {
  const detail = request.detail
  let text: string | null = null
  if (detail?.type === 'shell') text = detail.command
  else if (detail?.type === 'edit') text = [detail.filePath, detail.unifiedDiff ?? detail.newString].filter(Boolean).join('\n')
  else if (detail?.type === 'write' || detail?.type === 'read') text = detail.filePath
  else if (detail?.type === 'fetch') text = detail.url
  else if (detail?.type === 'search') text = detail.query
  else if (detail?.type === 'plan') text = detail.text
  else if (request.input !== undefined) text = JSON.stringify(request.input)
  return text ? boundText(text, AGENT_PERMISSION_DETAIL_LIMIT) : null
}

export function agentActivity(status: string, pendingPermissionCount: number): AgentActivity {
  if (status === ARCHIVED_AGENT_STATUS || status === 'closed') return 'closed'
  if (pendingPermissionCount > 0) return 'attention'
  switch (status) {
    case 'initializing':
      return 'starting'
    case 'running':
      return 'running'
    case 'idle':
      return 'idle'
    case 'error':
      return 'error'
    default:
      return 'unknown'
  }
}

type ProviderSnapshotEntry = {
  provider: string
  status: string
  enabled: boolean
  label?: string
  error?: string
  defaultModeId?: string | null
  models?: Array<{ id: string; label: string; isDefault?: boolean; isSelectable?: boolean }>
  modes?: Array<{ id: string; label: string; description?: string }>
}

export function toProviderInfo(entry: ProviderSnapshotEntry): AgentProviderInfo {
  const status: AgentProviderStatus =
    entry.status === 'ready' || entry.status === 'loading' || entry.status === 'error' ? entry.status : 'unavailable'
  return {
    id: entry.provider,
    label: entry.label ?? entry.provider,
    available: entry.enabled && status === 'ready',
    status,
    error: entry.error ?? null,
    models: (entry.models ?? [])
      .filter((model) => model.isSelectable !== false)
      .map((model) => ({ id: model.id, label: model.label, ...(model.isDefault ? { isDefault: true } : {}) })),
    modes: (entry.modes ?? []).map((mode) => ({
      id: mode.id,
      label: mode.label,
      ...(mode.description ? { description: mode.description } : {})
    })),
    defaultModeId: entry.defaultModeId ?? null
  }
}

type PaseoProviderSubagent = {
  id: string
  parentSubagentId?: string | null
  title: string | null
  description: string | null
  status: string
  updatedAt: string
}

export function toSubagentInfo(subagent: PaseoProviderSubagent): ProviderSubagentInfo {
  return {
    id: subagent.id,
    parentSubagentId: subagent.parentSubagentId ?? null,
    title: subagent.title,
    description: subagent.description,
    status: subagent.status,
    updatedAt: subagent.updatedAt
  }
}
