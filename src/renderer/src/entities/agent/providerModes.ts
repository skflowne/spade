import { useEffect, useSyncExternalStore } from 'react'
import type { AgentModeInfo, AgentProviderInfo } from '@shared/agents'
import { useAppState } from '../../store/hooks'

// Paseo's provider discovery, read once for every mode selector. A failed read is tried again when a selector
// mounts or the Paseo connection changes.

type ProvidersState = { status: 'idle' | 'loading' | 'ready' | 'failed'; providers: readonly AgentProviderInfo[] }

let state: ProvidersState = { status: 'idle', providers: [] }
const listeners = new Set<() => void>()

function set(next: ProvidersState): void {
  state = next
  for (const listener of listeners) listener()
}

function load(): void {
  if (state.status === 'loading' || state.status === 'ready') return
  set({ ...state, status: 'loading' })
  window.spadeHost.agents.listProviders().then(
    (result) => set(result.ok ? { status: 'ready', providers: result.providers } : { status: 'failed', providers: [] }),
    () => set({ status: 'failed', providers: [] })
  )
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// The modes Paseo lists for `provider`; null until they are known or when it lists none.
export function useProviderModes(provider: string | null): readonly AgentModeInfo[] | null {
  const snapshot = useSyncExternalStore(subscribe, () => state)
  const connection = useAppState()?.paseo.state
  useEffect(() => {
    if (provider !== null) load()
  }, [provider, connection])
  if (provider === null) return null
  const modes = snapshot.providers.find((entry) => entry.id === provider)?.modes
  return modes && modes.length > 0 ? modes : null
}
