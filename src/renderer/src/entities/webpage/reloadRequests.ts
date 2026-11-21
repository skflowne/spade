// Lets the node menu's Reload reach the mounted body of the same node. A body registers only while it has a
// page to reload, so the menu can tell when Reload cannot work.
const reloaders = new Map<string, () => void>()

export function registerReload(nodeId: string, reload: () => void): () => void {
  reloaders.set(nodeId, reload)
  return () => {
    if (reloaders.get(nodeId) === reload) reloaders.delete(nodeId)
  }
}

export function reloaderOf(nodeId: string): (() => void) | null {
  return reloaders.get(nodeId) ?? null
}
