import type { Node, NodeChange } from '@xyflow/react'
import type { CanvasNode } from '../../shared/domain'

export function applyCanvasNodePositionChanges<NodeType extends Node>(
  nodes: readonly CanvasNode[],
  changes: readonly NodeChange<NodeType>[]
): readonly CanvasNode[] {
  const positions = new Map<string, CanvasNode['position']>()

  for (const change of changes) {
    if (change.type === 'position' && change.position) {
      positions.set(change.id, change.position)
    }
  }

  if (positions.size === 0) {
    return nodes
  }

  let hasChanges = false
  const updatedNodes = nodes.map((node) => {
    const position = positions.get(node.id)

    if (!position || (position.x === node.position.x && position.y === node.position.y)) {
      return node
    }

    hasChanges = true
    return { ...node, position }
  })

  return hasChanges ? updatedNodes : nodes
}
