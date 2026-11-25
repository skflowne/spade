import { createContext, useContext, useSyncExternalStore } from 'react'
import type { AgentRuntime } from '@shared/agents'
import type { Canvas, Project } from '@shared/domain'
import type { AppState } from '@shared/ipc'
import { agentDirectory, sameAgentDirectory, type AgentDirectory } from '../canvas/model/activityView'
import { collapsedDescendants } from '../entities/agent/children'
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

// Per runtimes record, then per project; the latest per project is reused while its content is unchanged, so a
// runtime push that changes no title or owner does not re-derive the activity views.
const directories = new WeakMap<ReadonlyMap<string, AgentRuntime>, Map<string, AgentDirectory>>()
const latestDirectories = new Map<string, AgentDirectory>()

function directoryOf(runtimes: ReadonlyMap<string, AgentRuntime>, projectId: string): AgentDirectory {
  let byProject = directories.get(runtimes)
  if (!byProject) {
    byProject = new Map()
    directories.set(runtimes, byProject)
  }
  const cached = byProject.get(projectId)
  if (cached) return cached
  const built = agentDirectory(runtimes.values(), projectId)
  const latest = latestDirectories.get(projectId)
  const directory = latest && sameAgentDirectory(latest, built) ? latest : built
  latestDirectories.set(projectId, directory)
  byProject.set(projectId, directory)
  return directory
}

// What the project's runtimes say about agents without a node of their own (titles, owners).
export function useAgentDirectory(projectId: string): AgentDirectory {
  return useStoreState((state) => directoryOf(state.runtimes, projectId))
}

export function useFinishedAgents(): ReadonlySet<string> {
  return useStoreState((state) => state.finishedAgents)
}

export type ProjectActivity = { running: number; attention: number }

// Running counts starting and running agents; attention counts agents waiting for the user. Collapsed Paseo
// children count too: they have no node of their own.
export function useProjectActivity(projectId: string): ProjectActivity {
  const running = useStoreState((state) => countRuntimes(state, projectId, ['running', 'starting']))
  const attention = useStoreState((state) => countRuntimes(state, projectId, ['attention']))
  return { running, attention }
}

function countRuntimes(state: StoreState, projectId: string, activities: readonly string[]): number {
  let count = 0
  for (const runtime of state.runtimes.values()) {
    if (runtime.projectId !== projectId) continue
    if (activities.includes(runtime.activity)) count += 1
    for (const child of collapsedDescendants(runtime.children)) if (activities.includes(child.activity)) count += 1
  }
  return count
}

export function useNotices(): readonly Notice[] {
  return useStoreState((state) => state.notices)
}

export function useDrawerOpen(nodeId: string): boolean {
  return useStoreState((state) => state.session.openDrawers.has(nodeId))
}

export function useSession(): SessionPreferences {
  return useStoreState((state) => state.session)
}
