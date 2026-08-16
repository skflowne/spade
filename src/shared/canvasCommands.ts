import { DOMAIN_RECORD_VERSION, type CanvasEdge, type CanvasEdgeRelation, type CanvasNode } from './domain'
import type { EntityRegistry } from './entities'

export type CanvasState = {
  nodes: readonly CanvasNode[]
  edges: readonly CanvasEdge[]
}

export type NodeCommandEnvironment = {
  registry: EntityRegistry
  createNodeId(): string
  createEdgeId(): string
  now(): string
}

export type NodePlacement = {
  position: CanvasNode['position']
  projectId: string
  workItemId: string | null
  workspaceId: string | null
}

export type CreateNodeInput<Config> = {
  type: string
  config: Config
  placement: NodePlacement
  title?: string
  shortDescription?: string
}

export type SpawnConnectedNodeInput<Config> = {
  sourceNodeId: string
  type: string
  config: Config
  relation: CanvasEdgeRelation
  position: CanvasNode['position']
  title?: string
  shortDescription?: string
}

export type ConnectNodesInput = {
  fromNodeId: string
  toNodeId: string
  relation: CanvasEdgeRelation
  label?: string
}

export function createNode<Config>(
  environment: NodeCommandEnvironment,
  input: CreateNodeInput<Config>
): CanvasNode {
  const definition = environment.registry.resolve<Config>(input.type)
  const id = environment.createNodeId()
  const createdAt = environment.now()
  const created = definition.adapter.create({ nodeId: id, config: input.config })

  return {
    version: DOMAIN_RECORD_VERSION,
    id,
    entityType: definition.type,
    entityVersion: definition.version,
    title: input.title ?? created.title ?? definition.displayName,
    shortDescription: input.shortDescription ?? created.shortDescription,
    position: input.placement.position,
    collapsed: false,
    projectId: input.placement.projectId,
    workItemId: input.placement.workItemId,
    workspaceId: input.placement.workspaceId,
    config: input.config,
    resourceRef: created.resourceRef,
    createdAt,
    updatedAt: createdAt
  }
}

export function spawnConnectedNode<Config>(
  environment: NodeCommandEnvironment,
  state: CanvasState,
  input: SpawnConnectedNodeInput<Config>
): { node: CanvasNode; edge: CanvasEdge } {
  const source = requireNode(state, input.sourceNodeId)
  const node = createNode(environment, {
    type: input.type,
    config: input.config,
    placement: {
      position: input.position,
      projectId: source.projectId,
      workItemId: source.workItemId,
      workspaceId: source.workspaceId
    },
    title: input.title,
    shortDescription: input.shortDescription
  })
  const edge = connectNodes(environment, { ...state, nodes: [...state.nodes, node] }, {
    fromNodeId: source.id,
    toNodeId: node.id,
    relation: input.relation
  })

  return { node, edge }
}

export function connectNodes(
  environment: NodeCommandEnvironment,
  state: CanvasState,
  input: ConnectNodesInput
): CanvasEdge {
  requireNode(state, input.fromNodeId)
  requireNode(state, input.toNodeId)

  return {
    version: DOMAIN_RECORD_VERSION,
    id: environment.createEdgeId(),
    fromNodeId: input.fromNodeId,
    toNodeId: input.toNodeId,
    relation: input.relation,
    label: input.label,
    createdAt: environment.now()
  }
}

function requireNode(state: CanvasState, nodeId: string): CanvasNode {
  const node = state.nodes.find(({ id }) => id === nodeId)

  if (!node) {
    throw new Error(`Unknown canvas node: ${nodeId}`)
  }

  return node
}
