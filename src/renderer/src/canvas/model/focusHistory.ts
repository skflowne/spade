// Back/forward history of explicit focus moves (plan §12). Entries are node ids; `index` is the current one.
export type FocusHistory = { entries: readonly string[]; index: number }

export const EMPTY_FOCUS_HISTORY: FocusHistory = { entries: [], index: -1 }
export const FOCUS_HISTORY_LIMIT = 100

export function currentFocus(history: FocusHistory): string | null {
  return history.entries[history.index] ?? null
}

// Focusing the current node again is not a new entry. A new entry drops everything forward of the current one.
export function pushFocus(history: FocusHistory, nodeId: string): FocusHistory {
  if (currentFocus(history) === nodeId) return history
  const entries = [...history.entries.slice(0, history.index + 1), nodeId].slice(-FOCUS_HISTORY_LIMIT)
  return { entries, index: entries.length - 1 }
}

// The nearest entry in the direction whose node can still be focused; null when there is none.
export function stepFocus(
  history: FocusHistory,
  step: -1 | 1,
  isAvailable: (nodeId: string) => boolean
): FocusHistory | null {
  const current = currentFocus(history)
  for (let index = history.index + step; index >= 0 && index < history.entries.length; index += step) {
    const nodeId = history.entries[index]
    if (nodeId !== current && isAvailable(nodeId)) return { entries: history.entries, index }
  }
  return null
}
