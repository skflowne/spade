import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { activateGuest, admitGuest, createGuestBudget, releaseGuest, type BudgetChange, type GuestBudget } from './guestBudget'

// One live-guest budget per canvas, shared by every web page body on it.
type Scope = { budget: GuestBudget; listeners: Set<() => void> }

const scopes = new Map<string, Scope>()

function scopeOf(scopeId: string): Scope {
  let scope = scopes.get(scopeId)
  if (!scope) {
    scope = { budget: createGuestBudget(), listeners: new Set() }
    scopes.set(scopeId, scope)
  }
  return scope
}

function apply(scope: Scope, next: GuestBudget | BudgetChange): void {
  const budget = 'live' in next ? next : next.budget
  if (budget === scope.budget) return
  scope.budget = budget
  for (const listener of [...scope.listeners]) listener()
}

export type GuestSlot = {
  // The guest may be mounted.
  live: boolean
  // The body is in view and wants its guest; may evict the least recently active guest of the canvas.
  request(): void
  // The body no longer shows its guest (unmounted, preview, collapsed).
  release(): void
  setActive(active: boolean): void
}

export function useGuestSlot(scopeId: string, nodeId: string): GuestSlot {
  const scope = scopeOf(scopeId)
  const subscribe = useCallback(
    (listener: () => void) => {
      scope.listeners.add(listener)
      return () => scope.listeners.delete(listener)
    },
    [scope]
  )
  const live = useSyncExternalStore(subscribe, () => scope.budget.live.includes(nodeId))
  // Stable for the body's lifetime, so effects can depend on them without re-running when `live` changes.
  const actions = useMemo<Omit<GuestSlot, 'live'>>(
    () => ({
      request: () => apply(scope, admitGuest(scope.budget, nodeId)),
      release: () => apply(scope, releaseGuest(scope.budget, nodeId)),
      setActive: (active) => {
        if (active) apply(scope, activateGuest(scope.budget, nodeId))
        else if (scope.budget.activeId === nodeId) apply(scope, activateGuest(scope.budget, null))
      }
    }),
    [scope, nodeId]
  )
  return { live, ...actions }
}
