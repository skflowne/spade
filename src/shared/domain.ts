export const DOMAIN_RECORD_VERSION = 1 as const

export type DomainRecordVersion = typeof DOMAIN_RECORD_VERSION

export type ResourceRef = {
  provider: string
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

export type WorkspaceRole = 'integrator' | 'review' | 'fix' | 'exploration' | (string & {})

export type Workspace = {
  version: DomainRecordVersion
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
  role?: WorkspaceRole
  createdAt: string
}

export type Project = {
  version: DomainRecordVersion
  id: string
  paseoProjectId?: string
  projectKey?: string
  rootPath?: string
  gitRemote?: string
  name: string
  canvasId: string
}

export type WorkItemKind = 'github_issue' | 'task' | 'investigation' | 'ad_hoc'
export type WorkItemStatus = 'active' | 'blocked' | 'review' | 'done' | 'archived'

export type WorkItem = {
  version: DomainRecordVersion
  id: string
  projectId: string
  title: string
  kind: WorkItemKind
  sourceUrl?: string
  sourceIdentifier?: string
  status: WorkItemStatus
  rootNodeId?: string
  createdAt: string
}

export type CanvasEdgeRelation = 'spawned' | 'delegated' | 'references' | 'derived'

export type CanvasEdge = {
  version: DomainRecordVersion
  id: string
  fromNodeId: string
  toNodeId: string
  relation: CanvasEdgeRelation
  label?: string
  createdAt: string
}
