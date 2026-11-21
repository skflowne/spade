import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentResourceState } from '@shared/agents'
import { mergeNewestPage, mergeOlderPage, type TimelineState } from './timeline'

export type Timeline = {
  // Null until the first page arrives.
  state: TimelineState | null
  // The last read failure; cleared by the next successful read.
  error: string | null
  loadingOlder: boolean
  loadOlder(): Promise<void>
  reload(): void
}

// The mounted node's conversation: the newest page on mount and on every change event for the node,
// older pages on request. Only this node's pages are held, and only while it is mounted.
export function useTimeline(nodeId: string, resourceState: AgentResourceState | null, limit?: number): Timeline {
  const [state, setState] = useState<TimelineState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const latest = useRef<TimelineState | null>(null)
  latest.current = state
  // Change events arrive in bursts: one read in flight, at most one more queued.
  const reading = useRef<{ inFlight: boolean; again: boolean; mounted: boolean }>({ inFlight: false, again: false, mounted: true })

  const readNewest = useCallback(async (): Promise<void> => {
    const flags = reading.current
    if (flags.inFlight) {
      flags.again = true
      return
    }
    flags.inFlight = true
    try {
      do {
        flags.again = false
        const result = await window.spadeHost.agents
          .getTimeline(nodeId, limit === undefined ? undefined : { limit })
          .catch((reason: unknown) => ({ ok: false as const, error: { code: 'failed', message: String(reason) } }))
        if (!flags.mounted) return
        if (result.ok) {
          const next = mergeNewestPage(latest.current, result.page)
          latest.current = next
          setState(next)
          setError(null)
        } else {
          setError(result.error.message)
        }
      } while (flags.again)
    } finally {
      flags.inFlight = false
    }
  }, [nodeId, limit])

  useEffect(() => {
    const flags = reading.current
    flags.mounted = true
    void readNewest()
    const stop = window.spadeHost.agents.onTimelineChanged((event) => {
      if (event.nodeId === nodeId) void readNewest()
    })
    return () => {
      flags.mounted = false
      stop()
    }
  }, [nodeId, readNewest])

  // Reconnecting to Paseo may have changed the conversation while no events could arrive.
  const previousState = useRef(resourceState)
  useEffect(() => {
    if (resourceState === 'live' && previousState.current !== 'live' && previousState.current !== null) void readNewest()
    previousState.current = resourceState
  }, [resourceState, readNewest])

  const loadOlder = useCallback(async (): Promise<void> => {
    const current = latest.current
    if (!current?.olderCursor || loadingOlder) return
    setLoadingOlder(true)
    const result = await window.spadeHost.agents
      .getTimeline(nodeId, { before: current.olderCursor })
      .catch((reason: unknown) => ({ ok: false as const, error: { code: 'failed', message: String(reason) } }))
    setLoadingOlder(false)
    if (!reading.current.mounted) return
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    const next = mergeOlderPage(latest.current ?? current, result.page)
    if (next === null) {
      void readNewest()
      return
    }
    latest.current = next
    setState(next)
    setError(null)
  }, [nodeId, loadingOlder, readNewest])

  return { state, error, loadingOlder, loadOlder, reload: () => void readNewest() }
}
