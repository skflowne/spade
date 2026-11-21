import type { Canvas, CanvasEdge, CanvasNode } from './domain'

// The one generic tree mechanic (plan §4.6). Structure comes only from `child` edges; entity types never matter.
export type TreeIndex = {
  parentEdgeOf(nodeId: string): CanvasEdge | null
  parentOf(nodeId: string): string | null
  // In node creation order.
  childrenOf(nodeId: string): string[]
  // Depth-first, children in creation order.
  descendantsOf(nodeId: string): string[]
  // The node followed by its descendants.
  branchOf(nodeId: string): string[]
  rootOf(nodeId: string): string
  // In node creation order.
  roots(): string[]
  // True when `newParentId` is the node itself or one of its descendants.
  wouldCreateCycle(nodeId: string, newParentId: string | null): boolean
  // Non-archived descendants: what a collapsed branch hides from view.
  descendantCount(nodeId: string): number
  // Archived nodes, plus every descendant of a branch-collapsed node.
  hiddenNodeIds(): Set<string>
}

export function indexTree(canvas: Canvas): TreeIndex {
  const nodes = new Map<string, CanvasNode>(canvas.nodes.map((node) => [node.id, node]))

  // Records written by the reducer form a forest; for anything else the first parent edge wins.
  const parentEdges = new Map<string, CanvasEdge>()
  for (const edge of canvas.edges) {
    if (edge.relation !== 'child') continue
    if (!nodes.has(edge.fromNodeId) || !nodes.has(edge.toNodeId)) continue
    if (parentEdges.has(edge.toNodeId)) continue
    parentEdges.set(edge.toNodeId, edge)
  }

  const children = new Map<string, string[]>()
  for (const node of canvas.nodes) {
    const parentEdge = parentEdges.get(node.id)
    if (!parentEdge) continue
    const list = children.get(parentEdge.fromNodeId)
    if (list) list.push(node.id)
    else children.set(parentEdge.fromNodeId, [node.id])
  }

  const parentOf = (nodeId: string): string | null => parentEdges.get(nodeId)?.fromNodeId ?? null
  const childrenOf = (nodeId: string): string[] => [...(children.get(nodeId) ?? [])]

  const descendantsOf = (nodeId: string): string[] => {
    const result: string[] = []
    const visited = new Set<string>([nodeId])
    const visit = (id: string): void => {
      for (const child of children.get(id) ?? []) {
        if (visited.has(child)) continue
        visited.add(child)
        result.push(child)
        visit(child)
      }
    }
    visit(nodeId)
    return result
  }

  const rootOf = (nodeId: string): string => {
    const visited = new Set<string>()
    let current = nodeId
    for (;;) {
      visited.add(current)
      const parent = parentOf(current)
      if (parent === null || visited.has(parent)) return current
      current = parent
    }
  }

  return {
    parentEdgeOf: (nodeId) => parentEdges.get(nodeId) ?? null,
    parentOf,
    childrenOf,
    descendantsOf,
    branchOf: (nodeId) => [nodeId, ...descendantsOf(nodeId)],
    rootOf,
    roots: () => canvas.nodes.filter((node) => !parentEdges.has(node.id)).map((node) => node.id),
    wouldCreateCycle: (nodeId, newParentId) =>
      newParentId !== null && (newParentId === nodeId || descendantsOf(nodeId).includes(newParentId)),
    descendantCount: (nodeId) => descendantsOf(nodeId).filter((id) => !nodes.get(id)?.archived).length,
    hiddenNodeIds: () => {
      const hidden = new Set<string>()
      for (const node of canvas.nodes) {
        if (node.archived) hidden.add(node.id)
        if (node.branchCollapsed) for (const id of descendantsOf(node.id)) hidden.add(id)
      }
      return hidden
    }
  }
}
