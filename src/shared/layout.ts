import type { Canvas, CanvasNode, Point, Rect, Size } from './domain'
import type { EntityDefinition, EntityRegistry } from './entities'
import { indexTree } from './tree'

// Default placement (plan §8). Automatic layout only chooses where new nodes start; it never moves a node.

export const SIBLING_SPACING = 96
export const PARENT_CHILD_SPACING = 160
export const TREE_SPACING = 240
// Footprint of a node whose entity type is not registered, so it still reserves space.
export const UNKNOWN_ENTITY_SIZE: Size = { width: 320, height: 200 }

type SizeSource = Pick<EntityDefinition, 'defaultSize'> | null
type PresentationSource = Pick<EntityDefinition, 'defaultSize' | 'collapsedSize'> | null

// The expanded footprint placement reserves, whatever the node's collapsed state.
export function reservedSize(node: Pick<CanvasNode, 'size'>, definition: SizeSource): Size {
  return node.size ?? definition?.defaultSize ?? UNKNOWN_ENTITY_SIZE
}

// The size the node is drawn at.
export function presentedSize(node: Pick<CanvasNode, 'size' | 'collapsed'>, definition: PresentationSource): Size {
  if (node.collapsed) return definition?.collapsedSize ?? reservedSize(node, definition)
  return reservedSize(node, definition)
}

export function reservedRect(node: Pick<CanvasNode, 'size' | 'position'>, definition: SizeSource): Rect {
  return { ...node.position, ...reservedSize(node, definition) }
}

// A rectangle a new node must keep at least `clearance` away from on both axes.
export type PlacementObstacle = { rect: Rect; clearance: number }

function collides(position: Point, size: Size, obstacle: PlacementObstacle): boolean {
  const { rect, clearance } = obstacle
  return (
    position.x < rect.x + rect.width + clearance &&
    position.x + size.width + clearance > rect.x &&
    position.y < rect.y + rect.height + clearance &&
    position.y + size.height + clearance > rect.y
  )
}

// The nearest position at or below `start`, in the same column, that collides with no obstacle.
export function firstFreeSlotBelow(start: Point, size: Size, obstacles: readonly PlacementObstacle[]): Point {
  let y = start.y
  for (;;) {
    const blocking = obstacles.filter((obstacle) => collides({ x: start.x, y }, size, obstacle))
    if (blocking.length === 0) return { x: start.x, y }
    // Every y between here and the lowest blocking edge still collides with that obstacle.
    y = Math.max(...blocking.map(({ rect, clearance }) => rect.y + rect.height + clearance))
  }
}

export function placeRoot(input: { occupied: readonly Rect[]; size: Size }): Point {
  if (input.occupied.length === 0) return { x: 0, y: 0 }
  const left = Math.min(...input.occupied.map((rect) => rect.x))
  const bottom = Math.max(...input.occupied.map((rect) => rect.y + rect.height))
  return { x: left, y: bottom + TREE_SPACING }
}

export function placeChild(input: {
  parent: Rect
  // Bounding rectangles of the parent's existing children's subtrees.
  earlierSubtrees: readonly Rect[]
  size: Size
  obstacles: readonly PlacementObstacle[]
}): Point {
  const x = input.parent.x + input.parent.width + PARENT_CHILD_SPACING
  const y =
    input.earlierSubtrees.length === 0
      ? input.parent.y
      : Math.max(...input.earlierSubtrees.map((rect) => rect.y + rect.height)) + SIBLING_SPACING
  return firstFreeSlotBelow({ x, y }, input.size, input.obstacles)
}

function boundingRect(rects: readonly Rect[]): Rect {
  const left = Math.min(...rects.map((rect) => rect.x))
  const top = Math.min(...rects.map((rect) => rect.y))
  const right = Math.max(...rects.map((rect) => rect.x + rect.width))
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

// Where a new node of `size` starts: as the next child of `parentId`, or as a new root when it is null.
export function placeNode(
  canvas: Canvas,
  entities: EntityRegistry,
  placement: { parentId: string | null; size: Size }
): Point {
  const definitionOf = (node: CanvasNode): SizeSource =>
    entities.has(node.entityType) ? entities.resolve(node.entityType) : null
  const rects = new Map(canvas.nodes.map((node) => [node.id, reservedRect(node, definitionOf(node))]))
  const reserving = canvas.nodes.filter((node) => !node.archived)

  if (placement.parentId === null) {
    return placeRoot({ occupied: reserving.map((node) => rects.get(node.id)!), size: placement.size })
  }

  const parentRect = rects.get(placement.parentId)
  if (!parentRect) throw new Error(`Unknown parent node: ${placement.parentId}`)

  const tree = indexTree(canvas)
  const archived = new Set(canvas.nodes.filter((node) => node.archived).map((node) => node.id))
  const earlierSubtrees = tree
    .childrenOf(placement.parentId)
    .map((childId) => tree.branchOf(childId).filter((id) => !archived.has(id)))
    .filter((branch) => branch.length > 0)
    .map((branch) => boundingRect(branch.map((id) => rects.get(id)!)))

  const treeRoot = tree.rootOf(placement.parentId)
  const obstacles = reserving.map((node) => ({
    rect: rects.get(node.id)!,
    clearance: tree.rootOf(node.id) === treeRoot ? SIBLING_SPACING : TREE_SPACING
  }))

  return placeChild({ parent: parentRect, earlierSubtrees, size: placement.size, obstacles })
}
