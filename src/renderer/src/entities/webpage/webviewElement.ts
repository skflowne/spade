// The slice of Electron's <webview> element API the web page renderer uses (the renderer's TypeScript
// project does not include Electron's own types). Methods other than loadURL throw until `dom-ready`.
export interface WebviewElement extends HTMLElement {
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
  loadURL(url: string): Promise<void>
  getURL(): string
  getTitle(): string
  isLoading(): boolean
  setZoomFactor(factor: number): void
  executeJavaScript<Result = unknown>(code: string): Promise<Result>
}

export type WebviewNavigationEvent = Event & { url: string; isMainFrame?: boolean }
export type WebviewFailedLoadEvent = Event & {
  errorCode: number
  errorDescription: string
  validatedURL: string
  isMainFrame: boolean
}
export type WebviewTitleEvent = Event & { title: string }
export type WebviewConsoleEvent = Event & { message: string }

// Chromium's net::ERR_ABORTED: the navigation was replaced or stopped, not a failure to show.
export const ABORTED_LOAD = -3
