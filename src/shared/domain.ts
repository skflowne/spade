export const DOMAIN_RECORD_VERSION = 2 as const

export type DomainRecordVersion = typeof DOMAIN_RECORD_VERSION

export type Point = { x: number; y: number }
export type Size = { width: number; height: number }
export type Rect = Point & Size
export type Viewport = { x: number; y: number; zoom: number }

export type ResourceRef = {
  provider: 'paseo' | 'filesystem' | 'electron' | 'spade' | (string & {})
  kind: string
  id: string
  revision?: string
}

export type CanvasNode = {
  version: DomainRecordVersion
  id: string
  entityType: string
  entityVersion: number
  title: string
  shortDescription?: string
  position: Point
  // Absent means the entity definition's default size.
  size?: Size
  collapsed: boolean
  // Hides every descendant of this node; the node itself stays visible.
  branchCollapsed: boolean
  archived: boolean
  projectId: string
  // Always null until Group containers exist.
  groupId: string | null
  workspaceId: string | null
  config: unknown
  resourceRef: ResourceRef | null
  cachedPresentation?: {
    revision?: string
    summary?: string
    updatedAt: string
  }
  createdAt: string
  updatedAt: string
}

export type Workspace = {
  version: DomainRecordVersion
  id: string
  projectId: string
  cwd: string
  paseoWorkspaceId?: string
  name: string
  createdAt: string
}

export type Project = {
  version: DomainRecordVersion
  id: string
  name: string
  // Absolute path exactly as the user selected it; identity is `id`, never the path.
  rootPath: string
  createdAt: string
}

export type CanvasEdgeRelation = 'child' | 'references'
export type ChildOrigin = 'spawned' | 'delegated' | 'artifact'
export type SourceArtifact = { kind: string; value: string }

export type CanvasEdge = {
  version: DomainRecordVersion
  id: string
  // Parent for "child".
  fromNodeId: string
  // Child for "child".
  toNodeId: string
  relation: CanvasEdgeRelation
  origin?: ChildOrigin
  sourceArtifact?: SourceArtifact
  label?: string
  createdAt: string
}

export type Actor =
  | { kind: 'user' }
  // A Paseo agent acting through the CLI; `nodeId` is the agent's own canvas node.
  | { kind: 'agent'; nodeId: string; agentId: string }
  // SPADE itself, for example sub-agent reconciliation.
  | { kind: 'system' }

export type CanvasActivity = {
  id: string
  at: string
  actor: Actor
  command: string
  summary: string
  nodeIds: string[]
}

export const CANVAS_ACTIVITY_LIMIT = 200

export type Canvas = {
  version: DomainRecordVersion
  projectId: string
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  workspaces: Workspace[]
  viewport: Viewport | null
  // Newest last, bounded by CANVAS_ACTIVITY_LIMIT.
  activity: CanvasActivity[]
}

export type ConversationExpansionPreferences = {
  toolCall: boolean
  diff: boolean
  html: boolean
  thinking: boolean
  read: boolean
}

export const DEFAULT_CONVERSATION_EXPANSION: ConversationExpansionPreferences = {
  toolCall: true,
  diff: true,
  html: true,
  thinking: true,
  read: false
}

export type AgentDefaults = {
  provider: string
  model: string
  mode: string | null
}

export type AppSettings = {
  // Last provider/model/mode chosen for a spawn; null until the first spawn.
  agentDefaults: AgentDefaults | null
  conversationExpansion: ConversationExpansionPreferences
  // Null means the default local daemon URL.
  paseoUrl: string | null
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  agentDefaults: null,
  conversationExpansion: DEFAULT_CONVERSATION_EXPANSION,
  paseoUrl: null
}

export function createEmptyCanvas(projectId: string): Canvas {
  return {
    version: DOMAIN_RECORD_VERSION,
    projectId,
    nodes: [],
    edges: [],
    workspaces: [],
    viewport: null,
    activity: []
  }
}
