import { WEB_PAGE_PARTITION } from '../../shared/builtinEntities'

// Policy for web page guests (<webview>), plan §7.3. Written against the small slice of Electron's
// WebContents and Session it uses, so it runs unchanged against fakes in tests.

// The parsed URL when it is an http or https URL with a host; the only kind a guest or the default browser opens.
export function parseWebUrl(value: unknown): URL | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.length > 0 ? url : null
  } catch {
    return null
  }
}

type PreventableEvent = { preventDefault(): void }

type GuestWebPreferences = {
  preload?: string
  nodeIntegration?: boolean
  nodeIntegrationInSubFrames?: boolean
  contextIsolation?: boolean
  sandbox?: boolean
  webviewTag?: boolean
  partition?: string
  // Electron's internal form of the <webview allowpopups> attribute.
  disablePopups?: boolean
}

export type PolicyWebContents = {
  getType(): string
  on(
    event: 'will-attach-webview',
    listener: (event: PreventableEvent, webPreferences: GuestWebPreferences, params: Record<string, string>) => void
  ): unknown
  on(event: 'will-navigate' | 'will-redirect', listener: (event: PreventableEvent & { url: string }) => void): unknown
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void
  loadURL(url: string): Promise<void>
}

export type PolicySession = {
  setPermissionRequestHandler(
    handler: ((contents: unknown, permission: string, callback: (granted: boolean) => void) => void) | null
  ): void
  setPermissionCheckHandler(handler: ((contents: unknown, permission: string) => boolean) | null): void
  on(event: 'will-download', listener: (event: PreventableEvent) => void): unknown
  off(event: 'will-download', listener: (event: PreventableEvent) => void): unknown
}

export type WebviewPolicyTarget = {
  // Every WebContents created from now on: host windows (which attach guests) and the guests themselves.
  onWebContentsCreated(listener: (contents: PolicyWebContents) => void): () => void
  // The session of WEB_PAGE_PARTITION.
  session: PolicySession
}

// Copy buttons and video fullscreen. Passkeys, which P2 verified in a guest, are not permission-gated.
const GRANTED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen'])

function isAllowedGuestSource(src: string | undefined): boolean {
  return src === undefined || src === '' || src === 'about:blank' || parseWebUrl(src) !== null
}

// Only `webPreferences` shapes the guest; `params` carries its initial URL.
function hardenAttachment(event: PreventableEvent, webPreferences: GuestWebPreferences, params: Record<string, string>): void {
  delete webPreferences.preload
  webPreferences.nodeIntegration = false
  webPreferences.nodeIntegrationInSubFrames = false
  webPreferences.contextIsolation = true
  webPreferences.sandbox = true
  webPreferences.webviewTag = false
  webPreferences.partition = WEB_PAGE_PARTITION
  // Without this Electron drops popups before the window-open handler can turn them into same-guest navigation.
  webPreferences.disablePopups = false
  if (!isAllowedGuestSource(params.src)) event.preventDefault()
}

function applyGuestPolicy(guest: PolicyWebContents): void {
  // A popup replaces the page in the same guest instead of opening a window.
  guest.setWindowOpenHandler(({ url }) => {
    if (parseWebUrl(url)) void guest.loadURL(url).catch(() => undefined)
    return { action: 'deny' }
  })
  const keepOnTheWeb = (event: PreventableEvent & { url: string }) => {
    if (!parseWebUrl(event.url)) event.preventDefault()
  }
  guest.on('will-navigate', keepOnTheWeb)
  guest.on('will-redirect', keepOnTheWeb)
}

// Returns a function that stops applying the policy to new contents and clears the session handlers.
export function installWebviewPolicy(target: WebviewPolicyTarget): () => void {
  const stopWatching = target.onWebContentsCreated((contents) => {
    contents.on('will-attach-webview', hardenAttachment)
    if (contents.getType() === 'webview') applyGuestPolicy(contents)
  })

  const { session } = target
  session.setPermissionRequestHandler((_contents, permission, callback) => callback(GRANTED_PERMISSIONS.has(permission)))
  session.setPermissionCheckHandler((_contents, permission) => GRANTED_PERMISSIONS.has(permission))
  // Downloads are unverified (plan §7.3); refuse them until they are designed.
  const cancelDownload = (event: PreventableEvent) => event.preventDefault()
  session.on('will-download', cancelDownload)

  return () => {
    stopWatching()
    session.setPermissionRequestHandler(null)
    session.setPermissionCheckHandler(null)
    session.off('will-download', cancelDownload)
  }
}
