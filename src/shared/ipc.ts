import type {
  AgentProviderInfo,
  AgentRuntime,
  AgentTimelinePage,
  AgentTimelineQuery,
  PaseoConnection,
  PermissionBehavior
} from './agents'
import type { ImageSource } from './builtinEntities'
import type { CanvasCommand, CanvasCommandResponse } from './commands'
import type { AppSettings, Canvas, Project } from './domain'

// The typed surface the sandboxed preload exposes to the renderer as `window.spadeHost`.
// The renderer has no filesystem, shell, or Paseo access of its own; everything goes through here.
// (`window.spade` is reserved for the bridge injected into agent-authored HTML, plan §11.)
export const SPADE_HOST_GLOBAL = 'spadeHost'

// Something SPADE could not load safely and worked around; shown to the user until the app restarts.
export type AppProblem = {
  // A persistence error code, e.g. "corrupt-data" or "unsupported-version".
  code: string
  message: string
  // The project whose canvas is affected; null for app-wide records.
  projectId: string | null
}

export type AppState = {
  projects: Project[]
  selectedProjectId: string | null
  settings: AppSettings
  paseo: PaseoConnection
  appVersion: string
  problems: AppProblem[]
}

export type Failure = { ok: false; error: { code: string; message: string } }
export type Result<Value extends object = object> = ({ ok: true } & Value) | Failure

// 'unchecked': a network (UNC) path outside the project root. SPADE never contacts another machine
// because of text in a conversation; such a path is only touched after an explicit user action.
export type PathKind = 'file' | 'directory' | 'missing' | 'unchecked'

// `explicit` marks a call made because the user clicked on this very path. Only explicit calls may touch
// a network path outside the project root; the main process then keeps allowing that path for the session.
export type PathAccessOptions = { explicit?: boolean }

export type PathInfo = {
  // The path as written in the conversation.
  input: string
  // Resolved against the project root when `input` is relative; without any :line suffix.
  absolutePath: string
  kind: PathKind
  isImage: boolean
  line: number | null
}

export type ImageInfo = {
  // URL the renderer can put in <img src>; served read-only by the main process.
  url: string
  width: number | null
  height: number | null
  // Changes when the file changes on disk.
  revision: string
}

export type OpenProjectResponse = Result<{ project: Project }> | { ok: true; cancelled: true }

export type SpadeHostBridge = {
  app: {
    getState(): Promise<AppState>
    onState(listener: (state: AppState) => void): () => void
    updateSettings(patch: Partial<AppSettings>): Promise<Result>
  }
  projects: {
    // Opens the native folder picker, creates the project and its empty canvas, and selects it.
    open(): Promise<OpenProjectResponse>
    select(projectId: string): Promise<Result>
    rename(projectId: string, name: string): Promise<Result>
    // Opens the native folder picker to choose a new root for an existing project.
    changeRoot(projectId: string): Promise<OpenProjectResponse>
    // Removes only the SPADE project record and its canvas, never the directory.
    remove(projectId: string): Promise<Result>
  }
  canvas: {
    get(projectId: string): Promise<Canvas>
    // Fires after every applied command, whoever issued it.
    onChanged(listener: (canvas: Canvas) => void): () => void
    execute(projectId: string, command: CanvasCommand): Promise<CanvasCommandResponse>
  }
  agents: {
    listProviders(): Promise<Result<{ providers: AgentProviderInfo[] }>>
    getRuntimes(projectId: string): Promise<AgentRuntime[]>
    onRuntime(listener: (runtime: AgentRuntime) => void): () => void
    getTimeline(nodeId: string, query?: AgentTimelineQuery): Promise<Result<{ page: AgentTimelinePage }>>
    // Fires when a node's timeline has new or changed items; the listener re-reads the newest page.
    onTimelineChanged(listener: (event: { nodeId: string }) => void): () => void
    prompt(nodeId: string, input: { text: string; contextNodeIds?: string[] }): Promise<Result>
    interrupt(nodeId: string): Promise<Result>
    respondToPermission(nodeId: string, requestId: string, behavior: PermissionBehavior): Promise<Result>
    // Opens a provider-native sub-agent as a delegated child node of its parent agent node.
    openProviderSubagent(nodeId: string, subagentId: string): Promise<Result<{ nodeId: string }>>
  }
  files: {
    // Lazy existence check for a path found in a conversation. Never throws for a missing path.
    inspectPath(projectId: string, path: string, options?: PathAccessOptions): Promise<PathInfo>
    // Files are selected in Explorer (never launched); directories are opened in Explorer.
    reveal(projectId: string, path: string): Promise<Result>
    // http and https only.
    openExternal(url: string): Promise<Result>
    copyText(text: string): Promise<Result>
    // Native file picker limited to supported image formats; null when cancelled.
    pickImage(projectId: string): Promise<string | null>
    // Fails with code `network-path` for an unapproved network path outside the project root.
    describeImage(
      projectId: string,
      source: ImageSource,
      options?: PathAccessOptions
    ): Promise<Result<{ image: ImageInfo }>>
    // Stores a pasted or tool-produced image in SPADE's asset store.
    importImage(input: { data: ArrayBuffer; mimeType: string }): Promise<Result<{ assetId: string }>>
    // Fires when a watched image file changes; the listener calls describeImage again.
    onImageChanged(listener: (event: { path: string }) => void): () => void
  }
}

export const IPC_CHANNEL_PREFIX = 'spade:'

// "namespace.method" for every request method of the bridge, e.g. "canvas.execute".
export type SpadeHostMethod = {
  [Namespace in keyof SpadeHostBridge]: Exclude<
    `${Namespace}.${keyof SpadeHostBridge[Namespace] & string}`,
    `${string}.on${string}`
  >
}[keyof SpadeHostBridge]

export function spadeHostChannel(method: SpadeHostMethod): string {
  return `${IPC_CHANNEL_PREFIX}${method}`
}

// Main-to-renderer pushes, one channel per bridge `on…` listener.
export const SPADE_HOST_EVENTS = {
  appState: `${IPC_CHANNEL_PREFIX}event:app-state`,
  canvasChanged: `${IPC_CHANNEL_PREFIX}event:canvas-changed`,
  agentRuntime: `${IPC_CHANNEL_PREFIX}event:agent-runtime`,
  agentTimelineChanged: `${IPC_CHANNEL_PREFIX}event:agent-timeline-changed`,
  imageChanged: `${IPC_CHANNEL_PREFIX}event:image-changed`
} as const

// Bridge methods whose result has no failure shape cross IPC wrapped in this envelope; the preload
// unwraps it and rejects with an Error carrying the code and message on failure.
export type EnvelopedMethod = Extract<
  SpadeHostMethod,
  'app.getState' | 'canvas.get' | 'agents.getRuntimes' | 'files.inspectPath' | 'files.pickImage'
>

export type IpcEnvelope<Value> = { ok: true; value: Value } | Failure
