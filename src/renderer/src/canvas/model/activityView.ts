import type { Actor, Canvas, CanvasActivity, CanvasNode } from '../../../../shared/domain'
import { canvasIndex } from './canvasIndex'

// Who changed what (plan §4.6, attribution), derived from the canvas's activity log.

export type ActivityActorView =
  | { kind: 'user'; label: string }
  // `nodeId` is the agent's own node; `exists` is false once it was removed from the canvas.
  | { kind: 'agent'; label: string; nodeId: string; entityType: string | null; exists: boolean }
  | { kind: 'system'; label: string }

export type ActivityItem = {
  id: string
  at: string
  actor: ActivityActorView
  summary: string
  // The first affected node that can still be shown (exists and is not archived); null when none can.
  targetNodeId: string | null
}

// How long a node shows that an agent changed it.
export const RECENT_AGENT_CHANGE_MS = 5 * 60_000

export function actorView(canvas: Canvas, actor: Actor, byId: ReadonlyMap<string, CanvasNode> = canvasIndex(canvas).byId): ActivityActorView {
  switch (actor.kind) {
    case 'user':
      return { kind: 'user', label: 'You' }
    case 'system':
      return { kind: 'system', label: 'SPADE' }
    case 'agent': {
      const node = byId.get(actor.nodeId)
      return node
        ? { kind: 'agent', label: node.title, nodeId: node.id, entityType: node.entityType, exists: true }
        : { kind: 'agent', label: `Agent ${actor.agentId}`, nodeId: actor.nodeId, entityType: null, exists: false }
    }
  }
}

// Newest first.
export function activityItems(canvas: Canvas, options: { agentsOnly?: boolean } = {}): ActivityItem[] {
  const byId: ReadonlyMap<string, CanvasNode> = canvasIndex(canvas).byId
  const items: ActivityItem[] = []
  for (let i = canvas.activity.length - 1; i >= 0; i -= 1) {
    const entry = canvas.activity[i]
    if (options.agentsOnly && entry.actor.kind !== 'agent') continue
    items.push({
      id: entry.id,
      at: entry.at,
      actor: actorView(canvas, entry.actor, byId),
      summary: entry.summary,
      targetNodeId: entry.nodeIds.find((id) => byId.has(id) && !byId.get(id)!.archived) ?? null
    })
  }
  return items
}

export type AgentChange = { agentNodeId: string; agentLabel: string; at: string; summary: string }

// For each node an agent changed within RECENT_AGENT_CHANGE_MS of `now`, the newest such change, and when the
// earliest of them expires (null when there are none).
export function recentAgentChanges(
  canvas: Canvas,
  now: number
): { changes: Map<string, AgentChange>; expiresAt: number | null } {
  const byId: ReadonlyMap<string, CanvasNode> = canvasIndex(canvas).byId
  const changes = new Map<string, AgentChange>()
  let expiresAt: number | null = null
  for (let i = canvas.activity.length - 1; i >= 0; i -= 1) {
    const entry: CanvasActivity = canvas.activity[i]
    const at = Date.parse(entry.at)
    if (!(now - at < RECENT_AGENT_CHANGE_MS)) break
    if (entry.actor.kind !== 'agent') continue
    const actor = actorView(canvas, entry.actor, byId)
    for (const nodeId of entry.nodeIds) {
      // An agent's own node appears in its spawns as their source; that is not a change to it.
      if (nodeId === entry.actor.nodeId || changes.has(nodeId) || !byId.has(nodeId)) continue
      changes.set(nodeId, { agentNodeId: entry.actor.nodeId, agentLabel: actor.label, at: entry.at, summary: entry.summary })
      const expiry = at + RECENT_AGENT_CHANGE_MS
      expiresAt = expiresAt === null ? expiry : Math.min(expiresAt, expiry)
    }
  }
  return { changes, expiresAt }
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export function relativeTime(at: string, now: number): string {
  const elapsed = now - Date.parse(at)
  if (!Number.isFinite(elapsed)) return ''
  if (elapsed < 45_000) return 'just now'
  if (elapsed < HOUR) return `${Math.max(1, Math.round(elapsed / MINUTE))} min ago`
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} h ago`
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)} d ago`
  return new Date(at).toLocaleDateString()
}
