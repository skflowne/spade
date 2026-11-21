// Relative shared imports: the model is also loaded by plain Playwright specs, which do not resolve `@shared`.
import type { Canvas, CanvasEdge, CanvasNode } from '../../../../shared/domain'
import { indexTree, type TreeIndex } from '../../../../shared/tree'

export type NodeReference = {
  edge: CanvasEdge
  // 'out': this node references the other one; 'in': the other node references this one.
  direction: 'out' | 'in'
  otherNodeId: string
}

// Derived lookups over one canvas record, built once per record object and shared by every consumer.
export type CanvasIndex = {
  canvas: Canvas
  byId: ReadonlyMap<string, CanvasNode>
  tree: TreeIndex
  // Archived nodes and everything a collapsed branch hides: what the canvas does not draw.
  hidden: ReadonlySet<string>
  // References in edge creation order, both directions, between nodes that exist.
  referencesOf(nodeId: string): readonly NodeReference[]
  // The node's root first, the node itself last.
  pathTo(nodeId: string): string[]
  // Ancestors whose collapsed branch hides the node, outermost first.
  collapsingAncestorsOf(nodeId: string): string[]
}

const cache = new WeakMap<Canvas, CanvasIndex>()

export function canvasIndex(canvas: Canvas): CanvasIndex {
  const cached = cache.get(canvas)
  if (cached) return cached
  const index = buildIndex(canvas)
  cache.set(canvas, index)
  return index
}

function buildIndex(canvas: Canvas): CanvasIndex {
  const byId = new Map(canvas.nodes.map((node) => [node.id, node]))
  const tree = indexTree(canvas)
  const hidden = tree.hiddenNodeIds()

  const references = new Map<string, NodeReference[]>()
  const add = (nodeId: string, reference: NodeReference): void => {
    const list = references.get(nodeId)
    if (list) list.push(reference)
    else references.set(nodeId, [reference])
  }
  for (const edge of canvas.edges) {
    if (edge.relation !== 'references' || !byId.has(edge.fromNodeId) || !byId.has(edge.toNodeId)) continue
    add(edge.fromNodeId, { edge, direction: 'out', otherNodeId: edge.toNodeId })
    if (edge.toNodeId !== edge.fromNodeId) add(edge.toNodeId, { edge, direction: 'in', otherNodeId: edge.fromNodeId })
  }

  const ancestorsOf = (nodeId: string): string[] => {
    const ancestors: string[] = []
    const seen = new Set([nodeId])
    for (let current = tree.parentOf(nodeId); current !== null && !seen.has(current); current = tree.parentOf(current)) {
      seen.add(current)
      ancestors.push(current)
    }
    return ancestors.reverse()
  }

  return {
    canvas,
    byId,
    tree,
    hidden,
    referencesOf: (nodeId) => references.get(nodeId) ?? [],
    pathTo: (nodeId) => (byId.has(nodeId) ? [...ancestorsOf(nodeId), nodeId] : []),
    collapsingAncestorsOf: (nodeId) => ancestorsOf(nodeId).filter((id) => byId.get(id)?.branchCollapsed)
  }
}
