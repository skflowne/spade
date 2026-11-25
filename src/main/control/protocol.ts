import type { AgentActivity, AgentContextReference, AgentProviderInfo } from '../../shared/agents'
import type { CanvasCommand, CanvasCommandErrorCode } from '../../shared/commands'
import type { AgentServiceErrorCode } from '../agents/errors'
import type { Actor, CanvasEdgeRelation, Point, Size } from '../../shared/domain'

// Wire protocol between the `spade` CLI and the control server. Pure types and constants: the CLI bundle
// imports this file, so it must never pull in Node or Electron modules.

export const CONTROL_PROTOCOL_VERSION = 1
export const CONTROL_FILE_NAME = 'control.json'
export const CONTROL_FILE_ENV = 'SPADE_CONTROL_FILE'
// Set by Paseo in every agent's environment.
export const PASEO_AGENT_ID_ENV = 'PASEO_AGENT_ID'
export const RPC_PATH = '/rpc'

export const DEFAULT_PAGE_LIMIT = 50
export const MAX_PAGE_LIMIT = 200
export const DEFAULT_TREE_DEPTH = 6
export const MAX_TREE_DEPTH = 50

export type ControlDiscovery = {
  version: number
  url: string
  token: string
  pid: number
  startedAt: string
}

export type ControlErrorCode =
  | CanvasCommandErrorCode
  | AgentServiceErrorCode
  | 'internal'
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'payload-too-large'
  | 'bad-request'
  | 'unknown-method'
  | 'invalid-params'
  | 'unknown-agent'
  | 'project-required'
  // A change came without an agent identity; only agents change the canvas through the CLI.
  | 'identity-required'

export type ControlError = { code: ControlErrorCode; message: string }

export type RpcRequest = {
  method: string
  params?: unknown
  // The caller's PASEO_AGENT_ID; absent when a human runs the CLI, who may only read.
  agentId?: string
}

// Methods that change the canvas or start an agent; refused without an agent identity.
export const MUTATING_METHODS: readonly RpcMethod[] = ['spawn', 'execute']

export type RpcResponse<Result = unknown> = { ok: true; result: Result } | { ok: false; error: ControlError }

// Every page is bounded; `nextCursor` is null on the last page.
export type Page<Item> = { items: Item[]; total: number; nextCursor: string | null }
export type PageParams = { cursor?: string; limit?: number }
// `project` is a project id or exact name. Commands that name a node resolve the project from the node.
export type ProjectParams = { project?: string }

export type ProjectSummary = { id: string; name: string; rootPath: string }

export type NodeFlags = { collapsed: boolean; branchCollapsed: boolean; archived: boolean }

export type NodeSummary = NodeFlags & {
  id: string
  type: string
  title: string
  parentId: string | null
  childCount: number
}

export type WhoAmIResult = {
  actor: Actor
  // The project of the canvas the agent shows on (its own node's, or its nearest expanded owner's).
  project: ProjectSummary | null
  // The agent's own node while it is expanded; null while it is collapsed into its owner's list.
  node: NodeSummary | null
  // The Paseo agent that owns it; null for a top-level agent and for the user.
  ownerAgentId: string | null
  // Where its spawns go by default: its own node, or its nearest expanded owner's.
  anchorNodeId: string | null
  // Children of its own node.
  childIds: string[]
}

export type TreeLine = NodeSummary & {
  depth: number
  // Descendants not listed because of the depth limit.
  hiddenDescendants: number
}

export type TreeParams = ProjectParams & PageParams & { rootNodeId?: string; depth?: number }
export type TreeResult = Page<TreeLine> & { projectId: string; selfNodeId: string | null }

export type NodesParams = ProjectParams & PageParams & { type?: string }

export type EdgeSummary = {
  id: string
  relation: CanvasEdgeRelation
  fromNodeId: string
  toNodeId: string
  label?: string
  origin?: string
}

export type EdgesParams = ProjectParams & PageParams & { nodeId?: string; relation?: CanvasEdgeRelation }

export type ActivityEntry = { at: string; actor: Actor; command: string; summary: string; nodeIds: string[] }

export type AgentRuntimeSummary = {
  status: string
  activity: AgentActivity
  resourceState: string
  provider: string
  model: string | null
  mode: string | null
  pendingPermissions: number
  lastError: string | null
}

export type NodeDetail = NodeSummary & {
  projectId: string
  position: Point
  size: Size | null
  workspaceId: string | null
  createdAt: string
  updatedAt: string
  childIds: string[]
  references: Array<{ edgeId: string; direction: 'out' | 'in'; nodeId: string; label?: string }>
  context: AgentContextReference
  runtime: AgentRuntimeSummary | null
}

export type EntitySummary = { type: string; displayName: string; version: number; config: string }

// Where `spawn` attaches the new node. `self` is a child of the calling agent's own node, or of its
// nearest expanded owner's while it is collapsed.
export type SpawnPlacement =
  | { kind: 'self' }
  | { kind: 'child'; parentNodeId: string }
  | { kind: 'tree'; nodeId: string }
  | { kind: 'new-tree' }

// An agent is not a node: spawning one starts a Paseo agent owned by the caller, and takes no placement,
// description, or project.
export type SpawnParams = ProjectParams & {
  entityType: string
  config: unknown
  title?: string
  description?: string
  placement?: SpawnPlacement
}

export type AgentSpawnConfig = { prompt: string; provider?: string; model?: string; mode?: string }

// The new Paseo agent, listed under its owner (the caller) rather than placed on the canvas.
export type SpawnedAgent = { agentId: string; ownerAgentId: string }

// The project comes from the nodes or edge the command names.
export type ExecuteParams = { command: CanvasCommand }

export type MutationResult = {
  projectId: string
  nodeId?: string
  edgeId?: string
  created?: boolean
  removedNodeIds?: string[]
}

export type RpcMethods = {
  whoami: { params: Record<string, never>; result: WhoAmIResult }
  projects: { params: Record<string, never>; result: ProjectSummary[] }
  tree: { params: TreeParams; result: TreeResult }
  nodes: { params: NodesParams; result: Page<NodeSummary> & { projectId: string } }
  node: { params: { nodeId: string }; result: NodeDetail }
  edges: { params: EdgesParams; result: Page<EdgeSummary> & { projectId: string } }
  activity: { params: ProjectParams & PageParams; result: Page<ActivityEntry> & { projectId: string } }
  entities: { params: Record<string, never>; result: EntitySummary[] }
  providers: { params: Record<string, never>; result: AgentProviderInfo[] }
  spawn: { params: SpawnParams; result: MutationResult | SpawnedAgent }
  execute: { params: ExecuteParams; result: MutationResult }
}

export type RpcMethod = keyof RpcMethods
