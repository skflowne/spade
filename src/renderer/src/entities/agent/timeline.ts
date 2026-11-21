import type { AgentTimelinePage, ConversationItem } from '../../../../shared/agents'

// The loaded part of one conversation: the newest page plus any older pages the user asked for.
export type TimelineState = {
  epoch: string | null
  // Oldest first.
  items: ConversationItem[]
  // Cursor for the page before `items[0]`; null when nothing older exists.
  olderCursor: string | null
}

type Page = Pick<AgentTimelinePage, 'epoch' | 'items' | 'olderCursor'>

// The newest page is authoritative for its window. Items before the window stay; ids and cursors from
// another epoch are void, so a new epoch replaces everything.
export function mergeNewestPage(state: TimelineState | null, page: Page): TimelineState {
  const fresh: TimelineState = { epoch: page.epoch, items: page.items, olderCursor: page.olderCursor }
  if (state === null || state.epoch !== page.epoch) return fresh
  const first = page.items[0]
  if (first === undefined) return state.items.length === 0 ? fresh : state
  const start = state.items.findIndex((item) => item.id === first.id)
  if (start === -1) return reuse(state, fresh)
  const prefix = state.items.slice(0, start)
  return reuse(state, {
    epoch: page.epoch,
    items: [...prefix, ...page.items],
    olderCursor: prefix.length > 0 ? state.olderCursor : page.olderCursor
  })
}

// Null when the page belongs to another epoch: the caller reloads the newest page instead.
export function mergeOlderPage(state: TimelineState, page: Page): TimelineState | null {
  if (state.epoch !== page.epoch) return null
  const known = new Set(state.items.map((item) => item.id))
  return {
    epoch: state.epoch,
    items: [...page.items.filter((item) => !known.has(item.id)), ...state.items],
    olderCursor: page.olderCursor
  }
}

// Keeps the previous object for every unchanged item so memoized item views skip re-rendering.
function reuse(previous: TimelineState, next: TimelineState): TimelineState {
  const byId = new Map(previous.items.map((item) => [item.id, item]))
  return {
    ...next,
    items: next.items.map((item) => {
      const old = byId.get(item.id)
      return old !== undefined && sameItem(old, item) ? old : item
    })
  }
}

function sameItem(a: ConversationItem, b: ConversationItem): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}
