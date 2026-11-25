import type { AgentRuntime } from '@shared/agents'
import type { Canvas } from '@shared/domain'

// Node menu actions are built outside React, so they read the latest runtime and the notice sink from
// here. AgentStatus keeps an entry for every agent node on the canvas, collapsed or not.
export type AgentNodeHandle = {
  runtime: AgentRuntime | null
  notify(message: string): void
  getCanvas(): Canvas
}

export const agentNodeHandles = new Map<string, AgentNodeHandle>()
