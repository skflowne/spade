export const CORE_RECORD_VERSIONS = {
  canvasNode: 1,
  canvasEdge: 1,
  project: 1,
  workItem: 1,
  workspace: 1
} as const

export type ResourceRef = {
  provider: 'paseo' | 'filesystem' | 'electron' | 'gade' | (string & {})
  kind: string
  id: string
  revision?: string
}

export type CanvasNode = {
  version: typeof CORE_RECORD_VERSIONS.canvasNode
  id: string
  entityType: string
  entityVersion: number
  title: string
  shortDescription?: string
  position: { x: number; y: number }
  size?: { width: number; height: number }
  collapsed: boolean
  projectId: string
  workItemId: string | null
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

export type CanvasEdge = {
  version: typeof CORE_RECORD_VERSIONS.canvasEdge
  id: string
  fromNodeId: string
  toNodeId: string
  relation: 'spawned' | 'delegated' | 'references' | 'derived'
  label?: string
  createdAt: string
}

export type Project = {
  version: typeof CORE_RECORD_VERSIONS.project
  id: string
  paseoProjectId?: string
  projectKey?: string
  rootPath?: string
  gitRemote?: string
  name: string
  canvasId: string
}

export type WorkItem = {
  version: typeof CORE_RECORD_VERSIONS.workItem
  id: string
  projectId: string
  title: string
  kind: 'github_issue' | 'task' | 'investigation' | 'ad_hoc'
  sourceUrl?: string
  sourceIdentifier?: string
  status: 'active' | 'blocked' | 'review' | 'done' | 'archived'
  rootNodeId?: string
  createdAt: string
}

export type Workspace = {
  version: typeof CORE_RECORD_VERSIONS.workspace
  id: string
  paseoWorkspaceId?: string
  projectId: string
  workItemId: string | null
  cwd: string
  worktreeRoot?: string | null
  mainRepoRoot?: string | null
  baseRef?: string | null
  baseRevision?: string | null
  branch?: string | null
  name: string
  role?: string
  createdAt: string
}
