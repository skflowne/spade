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
const PLACEHOLDER_NODE_SIZE: Size = { width: 220, height: 116 }
const GITHUB_ISSUE_NODE_SIZE: Size = { width: 300, height: 250 }
const GITHUB_PULL_REQUEST_NODE_SIZE: Size = { width: 340, height: 360 }

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

export function nodePresentationSize(node: PrototypeNode): Size {
  if (node.kind === 'github-issue') return GITHUB_ISSUE_NODE_SIZE
  if (node.kind === 'github-pull-request') return GITHUB_PULL_REQUEST_NODE_SIZE
  return PLACEHOLDER_NODE_SIZE
}

function memberGeometry(origin: Point, members: readonly PrototypeNode[]): GroupHullProjection['geometry'] {
  const minimumX = Math.min(origin.x, ...members.map(({ position }) => position.x - HULL_PADDING))
  const minimumY = Math.min(
    origin.y,
    ...members.map(({ position }) => position.y - HULL_PADDING - HULL_HEADER_HEIGHT)
  )
  const maximumX = Math.max(
    origin.x + HULL_MINIMUM_SIZE.width,
    ...members.map((node) => node.position.x + nodePresentationSize(node).width + HULL_PADDING)
  )
  const maximumY = Math.max(
    origin.y + HULL_MINIMUM_SIZE.height,
    ...members.map((node) => node.position.y + nodePresentationSize(node).height + HULL_PADDING)
  )

  return {
    position: { x: minimumX, y: minimumY },
    size: { width: maximumX - minimumX, height: maximumY - minimumY }
  }
}
