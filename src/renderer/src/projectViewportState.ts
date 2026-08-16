import type { Viewport } from '@xyflow/react'

export type ProjectViewports = Readonly<Record<string, Viewport>>

export function projectViewport(
  viewports: ProjectViewports,
  projectId: string,
  fallback: Viewport
): Viewport {
  return viewports[projectId] ?? fallback
}

export function rememberProjectViewport(
  viewports: ProjectViewports,
  projectId: string,
  viewport: Viewport
): ProjectViewports {
  const current = viewports[projectId]

  if (current && current.x === viewport.x && current.y === viewport.y && current.zoom === viewport.zoom) {
    return viewports
  }

  return { ...viewports, [projectId]: viewport }
}
