// Level of detail (plan §12). Body text is 13px; below this zoom it renders under ~6.5 screen pixels and is
// unreadable, so node bodies switch to their preview and the chrome to its overview form.
export const PREVIEW_ZOOM_THRESHOLD = 0.5

export type DetailLevel = 'full' | 'preview'

export function detailForZoom(zoom: number): DetailLevel {
  return zoom < PREVIEW_ZOOM_THRESHOLD ? 'preview' : 'full'
}

// The overview title grows as the canvas zooms out so it stays near a readable screen size, within a bound
// that keeps it inside the node's header.
export const OVERVIEW_TITLE_MAX_SCALE = 3

export function overviewTitleScale(zoom: number): number {
  if (!(zoom > 0)) return OVERVIEW_TITLE_MAX_SCALE
  return Math.min(OVERVIEW_TITLE_MAX_SCALE, Math.max(1, PREVIEW_ZOOM_THRESHOLD / zoom * 1.6))
}
