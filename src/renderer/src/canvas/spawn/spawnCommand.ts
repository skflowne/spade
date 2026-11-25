// Relative shared imports: this module is also loaded by plain Playwright specs, which do not resolve `@shared`.
import { AGENT_ENTITY } from '../../../../shared/builtinEntities'
import type { CanvasCommand, NodeSeed, SpawnTarget } from '../../../../shared/commands'
import type { Canvas, CanvasNode, ChildOrigin, Point, SourceArtifact } from '../../../../shared/domain'
import type { EntityRegistry } from '../../../../shared/entities'
import { firstFreeSlotBelow, reservedRect, reservedSize, TREE_SPACING } from '../../../../shared/layout'
import { indexTree } from '../../../../shared/tree'

// The three spawn targets of plan §4.6.
export type TargetChoice =
  | { kind: 'source' }
  | { kind: 'pick'; nodeId: string | null; attach: 'node' | 'root' }
  | { kind: 'new-tree' }

export function defaultTargetChoice(sourceNodeId: string | null): TargetChoice {
  return sourceNodeId === null ? { kind: 'new-tree' } : { kind: 'source' }
}

// Null while the choice is incomplete (no node picked yet).
export function spawnTargetOf(choice: TargetChoice, sourceNodeId: string | null): SpawnTarget | null {
  switch (choice.kind) {
    case 'source':
      return sourceNodeId === null ? null : { kind: 'child', parentNodeId: sourceNodeId }
    case 'pick':
      if (choice.nodeId === null) return null
      return choice.attach === 'node' ? { kind: 'child', parentNodeId: choice.nodeId } : { kind: 'tree', nodeId: choice.nodeId }
    case 'new-tree':
      return { kind: 'new-tree' }
  }
}

// A child edge between two agents means only Paseo's parent and child. A new agent the user would attach under
// an agent node is placed next to that node instead, unconnected; this is that node, or null.
export function agentAnchorOf(canvas: Canvas, entityType: string, target: SpawnTarget | null): CanvasNode | null {
  if (entityType !== AGENT_ENTITY || target === null || target.kind === 'new-tree') return null
  const parentId = target.kind === 'child' ? target.parentNodeId : indexTree(canvas).rootOf(target.nodeId)
  const parent = canvas.nodes.find((node) => node.id === parentId)
  return parent?.entityType === AGENT_ENTITY ? parent : null
}

// Beside the anchor, at the spacing between trees, moved down until it clears every node.
function besideNode(canvas: Canvas, entities: EntityRegistry, anchor: CanvasNode, seed: NodeSeed): Point {
  const definitionOf = (node: Pick<CanvasNode, 'entityType'>) => (entities.has(node.entityType) ? entities.resolve(node.entityType) : null)
  const anchorRect = reservedRect(anchor, definitionOf(anchor))
  const obstacles = canvas.nodes
    .filter((node) => !node.archived)
    .map((node) => ({ rect: reservedRect(node, definitionOf(node)), clearance: TREE_SPACING }))
  return firstFreeSlotBelow(
    { x: anchorRect.x + anchorRect.width + TREE_SPACING, y: anchorRect.y },
    reservedSize({ size: seed.size }, definitionOf(seed)),
    obstacles
  )
}

// Builds the command for a seed and a target. Without a source, the picked node is the source.
export function spawnCommand(input: {
  canvas: Canvas
  entities: EntityRegistry
  seed: NodeSeed
  sourceNodeId: string | null
  choice: TargetChoice
  origin: ChildOrigin
  sourceArtifact?: SourceArtifact
}): CanvasCommand | null {
  const target = spawnTargetOf(input.choice, input.sourceNodeId)
  if (target === null) return null
  const anchor = agentAnchorOf(input.canvas, input.seed.entityType, target)
  if (anchor !== null) {
    // A spawn takes its source's workspace; a new tree does not, so it is named here.
    const source = input.canvas.nodes.find((node) => node.id === (input.sourceNodeId ?? anchor.id))
    const workspaceId = input.seed.workspaceId === undefined ? (source?.workspaceId ?? null) : input.seed.workspaceId
    const position = input.seed.position ?? besideNode(input.canvas, input.entities, anchor, input.seed)
    return { type: 'startTree', node: { ...input.seed, ...(workspaceId === null ? {} : { workspaceId }), position } }
  }
  if (input.sourceNodeId === null) {
    if (target.kind === 'new-tree') return { type: 'startTree', node: input.seed }
    const sourceNodeId = target.kind === 'child' ? target.parentNodeId : target.nodeId
    return { type: 'spawnChild', sourceNodeId, node: input.seed, target, origin: input.origin }
  }
  return {
    type: 'spawnChild',
    sourceNodeId: input.sourceNodeId,
    node: input.seed,
    target,
    origin: input.origin,
    ...(input.sourceArtifact ? { sourceArtifact: input.sourceArtifact } : {})
  }
}
