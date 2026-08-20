import type {
  Point,
  PrototypeGroup,
  PrototypeNode,
  Size,
  WorkItemStatus
} from './model'

const HULL_PADDING = 32
const HULL_HEADER_HEIGHT = 44
const HULL_MINIMUM_SIZE: Size = { width: 420, height: 260 }
const NODE_SIZE: Size = { width: 220, height: 116 }

export type GroupHullProjection = {
  id: string
  kind: PrototypeGroup['kind']
  name: string
  geometry: { position: Point; size: Size }
  memberNodeIds: string[]
  status: WorkItemStatus | null
}

export type ActivitySidebarItem = {
  id: string
  title: string
  status: WorkItemStatus
}

export function projectGroupHull(
  group: PrototypeGroup,
  nodes: readonly PrototypeNode[]
): GroupHullProjection {
  const members = nodes.filter(({ groupId }) => groupId === group.id)
  const geometry = members.length === 0
    ? { position: group.position, size: HULL_MINIMUM_SIZE }
    : memberGeometry(group.position, members)

  return {
    id: group.id,
    kind: group.kind,
    name: group.name,
    geometry,
    memberNodeIds: members.map(({ id }) => id),
    status: group.kind === 'work-item' ? group.status : null
  }
}

export function projectActivitySidebar(
  groups: readonly PrototypeGroup[]
): ActivitySidebarItem[] {
  return groups
    .filter((group): group is Extract<PrototypeGroup, { kind: 'work-item' }> => group.kind === 'work-item')
    .map(({ id, name, status }) => ({ id, title: name, status }))
}

function memberGeometry(origin: Point, members: readonly PrototypeNode[]): GroupHullProjection['geometry'] {
  const minimumX = Math.min(origin.x, ...members.map(({ position }) => position.x - HULL_PADDING))
  const minimumY = Math.min(
    origin.y,
    ...members.map(({ position }) => position.y - HULL_PADDING - HULL_HEADER_HEIGHT)
  )
  const maximumX = Math.max(
    origin.x + HULL_MINIMUM_SIZE.width,
    ...members.map(({ position }) => position.x + NODE_SIZE.width + HULL_PADDING)
  )
  const maximumY = Math.max(
    origin.y + HULL_MINIMUM_SIZE.height,
    ...members.map(({ position }) => position.y + NODE_SIZE.height + HULL_PADDING)
  )

  return {
    position: { x: minimumX, y: minimumY },
    size: { width: maximumX - minimumX, height: maximumY - minimumY }
  }
}
