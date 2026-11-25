import { createContext, useContext, useSyncExternalStore } from 'react'
import type { CanvasCommand, CanvasCommandResponse } from '@shared/commands'
import type { Canvas, Project, Rect } from '@shared/domain'
import type { SpawnRequest } from '../entities/types'
import type { AgentChange } from './model/activityView'
import type { FocusMode } from './viewportMath'

// What everything inside one project's canvas (node wrappers, dialogs, toolbar, extensions) can use.

export type CanvasData = {
  project: Project
  // The authoritative record, as last pushed by the main process.
  canvas: Canvas
}

export type PanelId = 'activity' | 'archived'

export type CanvasActions = {
  // The latest record, for event handlers; components that render it use useCanvasData().
  getCanvas(): Canvas
  // Runs a command on this project; failures are shown as notices.
  execute(command: CanvasCommand): Promise<CanvasCommandResponse>
  // An explicit focus move: expands any collapsed branch hiding the node, centers it (waiting for it to appear
  // when it was just created), selects it, and records it in the focus history. Default mode: 'readable'.
  // Archived nodes cannot be focused.
  focusNode(nodeId: string, mode?: FocusMode): void
  // Moves through the focus history, skipping nodes that can no longer be focused.
  goBack(): void
  goForward(): void
  // The node the breadcrumb shows and keyboard navigation starts from, without moving the viewport.
  setCurrentNode(nodeId: string): void
  togglePanel(panel: PanelId): void
  // Opens a side panel, optionally pointing at one of its entries (a node id).
  openPanel(panel: PanelId, highlightNodeId?: string): void
  closePanel(): void
  // Lets the user pick another node and adds a `references` edge from this one to it.
  connectExisting(nodeId: string): Promise<void>
  // Centers a canvas rectangle (flow coordinates) at a readable zoom.
  focusRect(rect: Rect, mode?: FocusMode): void
  fitAll(): void
  // Opens the new-node dialog; with a source node the default target is a child of it.
  openCreate(options: { entityType?: string; sourceNodeId?: string }): void
  requestSpawn(request: SpawnRequest): Promise<string | null>
  openMove(nodeId: string): void
  // Lets the user click a node on the canvas. Resolves with its id, or null on Escape.
  pickNode(prompt: string): Promise<string | null>
  setActiveNode(nodeId: string | null): void
  finishResize(nodeId: string, rect: Rect): void
}

export type CanvasInteraction = {
  // The node whose body receives input (plan §6 interaction rule); null when the canvas has it.
  activeNodeId: string | null
  picking: boolean
}

export type CanvasNavigation = {
  panel: PanelId | null
  // The entry the open panel points at.
  panelHighlight: string | null
  currentNodeId: string | null
  canGoBack: boolean
  canGoForward: boolean
}

// Agent-made changes per node, read per node so a change re-renders only the nodes it concerns.
export type AgentChangeSource = {
  subscribe(listener: () => void): () => void
  get(nodeId: string): AgentChange | undefined
}

export const CanvasDataContext = createContext<CanvasData | null>(null)
export const CanvasProjectContext = createContext<Project | null>(null)
export const CanvasNavigationContext = createContext<CanvasNavigation | null>(null)
export const AgentChangeContext = createContext<AgentChangeSource | null>(null)
export const CanvasActionsContext = createContext<CanvasActions | null>(null)
export const CanvasInteractionContext = createContext<CanvasInteraction>({ activeNodeId: null, picking: false })

export function useCanvasData(): CanvasData {
  const data = useContext(CanvasDataContext)
  if (!data) throw new Error('useCanvasData must be used inside a project canvas')
  return data
}

// Changes only when the project record does, unlike useCanvasData(), which changes with every canvas push.
export function useCanvasProject(): Project {
  const project = useContext(CanvasProjectContext)
  if (!project) throw new Error('useCanvasProject must be used inside a project canvas')
  return project
}

export function useCanvasNavigation(): CanvasNavigation {
  const navigation = useContext(CanvasNavigationContext)
  if (!navigation) throw new Error('useCanvasNavigation must be used inside a project canvas')
  return navigation
}

export function useAgentChange(nodeId: string): AgentChange | undefined {
  const source = useContext(AgentChangeContext)
  if (!source) throw new Error('useAgentChange must be used inside a project canvas')
  return useSyncExternalStore(source.subscribe, () => source.get(nodeId))
}

// Stable for the canvas's lifetime.
export function useCanvasActions(): CanvasActions {
  const actions = useContext(CanvasActionsContext)
  if (!actions) throw new Error('useCanvasActions must be used inside a project canvas')
  return actions
}

export function useCanvasInteraction(): CanvasInteraction {
  return useContext(CanvasInteractionContext)
}
