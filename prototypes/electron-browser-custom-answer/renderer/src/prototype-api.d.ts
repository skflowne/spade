import type { NativeOverlayCommand } from '../../shared/nativeOverlay'

export type WebviewNavigationEvent = Event & { url: string }

export interface PrototypeWebviewElement extends HTMLElement {
  canGoBack(): boolean
  canGoForward(): boolean
  executeJavaScript<T>(code: string): Promise<T>
  focus(): void
  goBack(): void
  goForward(): void
  loadURL(url: string): Promise<void>
  reload(): void
}

declare global {
  interface Window {
    spadePrototype: {
      nativeOverlay: {
        update(command: NativeOverlayCommand): void
      }
    }
  }
}
