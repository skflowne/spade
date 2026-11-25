import { useEffect, useSyncExternalStore } from 'react'
import type { AgentModeInfo } from '@shared/agents'
import { useAppState } from '../../store/hooks'
import { ProviderCatalog } from './providerCatalog'

// One catalog for every mode selector. A failed read is tried again when a selector mounts or the Paseo
// connection changes; a daemon switch or a reconnection reads the providers again.
const catalog = new ProviderCatalog(() => window.spadeHost.agents.listProviders())

// The modes Paseo lists for `provider`; null until they are known or when it lists none.
export function useProviderModes(provider: string | null): readonly AgentModeInfo[] | null {
  const snapshot = useSyncExternalStore(catalog.subscribe, catalog.snapshot)
  const paseo = useAppState()?.paseo
  const state = paseo?.state
  const url = paseo?.url
  useEffect(() => {
    if (state !== undefined && url !== undefined) catalog.observe({ state, url })
    if (provider !== null) catalog.load()
  }, [provider, state, url])
  if (provider === null) return null
  const modes = snapshot.providers.find((entry) => entry.id === provider)?.modes
  return modes && modes.length > 0 ? modes : null
}
