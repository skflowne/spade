import type { Rect, Size, Viewport } from '../../../shared/domain'

// readable: 100% unless the node does not fit (plan §8, viewport on spawn).
// fit: the whole node, as large as the screen allows.
// full-height: the node's height fills the screen even when its width overflows (plan §6).
export type FocusMode = 'readable' | 'fit' | 'full-height'

export type ZoomLimits = { minZoom: number; maxZoom: number }

// Screen pixels along each edge that overlays (the breadcrumb, the minimap) cover.
export type CoveredEdges = { top?: number; right?: number; bottom?: number; left?: number }

// Screen pixels kept free around a focused node.
export const FOCUS_MARGIN = 32

// Centers the node in the part of the screen no overlay covers, so it is legible without rearranging anything.
export function focusViewport(rect: Rect, screen: Size, mode: FocusMode, limits: ZoomLimits, covered: CoveredEdges = {}): Viewport {
  const left = covered.left ?? 0
  const top = covered.top ?? 0
  const free = {
    width: Math.max(1, screen.width - left - (covered.right ?? 0)),
    height: Math.max(1, screen.height - top - (covered.bottom ?? 0))
  }
  const room = {
    width: Math.max(1, free.width - 2 * FOCUS_MARGIN),
    height: Math.max(1, free.height - 2 * FOCUS_MARGIN)
  }
  const fitZoom = Math.min(room.width / rect.width, room.height / rect.height)
  const wanted =
    mode === 'readable' ? Math.min(1, fitZoom) : mode === 'fit' ? fitZoom : room.height / rect.height
  const zoom = Math.min(limits.maxZoom, Math.max(limits.minZoom, wanted))
  const centerX = rect.x + rect.width / 2
  const centerY = rect.y + rect.height / 2
  return { x: left + free.width / 2 - centerX * zoom, y: top + free.height / 2 - centerY * zoom, zoom }
}
