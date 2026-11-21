// Normalized agent state shared by the main process, the renderer, and the agent CLI.
// Paseo is authoritative; nothing here is persisted except what a canvas node caches.

export type PaseoConnectionState = 'connected' | 'connecting' | 'reconnecting' | 'disconnected' | 'disabled'

export type PaseoConnection = {
  state: PaseoConnectionState
  url: string
  error: string | null
}

export type AgentModeInfo = { id: string; label: string; description?: string }
export type AgentModelInfo = { id: string; label: string; isDefault?: boolean }

export type AgentProviderInfo = {
  id: string
  label: string
  available: boolean
  error: string | null
  models: AgentModelInfo[]
  modes: AgentModeInfo[]
  defaultModeId: string | null
}

// Paseo's lifecycle status is passed through as a string; `activity` is SPADE's coarse reading of it.
export type AgentActivity = 'starting' | 'running' | 'idle' | 'attention' | 'error' | 'closed' | 'unknown'

export type AgentPermissionRequest = {
  id: string
  kind: string
  name: string
  title: string | null
  description: string | null
  // Bounded, display-only rendering of the request input.
  detail: string | null
}

export type PermissionBehavior = 'allow' | 'deny'

// A provider-native sub-agent: listed inside its parent agent node, not placed on the canvas by default.
export type ProviderSubagentInfo = {
  id: string
  parentSubagentId: string | null
  title: string | null
  status: string
  updatedAt: string
}

export type AgentResourceState =
  // Read from Paseo since the last (re)connection.
  | 'live'
  // Last known values; the daemon is unreachable or the read failed.
  | 'stale'
  // Paseo no longer has this agent.
  | 'missing'

export type AgentRuntime = {
  projectId: string
  nodeId: string
  agentId: string
  resourceState: AgentResourceState
  // Null when the agent is a provider-native sub-agent opened as a node.
  parentAgentId: string | null
  provider: string
  model: string | null
  mode: string | null
  title: string | null
  status: string
  activity: AgentActivity
  cwd: string | null
  pendingPermissions: AgentPermissionRequest[]
  providerSubagents: ProviderSubagentInfo[]
  lastError: string | null
  updatedAt: string
}

export type ToolCallKind = 'read' | 'edit' | 'shell' | 'search' | 'fetch' | 'subagent' | 'other'
export type ToolCallStatus = 'running' | 'completed' | 'failed' | 'canceled'

export type ConversationImage = {
  // A data: URL or an absolute file path.
  source: string
  mimeType: string | null
}

type ConversationItemBase = {
  // Stable across re-reads within one timeline epoch.
  id: string
  timestamp: string
}

export type ConversationItem = ConversationItemBase &
  (
    | { kind: 'user-message'; text: string; images: ConversationImage[] }
    | { kind: 'assistant-message'; text: string; images: ConversationImage[] }
    | { kind: 'thinking'; text: string }
    | {
        kind: 'tool-call'
        toolKind: ToolCallKind
        name: string
        status: ToolCallStatus
        // One line: the command, path, query, or URL.
        summary: string
        // Bounded text of input and output; never a full unbounded payload.
        input: string | null
        output: string | null
        // Unified diff text for edits, when the provider reports one.
        diff: string | null
        // File the call read or edited, when known.
        path: string | null
        images: ConversationImage[]
      }
    | { kind: 'todo'; items: Array<{ text: string; done: boolean }> }
    | { kind: 'error'; message: string }
    | { kind: 'notice'; text: string }
  )

export type ConversationItemKind = ConversationItem['kind']

export const AGENT_TIMELINE_PAGE_LIMIT = 60
// Per text field of a conversation item (message text is exempt up to MESSAGE_TEXT_LIMIT).
export const CONVERSATION_FIELD_LIMIT = 20_000
export const CONVERSATION_MESSAGE_TEXT_LIMIT = 200_000

export type AgentTimelineQuery = {
  // Absent: the newest page. Otherwise the `olderCursor` of a previous page.
  before?: string
  limit?: number
}

export type AgentTimelinePage = {
  nodeId: string
  // Changes when the daemon restarts or rewrites history; cursors and item ids from another epoch are void.
  epoch: string | null
  // Oldest first.
  items: ConversationItem[]
  // Null when there is nothing older.
  olderCursor: string | null
}

// Bounded reference to a canvas node handed to an agent as context (plan §9).
export type AgentContextReference = {
  node_type: string
  node_id: string
  node_name: string
  short_description?: string
  relation: 'parent' | 'child' | 'references' | 'selected'
  workspace?: { id: string; cwd: string }
  locator?: { kind: string; value: string }
  revision?: string
  excerpt?: string
}

export const AGENT_CONTEXT_EXCERPT_LIMIT = 1_200
export const AGENT_CONTEXT_REFERENCE_LIMIT = 12
