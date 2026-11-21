// Bounds how many web page guests (<webview>) a canvas keeps live at once (plan §12, performance strategy).
// Pure bookkeeping: the caller mounts exactly the guests in `live` and unmounts the evicted ones.

export const LIVE_GUEST_LIMIT = 12

export type GuestBudget = {
  readonly limit: number
  // Least recently active first.
  readonly live: readonly string[]
  // The guest the user is interacting with; never evicted.
  readonly activeId: string | null
}

export type BudgetChange = { budget: GuestBudget; evicted: string[] }

export function createGuestBudget(limit = LIVE_GUEST_LIMIT): GuestBudget {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('A guest budget needs a limit of at least one')
  return { limit, live: [], activeId: null }
}

// Makes the guest live as the most recently active, evicting the least recently active ones over the limit.
export function admitGuest(budget: GuestBudget, id: string): BudgetChange {
  const live = [...budget.live.filter((candidate) => candidate !== id), id]
  const evicted: string[] = []
  for (let index = 0; live.length > budget.limit && index < live.length; ) {
    const candidate = live[index]
    if (candidate === id || candidate === budget.activeId) {
      index += 1
    } else {
      live.splice(index, 1)
      evicted.push(candidate)
    }
  }
  return { budget: { ...budget, live }, evicted }
}

// Marks the guest the user is interacting with (null: none); an activated guest is admitted.
export function activateGuest(budget: GuestBudget, id: string | null): BudgetChange {
  if (id === null) return { budget: { ...budget, activeId: null }, evicted: [] }
  return admitGuest({ ...budget, activeId: id }, id)
}

export function releaseGuest(budget: GuestBudget, id: string): GuestBudget {
  return {
    ...budget,
    live: budget.live.filter((candidate) => candidate !== id),
    activeId: budget.activeId === id ? null : budget.activeId
  }
}
