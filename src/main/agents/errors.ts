export type AgentServiceErrorCode =
  | 'unknown-node'
  | 'not-an-agent'
  // The node mirrors a provider-native sub-agent, which Paseo cannot prompt, interrupt, or ask for permissions.
  | 'unsupported-agent-action'
  | 'agent-missing'
  // Paseo does not know the agent, or it is not one SPADE follows (shown on a canvas or owned by one that is).
  | 'unknown-agent'
  | 'unknown-subagent'
  | 'invalid-argument'
  | 'paseo-unavailable'
  | 'paseo-failed'

// Failures of agent operations. The code is stable and safe to show; the host bridge forwards the message.
export class AgentServiceError extends Error {
  constructor(
    readonly code: AgentServiceErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'AgentServiceError'
  }
}
