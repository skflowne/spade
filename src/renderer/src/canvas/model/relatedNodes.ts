import type { CanvasIndex } from './canvasIndex'

// Keyboard navigation between related nodes (plan §12). Archived nodes are never targets; a target inside a
// collapsed branch is still returned, and the caller reveals it.

export type RelatedDirection = 'parent' | 'first-child' | 'previous-sibling' | 'next-sibling'

export function relatedTarget(index: CanvasIndex, nodeId: string, direction: RelatedDirection): string | null {
  if (!index.byId.has(nodeId)) return null
  const live = (id: string): boolean => index.byId.get(id)?.archived === false
  const { tree } = index
  switch (direction) {
    case 'parent': {
      const parent = tree.parentOf(nodeId)
      return parent !== null && live(parent) ? parent : null
    }
    case 'first-child':
      return tree.childrenOf(nodeId).find(live) ?? null
    case 'previous-sibling':
    case 'next-sibling': {
      const parent = tree.parentOf(nodeId)
      const siblings = (parent === null ? tree.roots() : tree.childrenOf(parent)).filter(
        (id) => id === nodeId || live(id)
      )
      const position = siblings.indexOf(nodeId)
      return siblings[position + (direction === 'next-sibling' ? 1 : -1)] ?? null
    }
  }
}
