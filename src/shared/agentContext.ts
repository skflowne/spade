import {
  AGENT_CONTEXT_EXCERPT_LIMIT,
  AGENT_CONTEXT_REFERENCE_LIMIT,
  type AgentContextReference
} from './agents'
import { CanvasCommandError } from './commands'
import type { Canvas, CanvasNode } from './domain'
import type { AgentDescription, EntityRegistry } from './entities'
import { indexTree } from './tree'

// The bounded context projection handed to agents (plan §9). Nothing here is unbounded: every free-text
// field is clipped, and full transcripts, pages, or files are never read.

export type AgentContextRelation = AgentContextReference['relation']

const NAME_LIMIT = 200
const DESCRIPTION_LIMIT = 400
const LOCATOR_LIMIT = 2_048

// One node as an agent sees it. Throws `unknown-node` when the node is not on the canvas.
export function describeNodeForAgent(
  canvas: Canvas,
  entities: EntityRegistry,
  nodeId: string,
  relation: AgentContextRelation = 'selected'
): AgentContextReference {
  return project(canvas, entities, requireNode(canvas, nodeId), relation)
}

// The selected nodes, in selection order, each with its relation to the agent's node. The agent itself,
// duplicates, and ids no longer on the canvas are skipped; at most AGENT_CONTEXT_REFERENCE_LIMIT are kept.
export function buildAgentContext(
  canvas: Canvas,
  entities: EntityRegistry,
  agentNodeId: string,
  selectedNodeIds: readonly string[]
): AgentContextReference[] {
  requireNode(canvas, agentNodeId)
  const tree = indexTree(canvas)
  const parentId = tree.parentOf(agentNodeId)
  const childIds = new Set(tree.childrenOf(agentNodeId))
  const referencedIds = new Set(
    canvas.edges
      .filter((edge) => edge.relation === 'references')
      .flatMap((edge) =>
        edge.fromNodeId === agentNodeId ? [edge.toNodeId] : edge.toNodeId === agentNodeId ? [edge.fromNodeId] : []
      )
  )

  const relationOf = (nodeId: string): AgentContextRelation => {
    if (nodeId === parentId) return 'parent'
    if (childIds.has(nodeId)) return 'child'
    return referencedIds.has(nodeId) ? 'references' : 'selected'
  }

  const seen = new Set<string>([agentNodeId])
  const references: AgentContextReference[] = []
  for (const nodeId of selectedNodeIds) {
    if (references.length >= AGENT_CONTEXT_REFERENCE_LIMIT) break
    if (seen.has(nodeId)) continue
    seen.add(nodeId)
    const node = canvas.nodes.find((candidate) => candidate.id === nodeId)
    if (node) references.push(project(canvas, entities, node, relationOf(nodeId)))
  }
  return references
}

// A compact plain-text block to append to a prompt; empty when there is nothing to share.
export function formatAgentContext(references: readonly AgentContextReference[]): string {
  if (references.length === 0) return ''
  const lines = [`Canvas context (${references.length} ${references.length === 1 ? 'node' : 'nodes'}):`]
  for (const reference of references) {
    lines.push(`- ${reference.node_type} "${reference.node_name}" (id ${reference.node_id}, ${reference.relation})`)
    if (reference.short_description) lines.push(`  description: ${reference.short_description}`)
    if (reference.workspace) lines.push(`  workspace: ${reference.workspace.cwd} (id ${reference.workspace.id})`)
    if (reference.locator) lines.push(`  locator: ${reference.locator.kind} ${reference.locator.value}`)
    if (reference.revision) lines.push(`  revision: ${reference.revision}`)
    if (reference.excerpt) {
      lines.push('  excerpt:')
      for (const line of reference.excerpt.split(/\r?\n/)) lines.push(`    ${line}`)
    }
  }
  return lines.join('\n')
}

function project(
  canvas: Canvas,
  entities: EntityRegistry,
  node: CanvasNode,
  relation: AgentContextRelation
): AgentContextReference {
  const described = describe(entities, node)
  const workspace = canvas.workspaces.find((candidate) => candidate.id === node.workspaceId)
  const ref = node.resourceRef
  const locator = described.locator ?? (ref ? { kind: `${ref.provider}:${ref.kind}`, value: ref.id } : undefined)
  const revision = node.resourceRef?.revision ?? node.cachedPresentation?.revision
  const excerpt = described.excerpt ?? node.cachedPresentation?.summary

  return {
    node_type: node.entityType,
    node_id: node.id,
    node_name: clip(singleLine(node.title), NAME_LIMIT),
    ...(node.shortDescription ? { short_description: clip(singleLine(node.shortDescription), DESCRIPTION_LIMIT) } : {}),
    relation,
    ...(workspace ? { workspace: { id: workspace.id, cwd: workspace.cwd } } : {}),
    ...(locator
      ? {
          locator: {
            kind: clip(singleLine(locator.kind), NAME_LIMIT),
            value: clip(singleLine(locator.value), LOCATOR_LIMIT)
          }
        }
      : {}),
    ...(revision ? { revision: clip(singleLine(revision), NAME_LIMIT) } : {}),
    ...(excerpt?.trim() ? { excerpt: clip(excerpt, AGENT_CONTEXT_EXCERPT_LIMIT) } : {})
  }
}

// Entity description of the node's config; a config the current definition rejects describes nothing.
function describe(entities: EntityRegistry, node: CanvasNode): AgentDescription {
  if (!entities.has(node.entityType)) return {}
  const definition = entities.resolve(node.entityType)
  if (!definition.describeForAgent) return {}
  try {
    return definition.describeForAgent(definition.parseConfig(node.config))
  } catch {
    return {}
  }
}

function requireNode(canvas: Canvas, nodeId: string): CanvasNode {
  const node = canvas.nodes.find((candidate) => candidate.id === nodeId)
  if (!node) throw new CanvasCommandError('unknown-node', `Unknown node: ${nodeId}`)
  return node
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}
