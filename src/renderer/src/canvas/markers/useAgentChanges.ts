import { useEffect, useState } from 'react'
import type { Canvas } from '@shared/domain'
import type { AgentChangeSource } from '../CanvasContext'
import { recentAgentChanges, type AgentChange, type AgentDirectory } from '../model/activityView'

// Keeps the recent agent changes of a canvas current: on every canvas push, when what is known of collapsed
// agents changes, and when the oldest marker expires.
export function useAgentChanges(canvas: Canvas, agents: AgentDirectory): AgentChangeSource {
  const [source] = useState(createSource)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = (): void => {
      const { changes, expiresAt } = recentAgentChanges(canvas, Date.now(), agents)
      source.replace(changes)
      if (expiresAt !== null) timer = setTimeout(refresh, Math.max(0, expiresAt - Date.now()) + 50)
    }
    refresh()
    return () => clearTimeout(timer)
  }, [canvas, agents, source])
  return source
}

function createSource(): AgentChangeSource & { replace(next: Map<string, AgentChange>): void } {
  let changes = new Map<string, AgentChange>()
  const listeners = new Set<() => void>()
  const same = (a: AgentChange | undefined, b: AgentChange): boolean =>
    a !== undefined &&
    a.at === b.at &&
    a.agentId === b.agentId &&
    a.agentNodeId === b.agentNodeId &&
    a.agentLabel === b.agentLabel &&
    a.summary === b.summary
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    get: (nodeId) => changes.get(nodeId),
    // Unchanged entries keep their identity, so only the nodes whose marker changed re-render.
    replace(next) {
      const merged = new Map<string, AgentChange>()
      for (const [nodeId, change] of next) {
        const previous = changes.get(nodeId)
        merged.set(nodeId, same(previous, change) ? previous! : change)
      }
      const changed = merged.size !== changes.size || [...merged].some(([nodeId, change]) => changes.get(nodeId) !== change)
      changes = merged
      if (changed) for (const listener of listeners) listener()
    }
  }
}
