import { createContext, useContext } from 'react'
import type { CanvasCommand, CanvasCommandResponse } from '@shared/commands'
import type { Canvas, Project, Rect } from '@shared/domain'
import type { SpawnRequest } from '../entities/types'
import type { FocusMode } from './viewportMath'

// What everything inside one project's canvas (node wrappers, dialogs, toolbar, extensions) can use.

export type CanvasData = {
  project: Project
  // The authoritative record, as last pushed by the main process.
  canvas: Canvas
}

export type CanvasActions = {
  // Runs a command on this project; failures are shown as notices.
  execute(command: CanvasCommand): Promise<CanvasCommandResponse>
  // Centers a node; waits for it to appear when it was just created. Default mode: 'readable'.
  focusNode(nodeId: string, mode?: FocusMode): void
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

export const CanvasDataContext = createContext<CanvasData | null>(null)
export const CanvasActionsContext = createContext<CanvasActions | null>(null)
export const CanvasInteractionContext = createContext<CanvasInteraction>({ activeNodeId: null, picking: false })

export function useCanvasData(): CanvasData {
  const data = useContext(CanvasDataContext)
  if (!data) throw new Error('useCanvasData must be used inside a project canvas')
  return data
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
