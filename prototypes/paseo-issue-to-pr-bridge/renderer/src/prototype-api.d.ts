import type { P3PrototypeBridge } from '../../shared/ipc'

declare global {
  interface Window {
    spadeP3: P3PrototypeBridge
  }
}

export {}
