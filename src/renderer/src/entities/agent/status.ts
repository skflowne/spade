import type { AgentActivity, AgentRuntime, ConversationItem } from '../../../../shared/agents'
import { PASEO_PROVIDER_SUBAGENT_KIND } from '../../../../shared/builtinEntities'
import type { CanvasNode } from '../../../../shared/domain'

// Structurally a NodeStatus (entities/types.ts), kept free of renderer imports so it is testable alone.
export type AgentStatusView = {
  label: string
  tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger'
  description?: string
}

const ACTIVITY: Record<AgentActivity, Omit<AgentStatusView, 'description'>> = {
  starting: { label: 'starting', tone: 'info' },
  running: { label: 'running', tone: 'info' },
  idle: { label: 'idle', tone: 'success' },
  attention: { label: 'needs attention', tone: 'warning' },
  error: { label: 'error', tone: 'danger' },
  closed: { label: 'closed', tone: 'neutral' },
  unknown: { label: 'unknown', tone: 'neutral' }
}

// "claude · opus · plan": what the agent runs as.
export function runtimeIdentity(runtime: Pick<AgentRuntime, 'provider' | 'model' | 'mode'>): string {
  return [runtime.provider, runtime.model, runtime.mode].filter(Boolean).join(' · ')
}

// What the status reads: an agent node's runtime, or a Paseo child as its owner lists it.
export type AgentStatusSource = Pick<
  AgentRuntime,
  'resourceState' | 'pendingPermissions' | 'activity' | 'lastError' | 'status' | 'provider' | 'model' | 'mode'
>

// The header badge. Reachability and pending permissions outrank Paseo's own activity.
export function agentStatusOf(runtime: AgentStatusSource): AgentStatusView {
  const base =
    runtime.resourceState === 'missing'
      ? { label: 'missing', tone: 'danger' as const }
      : runtime.resourceState === 'stale'
        ? { label: 'stale', tone: 'neutral' as const }
        : runtime.pendingPermissions.length > 0
          ? ACTIVITY.attention
          : ACTIVITY[runtime.activity]
  const error = runtime.lastError ? ` — ${runtime.lastError}` : ''
  return { ...base, description: `${runtimeIdentity(runtime)} · ${runtime.status}${error}` }
}

export function lastAssistantExcerpt(items: readonly ConversationItem[], limit: number): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item.kind !== 'assistant-message') continue
    const text = item.text.replace(/\s+/g, ' ').trim()
    if (!text) continue
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
  }
  return null
}

export function subagentTone(status: string): AgentStatusView['tone'] {
  switch (status) {
    case 'running':
      return 'info'
    case 'completed':
      return 'success'
    case 'failed':
      return 'danger'
    default:
      return 'neutral'
  }
}

// Why this node cannot be prompted (nor answer permissions or HTML answer submissions); null when it can.
export function promptBlockReason(node: Pick<CanvasNode, 'resourceRef'>, runtime: AgentRuntime | null): string | null {
  if (node.resourceRef === null) return 'This node has no Paseo agent.'
  if (node.resourceRef.kind === PASEO_PROVIDER_SUBAGENT_KIND) {
    return 'This is a provider sub-agent: its conversation is read-only.'
  }
  if (runtime === null) return 'Waiting for the agent’s state from Paseo.'
  if (runtime.resourceState === 'missing') return 'Paseo no longer has this agent.'
  if (runtime.resourceState === 'stale') return 'Paseo is unreachable.'
  return null
}
