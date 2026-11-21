import { useEffect } from 'react'
import { useSpadeStore } from '../../store/hooks'

// Node menu entries run outside React; these let them reach the mounted body of the same node and show
// failures as notices.

export type ImageRequest = 'reload' | 'full-size'

const listeners = new Map<string, Set<(request: ImageRequest) => void>>()

export function onImageRequest(nodeId: string, listener: (request: ImageRequest) => void): () => void {
  const set = listeners.get(nodeId) ?? new Set()
  set.add(listener)
  listeners.set(nodeId, set)
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(nodeId)
  }
}

export function requestImage(nodeId: string, request: ImageRequest): void {
  for (const listener of [...(listeners.get(nodeId) ?? [])]) listener(request)
}

let notify: ((message: string) => void) | null = null

// Registers the app's notices as the place menu-action failures go.
export function useFailureNotices(): void {
  const store = useSpadeStore()
  useEffect(() => {
    notify = (message) => store.notify(message)
  }, [store])
}

export function reportFailure(message: string): void {
  if (notify) notify(message)
  else console.error(message)
}

export async function revealImage(projectId: string, path: string): Promise<void> {
  const result = await window.spadeHost.files.reveal(projectId, path)
  if (!result.ok) reportFailure(result.error.message)
}

export async function copyImagePath(path: string): Promise<void> {
  const result = await window.spadeHost.files.copyText(path)
  if (!result.ok) reportFailure(result.error.message)
}
