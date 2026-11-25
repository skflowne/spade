import type { AgentRuntime, ChildAgentInfo } from '../../../../shared/agents'
import { PASEO_AGENT_KIND } from '../../../../shared/builtinEntities'
import type { Actor, Canvas, CanvasActivity, CanvasNode } from '../../../../shared/domain'
import { canvasIndex } from './canvasIndex'

// Who changed what (plan §4.6, attribution), derived from the canvas's activity log.

export type ActivityActorView =
  | { kind: 'user'; label: string }
  // An agent is identified by its Paseo id. `nodeId` is its node on this canvas, null while it is collapsed
  // into its owner's list; `exists` is false when it has no node here (removed, or collapsed).
  | { kind: 'agent'; label: string; agentId: string; nodeId: string | null; entityType: string | null; exists: boolean }
  | { kind: 'system'; label: string }

export type ActivityItem = {
  id: string
  at: string
  actor: ActivityActorView
  summary: string
  // The first affected node that can still be shown (exists and is not archived); null when none can.
  targetNodeId: string | null
}

// What the renderer knows of agents without a node of their own, from the project's agent runtimes.
export type AgentDirectory = {
  // Paseo agent id to title, for every agent a runtime names with a title.
  titles: ReadonlyMap<string, string>
  // A collapsed agent's nearest expanded owner: the node it acts from.
  owners: ReadonlyMap<string, string>
}

export const EMPTY_AGENT_DIRECTORY: AgentDirectory = { titles: new Map(), owners: new Map() }

export function agentDirectory(runtimes: Iterable<AgentRuntime>, projectId: string): AgentDirectory {
  const titles = new Map<string, string>()
  const owners = new Map<string, string>()
  const visit = (children: readonly ChildAgentInfo[], ownerNodeId: string): void => {
    for (const child of children) {
      if (child.title !== null) titles.set(child.agentId, child.title)
      if (child.nodeId !== null) continue
      owners.set(child.agentId, ownerNodeId)
      visit(child.children, ownerNodeId)
    }
  }
  for (const runtime of runtimes) {
    if (runtime.projectId !== projectId) continue
    if (runtime.title !== null) titles.set(runtime.agentId, runtime.title)
    visit(runtime.children, runtime.nodeId)
  }
  return { titles, owners }
}

export function sameAgentDirectory(a: AgentDirectory, b: AgentDirectory): boolean {
  const sameMap = (x: ReadonlyMap<string, string>, y: ReadonlyMap<string, string>): boolean =>
    x.size === y.size && [...x].every(([key, value]) => y.get(key) === value)
  return sameMap(a.titles, b.titles) && sameMap(a.owners, b.owners)
}

// How long a node shows that an agent changed it.
export const RECENT_AGENT_CHANGE_MS = 5 * 60_000

type AgentActor = Extract<Actor, { kind: 'agent' }>

function agentNodeOf(canvas: Canvas, byId: ReadonlyMap<string, CanvasNode>, actor: AgentActor): CanvasNode | null {
  if (actor.nodeId !== null) {
    const node = byId.get(actor.nodeId)
    if (node) return node
  }
  // An agent that acted while collapsed and was expanded since.
  return (
    canvas.nodes.find(
      (node) =>
        node.resourceRef?.provider === 'paseo' && node.resourceRef.kind === PASEO_AGENT_KIND && node.resourceRef.id === actor.agentId
    ) ?? null
  )
}

export function actorView(
  canvas: Canvas,
  actor: Actor,
  byId: ReadonlyMap<string, CanvasNode> = canvasIndex(canvas).byId,
  agents: AgentDirectory = EMPTY_AGENT_DIRECTORY
): ActivityActorView {
  switch (actor.kind) {
    case 'user':
      return { kind: 'user', label: 'You' }
    case 'system':
      return { kind: 'system', label: 'SPADE' }
    case 'agent': {
      const node = agentNodeOf(canvas, byId, actor)
      return node
        ? { kind: 'agent', label: node.title, agentId: actor.agentId, nodeId: node.id, entityType: node.entityType, exists: true }
        : {
            kind: 'agent',
            label: agents.titles.get(actor.agentId) ?? `Agent ${actor.agentId}`,
            agentId: actor.agentId,
            nodeId: actor.nodeId,
            entityType: null,
            exists: false
          }
    }
  }
}

// Newest first.
export function activityItems(canvas: Canvas, options: { agentsOnly?: boolean; agents?: AgentDirectory } = {}): ActivityItem[] {
  const byId: ReadonlyMap<string, CanvasNode> = canvasIndex(canvas).byId
  const items: ActivityItem[] = []
  for (let i = canvas.activity.length - 1; i >= 0; i -= 1) {
    const entry = canvas.activity[i]
    if (options.agentsOnly && entry.actor.kind !== 'agent') continue
    items.push({
      id: entry.id,
      at: entry.at,
      actor: actorView(canvas, entry.actor, byId, options.agents),
      summary: entry.summary,
      targetNodeId: entry.nodeIds.find((id) => byId.has(id) && !byId.get(id)!.archived) ?? null
    })
  }
  return items
}

export type AgentChange = { agentId: string; agentNodeId: string | null; agentLabel: string; at: string; summary: string }

// For each node an agent changed within RECENT_AGENT_CHANGE_MS of `now`, the newest such change, and when the
// earliest of them expires (null when there are none).
export function recentAgentChanges(
  canvas: Canvas,
  now: number,
  agents: AgentDirectory = EMPTY_AGENT_DIRECTORY
): { changes: Map<string, AgentChange>; expiresAt: number | null } {
  const byId: ReadonlyMap<string, CanvasNode> = canvasIndex(canvas).byId
  const changes = new Map<string, AgentChange>()
  let expiresAt: number | null = null
  for (let i = canvas.activity.length - 1; i >= 0; i -= 1) {
    const entry: CanvasActivity = canvas.activity[i]
    const at = Date.parse(entry.at)
    if (!(now - at < RECENT_AGENT_CHANGE_MS)) break
    if (entry.actor.kind !== 'agent') continue
    const actor = actorView(canvas, entry.actor, byId, agents)
    if (actor.kind !== 'agent') continue
    // The node an agent acts from appears in its spawns as their source; that is not a change to it. A collapsed
    // agent acts from its nearest expanded owner's node.
    const actingFrom = entry.actor.nodeId ?? agents.owners.get(entry.actor.agentId) ?? null
    for (const nodeId of entry.nodeIds) {
      if (nodeId === actingFrom || nodeId === actor.nodeId || changes.has(nodeId) || !byId.has(nodeId)) continue
      changes.set(nodeId, { agentId: actor.agentId, agentNodeId: actor.nodeId, agentLabel: actor.label, at: entry.at, summary: entry.summary })
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
