import type { ComponentType } from 'react'
import type { PanelId } from './CanvasContext'
import { FocusBar } from './navigation/FocusBar'
import { CanvasMiniMap } from './overview/CanvasMiniMap'
import { ActivityPanel } from './panels/ActivityPanel'
import { ArchivedCount, ArchivedPanel } from './panels/ArchivedPanel'

// Extension points of the project canvas, for features layered on top of the shell. Components render inside
// the canvas's React Flow provider, so they may use React Flow hooks, the canvas context hooks, and the store hooks.

// Rendered at the end of the canvas toolbar, in order. Keep each to a few compact controls.
export const canvasToolbarItems: ComponentType[] = []

export type CanvasSidePanel = {
  id: PanelId
  // The toolbar toggle's text and the panel's accessible name.
  label: string
  Panel: ComponentType
  // A short count next to the toggle's label.
  Badge?: ComponentType
}

// One side panel is open at a time, in the region at the right edge of the canvas; toggles sit in the toolbar.
export const canvasSidePanels: CanvasSidePanel[] = [
  { id: 'activity', label: 'Activity', Panel: ActivityPanel },
  { id: 'archived', label: 'Archived', Panel: ArchivedPanel, Badge: ArchivedCount }
]

// Rendered inside the React Flow element itself (e.g. <MiniMap />, <Panel />), after the background.
export const canvasOverlays: ComponentType[] = [FocusBar, CanvasMiniMap]
