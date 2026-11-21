// The slice of Electron's <webview> element API the web page renderer uses (the renderer's TypeScript
// project does not include Electron's own types). Every method throws until the guest is callable; see
// `whenCallable`.
export interface WebviewElement extends HTMLElement {
  getWebContentsId(): number
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

export function isCallable(element: WebviewElement): boolean {
  try {
    element.getWebContentsId()
    return true
  } catch {
    return false
  }
}

// The guest's current address, or null once its element is detached.
export function guestUrl(element: WebviewElement): string | null {
  try {
    return element.getURL()
  } catch {
    return null
  }
}

const CALLABLE_POLL_MS = 16
const CALLABLE_POLL_LIMIT = 300

// Calls back once the element's methods can be called. Measured in Electron 43: the methods work as soon as
// the element holds its guest instance id, which arrives with the reply to the element's create-guest
// request, one task after the `did-attach` event and long before `dom-ready` (a page that never answers
// never reaches it, yet takes stop, loadURL, and setZoomFactor). No event marks that moment, so it is polled
// from mount and again after `did-attach`.
export function whenCallable(element: WebviewElement, callback: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let polls = 0
  const check = (): void => {
    timer = null
    if (isCallable(element)) {
      stop()
      callback()
    } else if (polls++ < CALLABLE_POLL_LIMIT) {
      timer = setTimeout(check, CALLABLE_POLL_MS)
    }
  }
  const attached = (): void => {
    polls = 0
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(check, 0)
  }
  const stop = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    element.removeEventListener('did-attach', attached)
  }
  element.addEventListener('did-attach', attached)
  check()
  return stop
}
