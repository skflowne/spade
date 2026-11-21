import type { SpadeHostBridge } from '@shared/ipc'

declare global {
  interface Window {
    // Exposed by the sandboxed preload; the renderer's only way to reach SPADE's records and services.
    readonly spadeHost: SpadeHostBridge
  }
}

export {}
