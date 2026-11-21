import type {
  AgentProviderInfo,
  AgentRuntime,
  AgentTimelinePage,
  AgentTimelineQuery,
  PaseoConnection,
  PermissionBehavior
} from '../shared/agents'
import type { ImageSource } from '../shared/builtinEntities'
import type { CanvasCommand, CanvasCommandOutcome } from '../shared/commands'
import type { Actor, AppSettings, Canvas, CanvasNode, Project, ResourceRef, Size } from '../shared/domain'
import type { ImageInfo, PathInfo } from '../shared/ipc'

// Seams between the main-process services. Each service depends on these interfaces, never on
// another service's implementation; `src/main/index.ts` is the only place they are wired together.

export type EntityCreateInput = {
  // The id the new node will have.
  nodeId: string
  config: unknown
  project: Project
  // The node the new one is spawned from, when there is one.
  sourceNode: CanvasNode | null
  actor: Actor
  title?: string
}

export type EntityCreateResult = {
  resourceRef: ResourceRef | null
  // Each of these overrides the seed's value only when the seed left it unset.
  title?: string
  shortDescription?: string
  size?: Size
  workspaceId?: string | null
  // Replaces the seed's config, for adapters that normalize it.
  config?: unknown
}

// Main-process half of an entity: creates the resource a new node points at.
// Entity types without an adapter create nodes with a null resourceRef.
export type MainEntityAdapter = {
  type: string
  create(input: EntityCreateInput): Promise<EntityCreateResult>
}

export type WorkspaceGatewayEvent =
  | { type: 'canvas-changed'; canvas: Canvas; command: CanvasCommand; actor: Actor }
  | { type: 'projects-changed' }
  | { type: 'settings-changed' }

// The single serialized owner of SPADE's records. Every change to a canvas goes through `execute`,
// whoever asks: the renderer, the agent CLI, or reconciliation.
export interface WorkspaceGateway {
  listProjects(): Project[]
  getProject(projectId: string): Project | null
  getSettings(): AppSettings
  updateSettings(patch: Partial<AppSettings>): Promise<void>
  getCanvas(projectId: string): Promise<Canvas>
  // Runs the entity adapter for creation commands without a resourceRef, applies the pure reducer,
  // persists, then publishes. Rejects with CanvasCommandError.
  execute(projectId: string, command: CanvasCommand, actor: Actor): Promise<CanvasCommandOutcome>
  // Looks across every project's canvas.
  findNodeByResource(ref: ResourceRef): Promise<{ projectId: string; node: CanvasNode } | null>
  findNode(nodeId: string): Promise<{ projectId: string; node: CanvasNode } | null>
  registerEntityAdapter(adapter: MainEntityAdapter): void
  subscribe(listener: (event: WorkspaceGatewayEvent) => void): () => void
}

export type AgentServiceEvent =
  | { type: 'connection'; connection: PaseoConnection }
  | { type: 'runtime'; runtime: AgentRuntime }
  | { type: 'timeline'; nodeId: string }

// Owns every interaction with Paseo and keeps agent nodes reconciled with it.
export interface AgentService {
  readonly entityAdapter: MainEntityAdapter
  start(): Promise<void>
  stop(): Promise<void>
  connection(): PaseoConnection
  listProviders(): Promise<AgentProviderInfo[]>
  runtimes(projectId: string): AgentRuntime[]
  timeline(nodeId: string, query?: AgentTimelineQuery): Promise<AgentTimelinePage>
  prompt(nodeId: string, input: { text: string; contextNodeIds?: string[] }, actor: Actor): Promise<void>
  interrupt(nodeId: string): Promise<void>
  respondToPermission(nodeId: string, requestId: string, behavior: PermissionBehavior): Promise<void>
  openProviderSubagent(nodeId: string, subagentId: string, actor: Actor): Promise<{ nodeId: string }>
  subscribe(listener: (event: AgentServiceEvent) => void): () => void
}

// Read-only access to the filesystem and the Windows shell on behalf of the renderer.
// Nothing here writes into a project directory.
export interface FileService {
  readonly imageEntityAdapter: MainEntityAdapter
  readonly webPageEntityAdapter: MainEntityAdapter
  // Registers the read-only image protocol and guest-webview policy. Call once, before any window opens.
  start(): Promise<void>
  stop(): Promise<void>
  inspectPath(project: Project, path: string): Promise<PathInfo>
  reveal(project: Project, path: string): Promise<void>
  openExternal(url: string): Promise<void>
  copyText(text: string): void
  pickImage(project: Project): Promise<string | null>
  describeImage(project: Project, source: ImageSource): Promise<ImageInfo>
  importImage(input: { data: ArrayBuffer; mimeType: string }): Promise<{ assetId: string }>
  subscribe(listener: (event: { type: 'image-changed'; path: string }) => void): () => void
}
