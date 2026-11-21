import type { ComponentType } from 'react'

// Extension points of the project canvas, for features layered on top of the shell (search, minimap,
// focus history, activity, archived nodes, references). Components render inside the canvas's React Flow
// provider, so they may use React Flow hooks, useCanvasData(), useCanvasActions() and the store hooks.

// Rendered at the end of the canvas toolbar, in order. Keep each to a few compact controls.
export const canvasToolbarItems: ComponentType[] = []

// Rendered in the side-panel region at the right edge of the canvas, stacked in order. The region is
// omitted when the list is empty; each panel owns its own open/closed state.
export const canvasSidePanels: ComponentType[] = []

// Rendered inside the React Flow element itself (e.g. <MiniMap />, <Panel />), after the background.
export const canvasOverlays: ComponentType[] = []
