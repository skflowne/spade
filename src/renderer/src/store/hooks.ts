import { createContext, useContext, useSyncExternalStore } from 'react'
import type { AgentRuntime } from '@shared/agents'
import type { Canvas, Project } from '@shared/domain'
import type { AppState } from '@shared/ipc'
import type { Notice, SessionPreferences, SpadeStore, StoreState } from './store'

export const StoreContext = createContext<SpadeStore | null>(null)

export function useSpadeStore(): SpadeStore {
  const store = useContext(StoreContext)
  if (!store) throw new Error('useSpadeStore must be used inside StoreContext')
  return store
}

// `select` must return a value already held by the state (or a primitive) so renders stay stable.
export function useStoreState<Selected>(select: (state: StoreState) => Selected): Selected {
  const store = useSpadeStore()
  return useSyncExternalStore(store.subscribe, () => select(store.getSnapshot()))
}

export function useAppState(): AppState | null {
  return useStoreState((state) => state.app)
}

export function useSelectedProject(): Project | null {
  return useStoreState(
    (state) => state.app?.projects.find((project) => project.id === state.app?.selectedProjectId) ?? null
  )
}

export function useCanvas(projectId: string): Canvas | null {
  return useStoreState((state) => state.canvases.get(projectId) ?? null)
}

export function useAgentRuntime(nodeId: string): AgentRuntime | null {
  return useStoreState((state) => state.runtimes.get(nodeId) ?? null)
}

export type ProjectActivity = { running: number; attention: number }

// Running counts starting and running agents; attention counts agents waiting for the user.
export function useProjectActivity(projectId: string): ProjectActivity {
  const running = useStoreState((state) => countRuntimes(state, projectId, ['running', 'starting']))
  const attention = useStoreState((state) => countRuntimes(state, projectId, ['attention']))
  return { running, attention }
}

function countRuntimes(state: StoreState, projectId: string, activities: readonly string[]): number {
  let count = 0
  for (const runtime of state.runtimes.values()) {
    if (runtime.projectId === projectId && activities.includes(runtime.activity)) count += 1
  }
  return count
}

export function useNotices(): readonly Notice[] {
  return useStoreState((state) => state.notices)
}

export function useSession(): SessionPreferences {
  return useStoreState((state) => state.session)
}
