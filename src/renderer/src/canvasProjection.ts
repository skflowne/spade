import type { CSSProperties } from 'react'
import type { Edge, Node, Viewport } from '@xyflow/react'
import type { CanvasNode, Project, WorkItem, Workspace } from '@shared/domain'
import type {
  ProjectAccent,
  ProjectPrototypeRecords,
  PrototypeNodeConfig
} from './projectPrototypeData'

export type NavigationMode = 'dedicated' | 'global'
export type WorkItemGrouping = 'hull' | 'parent'

export type EntityNodeData = {
  entity: CanvasNode
  config: PrototypeNodeConfig
  workspace: Workspace | null
  workItem: WorkItem
  project: Project
  accent: ProjectAccent
}

export type GroupNodeData = {
  label: string
  meta: string
  accent: ProjectAccent
  kind: 'project' | 'work-item' | 'hull'
  projectId: string
  workItemId: string | null
}

export type PrototypeEntityFlowNode = Node<EntityNodeData, 'entity'>
export type PrototypeGroupFlowNode = Node<GroupNodeData, 'projectGroup' | 'workItemGroup' | 'hull'>
export type PrototypeFlowNode = PrototypeEntityFlowNode | PrototypeGroupFlowNode

export type CanvasProjection = {
  nodes: PrototypeFlowNode[]
  edges: Edge[]
}

export type ProjectLayout = {
  position: CanvasNode['position']
  size: { width: number; height: number }
}

export function canonicalNodePosition(
  nodes: readonly PrototypeFlowNode[],
  nodeId: string,
  position: CanvasNode['position']
): CanvasNode['position'] {
  const node = nodes.find(({ id }) => id === nodeId)
  if (!node?.parentId) return position

  const parent = nodes.find(({ id }) => id === node.parentId)
  return parent?.type === 'workItemGroup'
    ? { x: position.x + parent.position.x, y: position.y + parent.position.y }
    : position
}

export const defaultDedicatedViewport: Viewport = { x: 24, y: 30, zoom: 0.82 }
export const defaultGlobalViewport: Viewport = { x: 32, y: 32, zoom: 0.34 }

export const entityNodeGeometry = { width: 240, height: 132 } as const
const workItemPadding = { x: 28, top: 54, bottom: 28 }
const projectSize = { width: 1180, height: 800 }
const projectGap = 80

export function projectCanvas(
  records: ProjectPrototypeRecords,
  mode: NavigationMode,
  grouping: WorkItemGrouping,
  selectedProjectId: string,
  projectLayouts: Readonly<Record<string, ProjectLayout>> = {}
): CanvasProjection {
  const visibleProjects = mode === 'global'
    ? records.projects
    : records.projects.filter(({ id }) => id === selectedProjectId)
  const nodes: PrototypeFlowNode[] = []

  visibleProjects.forEach((project, index) => {
    const projectParentId = mode === 'global' ? `project-group-${project.id}` : undefined

    const projectLayout = projectLayouts[project.id]
    const currentProjectSize = projectLayout?.size ?? projectSize

    if (projectParentId) {
      const column = index % 2
      const row = Math.floor(index / 2)
      nodes.push({
        id: projectParentId,
        type: 'projectGroup',
        position: projectLayout?.position ?? {
          x: column * (projectSize.width + projectGap),
          y: row * (projectSize.height + projectGap)
        },
        data: {
          label: project.name,
          meta: projectSummary(records, project.id),
          accent: records.projectAccents[project.id],
          kind: 'project',
          projectId: project.id,
          workItemId: null
        },
        style: groupStyle(records.projectAccents[project.id], currentProjectSize),
        draggable: true,
        selectable: false
      })
    }

    appendProjectNodes(
      nodes,
      records,
      project,
      grouping,
      projectParentId,
      projectParentId ? currentProjectSize : undefined
    )
  })

  const nodeIds = new Set(nodes.filter(({ type }) => type === 'entity').map(({ id }) => id))
  const edges = records.edges
    .filter(({ fromNodeId, toNodeId }) => nodeIds.has(fromNodeId) && nodeIds.has(toNodeId))
    .map((edge) => ({
      id: edge.id,
      source: edge.fromNodeId,
      target: edge.toNodeId,
      label: edge.relation,
      type: 'smoothstep',
      style: { stroke: 'var(--cr-ink-500)' }
    }))

  return { nodes, edges }
}

