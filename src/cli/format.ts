import { formatAgentContext } from '../shared/agentContext'
import type { AgentProviderInfo } from '../shared/agents'
import type { Actor } from '../shared/domain'
import type {
  ActivityEntry,
  EdgeSummary,
  EntitySummary,
  MutationResult,
  NodeDetail,
  NodeFlags,
  NodeSummary,
  Page,
  ProjectSummary,
  SpawnedAgent,
  TreeResult,
  WhoAmIResult
} from '../main/control/protocol'

// Compact human-readable renderings. `--json` prints the structured results instead.

// Agents are attributed by their Paseo id, with their node while they were expanded.
export function actorLabel(actor: Actor): string {
  if (actor.kind !== 'agent') return actor.kind
  return actor.nodeId === null ? `agent ${actor.agentId}` : `agent ${actor.agentId} (node ${actor.nodeId})`
}

function flags(node: NodeFlags): string {
  const set = [
    node.collapsed ? 'collapsed' : null,
    node.branchCollapsed ? 'branch-collapsed' : null,
    node.archived ? 'archived' : null
  ].filter((flag) => flag !== null)
  return set.length ? ` [${set.join(', ')}]` : ''
}

function nodeLine(node: NodeSummary): string {
  return `${node.id} · ${node.type} · ${node.title}${flags(node)}`
}

function more(page: Page<unknown>): string[] {
  return page.nextCursor === null
    ? []
    : [`(${page.items.length} of ${page.total} shown; next page: --cursor ${page.nextCursor})`]
}

export function formatWhoAmI(result: WhoAmIResult): string {
  if (result.actor.kind !== 'agent') {
    return 'You are the user (no PASEO_AGENT_ID). You can read the canvas; commands that read a whole canvas need --project <id|name>. Changes are made in SPADE itself.'
  }
  const owner = `Owner: ${result.ownerAgentId ? `Paseo agent ${result.ownerAgentId}` : 'none'}`
  const project = result.project ? `Project: ${result.project.name} (${result.project.id}) ${result.project.rootPath}` : 'Project: unknown'
  if (!result.node) {
    return [
      `You are Paseo agent ${result.actor.agentId}, collapsed into the list of node ${result.anchorNodeId ?? 'unknown'} (your nearest expanded owner); what you spawn goes there by default.`,
      owner,
      project
    ].join('\n')
  }
  return [
    `You are agent node ${nodeLine(result.node)} (Paseo agent ${result.actor.agentId})`,
    owner,
    project,
    `Parent: ${result.node.parentId ?? 'none (you are a root)'}`,
    `Children: ${result.childIds.length ? result.childIds.join(', ') : 'none'}`
  ].join('\n')
}

export function formatProjects(projects: ProjectSummary[]): string {
  if (!projects.length) return 'No projects.'
  return projects.map((project) => `${project.id} · ${project.name} · ${project.rootPath}`).join('\n')
}

export function formatTree(result: TreeResult): string {
  if (!result.items.length) return 'The canvas is empty.'
  const lines = result.items.map((line) => {
    const hidden = line.hiddenDescendants ? ` (+${line.hiddenDescendants} below)` : ''
    const self = line.id === result.selfNodeId ? '  ← you' : ''
    return `${'  '.repeat(line.depth)}${nodeLine(line)}${hidden}${self}`
  })
  return [...lines, ...more(result)].join('\n')
}

export function formatNodes(page: Page<NodeSummary>): string {
  if (!page.items.length) return 'No nodes.'
  const lines = page.items.map((node) => `${nodeLine(node)} · parent ${node.parentId ?? '—'}`)
  return [...lines, ...more(page)].join('\n')
}

export function formatNode(node: NodeDetail): string {
  const lines = [
    nodeLine(node),
    `Project: ${node.projectId}   Parent: ${node.parentId ?? 'none'}   Children (${node.childCount}): ${node.childIds.join(', ') || 'none'}`
  ]
  if (node.references.length) {
    const references = node.references.map(
      (reference) =>
        `${reference.direction === 'out' ? '→' : '←'} ${reference.nodeId}${reference.label ? ` "${reference.label}"` : ''} (edge ${reference.edgeId})`
    )
    lines.push(`References: ${references.join(', ')}`)
  }
  const size = node.size ? `   Size: ${node.size.width}×${node.size.height}` : ''
  lines.push(`Position: ${node.position.x}, ${node.position.y}${size}   Workspace: ${node.workspaceId ?? 'none'}`)
  if (node.runtime) {
    const runtime = node.runtime
    const model = [runtime.provider, runtime.model, runtime.mode].filter(Boolean).join('/')
    lines.push(
      `Agent: ${runtime.activity} (status ${runtime.status}, ${runtime.resourceState}) · ${model} · ${runtime.pendingPermissions} pending permission${runtime.pendingPermissions === 1 ? '' : 's'}`
    )
    if (runtime.lastError) lines.push(`Last error: ${runtime.lastError}`)
  }
  lines.push(formatAgentContext([node.context]))
  return lines.join('\n')
}

export function formatEdges(page: Page<EdgeSummary>): string {
  if (!page.items.length) return 'No edges.'
  const lines = page.items.map((edge) => {
    const label = edge.label ? ` "${edge.label}"` : ''
    return `${edge.id} · ${edge.fromNodeId} -${edge.relation}${label}-> ${edge.toNodeId}`
  })
  return [...lines, ...more(page)].join('\n')
}

export function formatActivity(page: Page<ActivityEntry>): string {
  if (!page.items.length) return 'No activity.'
  const lines = page.items.map((entry) => `${entry.at} · ${actorLabel(entry.actor)} · ${entry.summary}`)
  return [...lines, ...more(page)].join('\n')
}

export function formatEntities(entities: EntitySummary[]): string {
  return entities.map((entity) => `${entity.type} (${entity.displayName}): ${entity.config}`).join('\n')
}

export function formatProviders(providers: AgentProviderInfo[]): string {
  if (!providers.length) return 'No providers.'
  return providers
    .map((provider) => {
      const state = provider.available ? '' : ` [unavailable${provider.error ? `: ${provider.error}` : ''}]`
      const models = provider.models.map((model) => `${model.id}${model.isDefault ? '*' : ''}`).join(', ') || '—'
      const modes =
        provider.modes.map((mode) => `${mode.id}${mode.id === provider.defaultModeId ? '*' : ''}`).join(', ') || '—'
      return `${provider.id} (${provider.label})${state}\n  models: ${models}\n  modes: ${modes}`
    })
    .join('\n')
}

export function formatSpawnedAgent(result: SpawnedAgent): string {
  return `ok: started Paseo agent ${result.agentId}, owned by you (${result.ownerAgentId}); it is listed under its owner, not placed on the canvas`
}

export function formatMutation(verb: string, result: MutationResult): string {
  const parts = [`ok: ${verb}`]
  if (result.nodeId) parts.push(`node ${result.nodeId}`)
  if (result.edgeId) parts.push(`edge ${result.edgeId}`)
  if (result.removedNodeIds?.length) parts.push(`removed ${result.removedNodeIds.join(', ')}`)
  parts.push(`(project ${result.projectId})`)
  return parts.join(' ')
}
