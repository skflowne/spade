import type { ChildOrigin, Point, ResourceRef, Size, SourceArtifact, Viewport } from './domain'

// What a creation command knows about the node it creates.
export type NodeSeed = {
  entityType: string
  config: unknown
  title?: string
  shortDescription?: string
  // Absent: the placement function chooses the position (plan §8).
  position?: Point
  // Absent: the entity definition's default size.
  size?: Size
  collapsed?: boolean
  workspaceId?: string | null
  // Present: the resource already exists and the main-process entity adapter is not asked to create it.
  resourceRef?: ResourceRef | null
  // With a resourceRef: when a node with the same provider+kind+id already exists on the canvas,
  // the command succeeds without creating anything and returns that node's id.
  ifResourceAbsent?: boolean
}

// Where a spawned node attaches (plan §4.6).
export type SpawnTarget =
  // Child of the named node. "Child of the source" names the source itself.
  | { kind: 'child'; parentNodeId: string }
  // Child of the root of the tree that contains the named node.
  | { kind: 'tree'; nodeId: string }
  | { kind: 'new-tree' }

export type CanvasCommand =
  // `target` defaults to a child of `sourceNodeId`.
  | {
      type: 'spawnChild'
      sourceNodeId: string
      node: NodeSeed
      target?: SpawnTarget
      origin: ChildOrigin
      sourceArtifact?: SourceArtifact
    }
  | { type: 'startTree'; node: NodeSeed }
  // Adds a "references" edge. Never changes tree structure.
  | { type: 'connectNodes'; fromNodeId: string; toNodeId: string; label?: string }
  | { type: 'disconnectNodes'; edgeId: string }
  | { type: 'moveNodes'; moves: Array<{ nodeId: string; position: Point }> }
  | { type: 'resizeNode'; nodeId: string; size: Size }
  // Moves the whole branch under a new parent; null makes the node a root. Rejects cycles.
  | { type: 'reparent'; nodeId: string; newParentId: string | null }
  | { type: 'setNodeWorkspace'; nodeId: string; workspaceId: string | null }
  | {
      type: 'updateNode'
      nodeId: string
      patch: {
        title?: string
        shortDescription?: string | null
        config?: unknown
        cachedPresentation?: { revision?: string; summary?: string } | null
      }
    }
  | { type: 'collapseNode'; nodeId: string }
  | { type: 'expandNode'; nodeId: string }
  | { type: 'collapseBranch'; nodeId: string }
  | { type: 'expandBranch'; nodeId: string }
  | { type: 'archiveNode'; nodeId: string }
  | { type: 'archiveBranch'; nodeId: string }
  // Clears `archived` on the node; with `branch`, on every descendant too.
  | { type: 'restoreNode'; nodeId: string; branch?: boolean }
  // Children are promoted to the removed node's parent, or become roots.
  | { type: 'removeNode'; nodeId: string }
  | { type: 'removeBranch'; nodeId: string }
  | {
      type: 'upsertWorkspace'
      workspace: { id: string; cwd: string; name: string; paseoWorkspaceId?: string }
    }
  | { type: 'setViewport'; viewport: Viewport }

export type CanvasCommandType = CanvasCommand['type']

export type CanvasCommandErrorCode =
  | 'unknown-node'
  | 'unknown-edge'
  | 'unknown-entity-type'
  | 'unknown-project'
  | 'unknown-workspace'
  | 'invalid-config'
  | 'invalid-command'
  | 'cycle'
  | 'entity-create-failed'
  // The project's stored canvas cannot be read safely (for example, a newer SPADE wrote it).
  | 'canvas-unavailable'

export class CanvasCommandError extends Error {
  constructor(
    readonly code: CanvasCommandErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'CanvasCommandError'
  }
}

// What a successful command reports besides the new canvas.
export type CanvasCommandOutcome = {
  // The created node, or the existing node matched by `ifResourceAbsent`.
  nodeId?: string
  edgeId?: string
  // False when `ifResourceAbsent` matched an existing node.
  created?: boolean
  // Every node record removed by removeNode / removeBranch.
  removedNodeIds?: string[]
}

// The serializable form that crosses process boundaries (IPC and the agent CLI).
export type CanvasCommandResponse =
  | ({ ok: true } & CanvasCommandOutcome)
  | { ok: false; error: { code: CanvasCommandErrorCode | 'internal'; message: string } }
