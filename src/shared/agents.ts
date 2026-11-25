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

// Paseo's provider discovery state; `loading` until the daemon has probed the provider for a cwd.
export type AgentProviderStatus = 'ready' | 'loading' | 'error' | 'unavailable'

export type AgentProviderInfo = {
  id: string
  label: string
  // True only when the provider is enabled and `ready`.
  available: boolean
  status: AgentProviderStatus
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
  // Bounded (AGENT_PERMISSION_DETAIL_LIMIT), display-only rendering of what is being approved.
  detail: string | null
}

export const AGENT_PERMISSION_DETAIL_LIMIT = 4_000

export type PermissionBehavior = 'allow' | 'deny'

// A provider-native sub-agent: listed inside its parent agent node, not placed on the canvas by default.
export type ProviderSubagentInfo = {
  id: string
  parentSubagentId: string | null
  // The sub-agent's type or name as the provider reports it.
  title: string | null
  // The task the parent delegated.
  description: string | null
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
  // For a provider-native sub-agent opened as a node: the provider's sub-agent id.
  agentId: string
  resourceState: AgentResourceState
  // Paseo's durable parent identity; for a provider-native sub-agent, the agent that launched it.
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
    | {
        kind: 'user-message'
        text: string
        images: ConversationImage[]
        // The agent that sent this input (a parent's prompt, a child's finish notice); null for the user.
        sender: { agentId: string; title: string | null } | null
      }
    | { kind: 'assistant-message'; text: string; images: ConversationImage[] }
    | { kind: 'thinking'; text: string }
    | {
        kind: 'tool-call'
        // The provider's call id; a provider-native sub-agent launched by this call may share it.
        callId: string
        toolKind: ToolCallKind
        name: string
        status: ToolCallStatus
        // One line: the command, path, query, or URL.
        summary: string
        // Bounded text of input and output; never a full unbounded payload.
        input: string | null
        output: string | null
        // Bounded failure text when the call failed.
        error: string | null
        // Unified diff text for edits: the provider's own, or derived from the replaced and new text,
        // in which case hunk line numbers count from the start of the replaced snippet.
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
// Inline (data: URL) images larger than this are omitted with a visible marker in the item's output.
export const CONVERSATION_IMAGE_DATA_LIMIT = 2_000_000

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
