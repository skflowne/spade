// Node menu entries run outside React; this lets them reach the mounted body of the same node, and tell
// when no body is there to act.

export type ImageBodyControls = {
  reload(): void
  openFullSize(): void
  // Why the image cannot be opened at full size, or null when it can.
  fullSizeUnavailable: string | null
}

const bodies = new Map<string, ImageBodyControls>()

export function registerImageBody(nodeId: string, controls: ImageBodyControls): () => void {
  bodies.set(nodeId, controls)
  return () => {
    if (bodies.get(nodeId) === controls) bodies.delete(nodeId)
  }
}

export function imageBodyOf(nodeId: string): ImageBodyControls | null {
  return bodies.get(nodeId) ?? null
}

export async function revealImage(projectId: string, path: string, notify: (message: string) => void): Promise<void> {
  const result = await window.spadeHost.files.reveal(projectId, path)
  if (!result.ok) notify(`Could not reveal the image: ${result.error.message}`)
}

export async function copyImagePath(path: string, notify: (message: string) => void): Promise<void> {
  const result = await window.spadeHost.files.copyText(path)
  if (!result.ok) notify(`Could not copy the path: ${result.error.message}`)
}