export function projectSummary(records: ProjectPrototypeRecords, projectId: string): string {
  const workItems = records.workItems.filter((item) => item.projectId === projectId)
  const active = workItems.filter((item) => item.status !== 'done' && item.status !== 'archived').length
  const workspaces = records.workspaces.filter((workspace) => workspace.projectId === projectId).length
  return `${active} active · ${workItems.length} issues · ${workspaces} workspaces`
}

function appendProjectNodes(
  target: PrototypeFlowNode[],
  records: ProjectPrototypeRecords,
  project: Project,
  grouping: WorkItemGrouping,
  projectParentId?: string,
  projectParentSize?: { width: number; height: number }
): void {
  const projectWorkItems = records.workItems.filter((item) => item.projectId === project.id)

  for (const workItem of projectWorkItems) {
    const members = records.nodes.filter((node) => node.workItemId === workItem.id)
    if (members.length === 0) continue

    const bounds = workItemBounds(members, projectParentSize)
    const workItemGroupId = `work-item-${workItem.id}`
    const accent = records.projectAccents[project.id]

    target.push({
      id: workItemGroupId,
      type: grouping === 'parent' ? 'workItemGroup' : 'hull',
      position: { x: bounds.x, y: bounds.y },
      parentId: projectParentId,
      data: {
        label: workItem.title,
        meta: `${workItem.status} · ${members.length} nodes`,
        accent,
        kind: grouping === 'parent' ? 'work-item' : 'hull',
        projectId: project.id,
        workItemId: workItem.id
      },
      style: groupStyle(accent, bounds),
      draggable: true,
      selectable: false,
      zIndex: -1
    })

    for (const entity of members) {
      const parentId = grouping === 'parent' ? workItemGroupId : projectParentId
      const position = grouping === 'parent'
        ? { x: entity.position.x - bounds.x, y: entity.position.y - bounds.y }
        : entity.position

      target.push(toEntityNode(
        records,
        entity,
        workItem,
        project,
        accent,
        parentId,
        position,
        grouping === 'parent'
      ))
    }
  }
}

function toEntityNode(
  records: ProjectPrototypeRecords,
  entity: CanvasNode,
  workItem: WorkItem,
  project: Project,
  accent: ProjectAccent,
  parentId: string | undefined,
  position: CanvasNode['position'],
  constrainToParent: boolean
): PrototypeEntityFlowNode {
  return {
    id: entity.id,
    type: 'entity',
    position,
    parentId,
    extent: constrainToParent ? 'parent' : undefined,
    dragHandle: '.entity-node__chrome',
    style: entityNodeGeometry,
    data: {
      entity,
      config: entity.config as PrototypeNodeConfig,
      workspace: records.workspaces.find(({ id }) => id === entity.workspaceId) ?? null,
      workItem,
      project,
      accent
    }
  }
}

function workItemBounds(
  nodes: readonly CanvasNode[],
  parentSize?: { width: number; height: number }
): { x: number; y: number; width: number; height: number } {
  const minX = Math.min(...nodes.map(({ position }) => position.x)) - workItemPadding.x
  const minY = Math.min(...nodes.map(({ position }) => position.y)) - workItemPadding.top
  const maxX = Math.max(...nodes.map(({ position }) => position.x + entityNodeGeometry.width)) + workItemPadding.x
  const maxY = Math.max(...nodes.map(({ position }) => position.y + entityNodeGeometry.height)) + workItemPadding.bottom
  const x = parentSize ? Math.max(0, minX) : minX
  const y = parentSize ? Math.max(0, minY) : minY
  const right = parentSize ? Math.min(parentSize.width, maxX) : maxX
  const bottom = parentSize ? Math.min(parentSize.height, maxY) : maxY

  return { x, y, width: right - x, height: bottom - y }
}

function groupStyle(accent: ProjectAccent, size: { width: number; height: number }): CSSProperties {
  return {
    width: size.width,
    height: size.height,
    '--group-accent': accent.color,
    '--group-tint': accent.tint
  } as CSSProperties
}
