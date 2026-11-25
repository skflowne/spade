import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentResourceState } from '@shared/agents'
import { conversationState, noteTimelineChanged } from './conversationState'
import { mergeNewestPage, mergeOlderPage, type TimelineState } from './timeline'

export type Timeline = {
  // Null until the first page arrives.
  state: TimelineState | null
  // The last read failure; cleared by the next successful read.
  error: string | null
  loadingOlder: boolean
  // 'prepended' once older items are in the state; 'unchanged' when the request failed, or when the page
  // belonged to another epoch and the newest page is read again instead.
  loadOlder(): Promise<'prepended' | 'unchanged'>
  reload(): void
}

let trackingChanges = false

// Change events for nodes whose conversation is not mounted mark what is remembered for them as stale.
function trackTimelineChanges(): void {
  if (trackingChanges) return
  trackingChanges = true
  window.spadeHost.agents.onTimelineChanged((event) => noteTimelineChanged(event.nodeId))
}

// The node's conversation: the remembered pages at once, the newest page on mount when they may be behind
// and on every change event for the node, older pages on request. Pages live in the node's remembered state
// (conversationState.ts), so remounting after a zoom or a collapse reads nothing it already has.
export function useTimeline(nodeId: string, resourceState: AgentResourceState | null, limit?: number): Timeline {
  const remembered = conversationState(nodeId)
  const [state, setState] = useState<TimelineState | null>(remembered.timeline)
  const [error, setError] = useState<string | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const latest = useRef<TimelineState | null>(state)
  // Change events arrive in bursts: one read in flight, at most one more queued.
  const reading = useRef<{ inFlight: boolean; again: boolean; mounted: boolean }>({ inFlight: false, again: false, mounted: true })

  const commit = useCallback(
    (next: TimelineState): void => {
      latest.current = next
      conversationState(nodeId).setTimeline(next)
      setState(next)
      setError(null)
    },
    [nodeId]
  )

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
        if (result.ok) commit(mergeNewestPage(latest.current, result.page))
        else setError(result.error.message)
      } while (flags.again)
    } finally {
      flags.inFlight = false
    }
  }, [nodeId, limit, commit])

  useEffect(() => {
    trackTimelineChanges()
    const flags = reading.current
    flags.mounted = true
    if (conversationState(nodeId).stale) void readNewest()
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

  const loadOlder = useCallback(async (): Promise<'prepended' | 'unchanged'> => {
    const current = latest.current
    if (!current?.olderCursor || loadingOlder) return 'unchanged'
    setLoadingOlder(true)
    const result = await window.spadeHost.agents
      .getTimeline(nodeId, { before: current.olderCursor })
      .catch((reason: unknown) => ({ ok: false as const, error: { code: 'failed', message: String(reason) } }))
    setLoadingOlder(false)
    if (!reading.current.mounted) return 'unchanged'
    if (!result.ok) {
      setError(result.error.message)
      return 'unchanged'
    }
    const next = mergeOlderPage(latest.current ?? current, result.page)
    if (next === null) {
      void readNewest()
      return 'unchanged'
    }
    commit(next)
    return 'prepended'
  }, [nodeId, loadingOlder, readNewest, commit])

  return { state, error, loadingOlder, loadOlder, reload: () => void readNewest() }
}
