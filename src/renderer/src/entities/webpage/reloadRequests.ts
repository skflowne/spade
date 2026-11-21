// Lets the node menu's Reload reach the mounted body of the same node.
const listeners = new Map<string, Set<() => void>>()

export function onReloadRequested(nodeId: string, listener: () => void): () => void {
  const set = listeners.get(nodeId) ?? new Set()
  set.add(listener)
  listeners.set(nodeId, set)
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(nodeId)
  }
}

export function requestReload(nodeId: string): void {
  for (const listener of [...(listeners.get(nodeId) ?? [])]) listener()
}
