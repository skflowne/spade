// Relative shared imports: this module is also loaded by plain Playwright specs, which do not resolve `@shared`.
import type { Canvas, CanvasEdgeRelation, Point, Size } from '../../../shared/domain'
import type { EntityRegistry } from '../../../shared/entities'
import { presentedSize } from '../../../shared/layout'
import { indexTree } from '../../../shared/tree'
import { canvasIndex } from './model/canvasIndex'

export type NodeView = {
  id: string
  position: Point
  size: Size
  // Non-archived descendants hidden by this node's collapsed branch; 0 when the branch is expanded.
  hiddenDescendantCount: number
  childCount: number
  // The node's parent is archived: no edge leads to it, so the chrome says so.
  parentArchived: boolean
  // `references` edges in either direction (plan §6, context-sharing indicator).
  referenceCount: number
}

export type EdgeView = {
  id: string
  source: string
  target: string
  relation: CanvasEdgeRelation
  label?: string
}

export type CanvasView = { nodes: NodeView[]; edges: EdgeView[] }

// What the canvas draws: visible nodes at their presented size, and edges whose endpoints are both visible.
export function canvasView(canvas: Canvas, entities: EntityRegistry): CanvasView {
  const index = canvasIndex(canvas)
  const { tree, hidden } = index

  const nodes = canvas.nodes
    .filter((node) => !hidden.has(node.id))
    .map((node) => ({
      id: node.id,
      position: node.position,
      size: presentedSize(node, entities.has(node.entityType) ? entities.resolve(node.entityType) : null),
      hiddenDescendantCount: node.branchCollapsed ? tree.descendantCount(node.id) : 0,
      childCount: tree.childrenOf(node.id).length,
      parentArchived: isArchived(index.byId.get(tree.parentOf(node.id) ?? '')),
      referenceCount: index.referencesOf(node.id).length
    }))

  const edges = canvas.edges
    .filter((edge) => !hidden.has(edge.fromNodeId) && !hidden.has(edge.toNodeId))
    .filter((edge) => edge.relation !== 'child' || tree.parentEdgeOf(edge.toNodeId)?.id === edge.id)
    .map((edge) => ({
      id: edge.id,
      source: edge.fromNodeId,
      target: edge.toNodeId,
      relation: edge.relation,
      ...(edge.label === undefined ? {} : { label: edge.label })
    }))

  return { nodes, edges }
}

function isArchived(node: { archived: boolean } | undefined): boolean {
  return node?.archived === true
}

// Moves a node to `position` and every descendant, hidden or not, by the same offset: a branch moves as a unit.
export function branchMoves(canvas: Canvas, nodeId: string, position: Point): Array<{ nodeId: string; position: Point }> {
  const byId = new Map(canvas.nodes.map((node) => [node.id, node]))
  const origin = byId.get(nodeId)
  if (!origin) return []
  const dx = position.x - origin.position.x
  const dy = position.y - origin.position.y
  return indexTree(canvas)
    .branchOf(nodeId)
    .map((id) => byId.get(id))
    .filter((node) => node !== undefined)
    .map((node) => ({ nodeId: node.id, position: { x: node.position.x + dx, y: node.position.y + dy } }))
}
