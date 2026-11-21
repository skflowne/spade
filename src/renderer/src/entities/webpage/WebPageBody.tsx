import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { useStore } from '@xyflow/react'
import { WEB_PAGE_PARTITION, type WebPageConfig } from '@shared/builtinEntities'
import { useCanvasActions } from '../../canvas/CanvasContext'
import type { EntityBodyProps, NodeStatus } from '../types'
import { useGuestSlot } from './guestSlots'
import { LocatorPersistence } from './locatorPersistence'
import { onReloadRequested } from './reloadRequests'
import { normalizeWebAddress, sameWebAddress } from './webAddress'
import {
  ABORTED_LOAD,
  type WebviewConsoleEvent,
  type WebviewElement,
  type WebviewFailedLoadEvent,
  type WebviewNavigationEvent,
  type WebviewTitleEvent
} from './webviewElement'
import './webpage.css'

const LOCATOR_SAVE_DELAY_MS = 750
const STATUS_TITLE_LENGTH = 28
// Chromium refuses page zoom below 25%.
const MIN_PAGE_ZOOM = 0.25

type PageState = {
  // The guest's current URL, or the durable one while no guest is mounted.
  url: string
  title: string | null
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  failure: { description: string; url: string } | null
}

// Keeps the guest's backing viewport at its on-screen size at fractional canvas zoom and scales it back up
// inside the zoomed canvas, so the page renders crisp instead of as a scaled bitmap (validated in P2). The
// page zoom then follows the canvas zoom, so the page keeps the layout it has at 100% instead of reflowing
// to the smaller viewport.
function guestZoomStyle(zoom: number): CSSProperties {
  return {
    width: `${zoom * 100}%`,
    height: `${zoom * 100}%`,
    transform: `scale(${1 / zoom})`
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function statusOf(page: PageState, live: boolean): NodeStatus | null {
  if (!live) return null
  if (page.failure) return { label: 'Failed', tone: 'danger', description: `${page.failure.description}: ${page.failure.url}` }
  if (page.loading) return { label: 'Loading', tone: 'info', description: page.url }
  if (!page.title) return null
  const label = page.title.length > STATUS_TITLE_LENGTH ? `${page.title.slice(0, STATUS_TITLE_LENGTH - 1)}…` : page.title
  return { label, tone: 'neutral', description: `${page.title}\n${page.url}` }
}

const ignore = (): void => undefined

export function WebPageBody({ node, config, project, active, detail, host }: EntityBodyProps<WebPageConfig>): React.JSX.Element {
  const canvas = useCanvasActions()
  const zoom = useStore((state) => state.transform[2])
  const root = useRef<HTMLDivElement>(null)
  const slot = useGuestSlot(project.id, node.id)
  const full = detail === 'full'
  const live = full && slot.live

  const [guest, setGuest] = useState<WebviewElement | null>(null)
  const [ready, setReady] = useState(false)
  const [page, setPage] = useState<PageState>(() => ({
    url: config.url,
    title: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    failure: null
  }))
  const [draft, setDraft] = useState<string | null>(null)
  const [draftInvalid, setDraftInvalid] = useState(false)

  const latest = useRef({ host, active, url: config.url })
  latest.current.host = host
  latest.current.active = active

  const [locator] = useState(
    () =>
      new LocatorPersistence({
        saved: config.url,
        delayMs: LOCATOR_SAVE_DELAY_MS,
        write: (url) => void latest.current.host.execute({ type: 'updateNode', nodeId: node.id, patch: { config: { url } } })
      })
  )
  useEffect(() => () => locator.flush(), [locator])

  // Another writer (an agent, another window) moved the page: the guest follows.
  useEffect(() => {
    if (!locator.recordChanged(config.url)) return
    latest.current.url = config.url
    setPage((current) => ({ ...current, url: config.url }))
    if (guest && ready && !sameWebAddress(guest.getURL(), config.url)) guest.loadURL(config.url).catch(ignore)
    // Only a record change moves the guest; the guest's own navigation must not re-run this.
  }, [config.url, locator])

  // Lazy mount (plan §6): a guest is requested once the body is in or near the canvas viewport.
  useEffect(() => {
    const element = root.current
    if (!full || !element) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) slot.request()
      },
      { root: element.closest('.react-flow'), rootMargin: '25%' }
    )
    observer.observe(element)
    return () => {
      observer.disconnect()
      slot.release()
    }
  }, [full, slot.request, slot.release])

  useEffect(() => {
    if (full) slot.setActive(active)
  }, [full, active, slot.setActive])

  // A guest that unmounts (evicted, preview, collapsed) is gone; the next one starts at the last URL.
  useEffect(() => {
    if (live) return
    setGuest(null)
    setReady(false)
    setPage((current) => ({ ...current, loading: false, canGoBack: false, canGoForward: false, failure: null }))
  }, [live])

  const syncHistory = useCallback((element: WebviewElement) => {
    setPage((current) => ({ ...current, canGoBack: element.canGoBack(), canGoForward: element.canGoForward() }))
  }, [])

  useEffect(() => {
    if (!guest) return
    const element = guest
    const escapeSignal = `spade-escape:${crypto.randomUUID()}`

    const navigated = (url: string): void => {
      latest.current.url = url
      locator.navigated(url)
      setPage((current) => ({ ...current, url }))
      syncHistory(element)
    }
    const listeners: Record<string, (event: Event) => void> = {
      'did-start-loading': () => setPage((current) => ({ ...current, loading: true, failure: null })),
      'did-stop-loading': () => {
        setPage((current) => ({ ...current, loading: false }))
        syncHistory(element)
      },
      'did-navigate': (event) => navigated((event as WebviewNavigationEvent).url),
      'did-navigate-in-page': (event) => {
        const navigation = event as WebviewNavigationEvent
        if (navigation.isMainFrame) navigated(navigation.url)
      },
      'did-fail-load': (event) => {
        const failure = event as WebviewFailedLoadEvent
        if (!failure.isMainFrame || failure.errorCode === ABORTED_LOAD) return
        setPage((current) => ({
          ...current,
          loading: false,
          failure: { description: failure.errorDescription || `Error ${failure.errorCode}`, url: failure.validatedURL }
        }))
      },
      'page-title-updated': (event) => setPage((current) => ({ ...current, title: (event as WebviewTitleEvent).title })),
      'dom-ready': () => {
        setReady(true)
        syncHistory(element)
        // Keys pressed inside the guest never reach this document, so Escape (plan §6: return control to the
        // canvas) is relayed from the page as a console message. The guest has no preload to do it otherwise.
        element
          .executeJavaScript(
            `addEventListener('keydown', (event) => { if (event.key === 'Escape') console.debug(${JSON.stringify(escapeSignal)}) }, true)`
          )
          .catch(ignore)
        if (latest.current.active) element.focus()
      },
      'console-message': (event) => {
        if ((event as WebviewConsoleEvent).message === escapeSignal && latest.current.active) canvas.setActiveNode(null)
      }
    }
    for (const [name, listener] of Object.entries(listeners)) element.addEventListener(name, listener)
    return () => {
      for (const [name, listener] of Object.entries(listeners)) element.removeEventListener(name, listener)
    }
  }, [guest, locator, syncHistory, canvas])

  // Chromium keeps page zoom per host, so a navigation to another host starts at 100% again.
  useEffect(() => {
    if (guest && ready) guest.setZoomFactor(Math.max(zoom, MIN_PAGE_ZOOM))
  }, [guest, ready, zoom, page.url])

  // Activation hands keyboard focus to the page; deactivation returns it to the canvas.
  useEffect(() => {
    if (!guest || !ready) return
    if (active) guest.focus()
    else if (document.activeElement === guest) guest.blur()
  }, [active, guest, ready])

  useEffect(
    () =>
      onReloadRequested(node.id, () => {
        if (guest && ready) guest.reload()
      }),
    [node.id, guest, ready]
  )

  const status = statusOf(page, live)
  const statusKey = status ? `${status.label}|${status.tone}|${status.description}` : ''
  useEffect(() => {
    host.setStatus(status)
    // The key captures every field of the status.
  }, [statusKey, host])
  useEffect(() => () => host.setStatus(null), [host])

  const navigate = (input: string): void => {
    const url = normalizeWebAddress(input)
    if (url === null) {
      setDraftInvalid(true)
      return
    }
    setDraft(null)
    setDraftInvalid(false)
    if (guest && ready) guest.loadURL(url).catch(ignore)
  }

  const retry = (): void => {
    if (!guest || !ready) return
    const failed = page.failure?.url
    if (failed && normalizeWebAddress(failed)) guest.loadURL(failed).catch(ignore)
    else guest.reload()
  }

  const usable = live && ready
  return (
    <div ref={root} className={active ? 'webpage webpage--active' : 'webpage'} data-testid="webpage">
      {full ? (
        <form
          className="webpage__bar"
          role="toolbar"
          aria-label="Page navigation"
          onSubmit={(event) => {
            event.preventDefault()
            navigate(draft ?? page.url)
          }}
        >
          <button
            type="button"
            className="cr-icon-button"
            aria-label="Back"
            title="Back"
            disabled={!usable || !page.canGoBack}
            onClick={() => guest?.goBack()}
          >
            ←
          </button>
          <button
            type="button"
            className="cr-icon-button"
            aria-label="Forward"
            title="Forward"
            disabled={!usable || !page.canGoForward}
            onClick={() => guest?.goForward()}
          >
            →
          </button>
          {page.loading ? (
            <button type="button" className="cr-icon-button" aria-label="Stop" title="Stop" disabled={!usable} onClick={() => guest?.stop()}>
              ✕
            </button>
          ) : (
            <button
              type="button"
              className="cr-icon-button"
              aria-label="Reload"
              title="Reload"
              disabled={!usable}
              onClick={() => guest?.reload()}
            >
              ↻
            </button>
          )}
          <input
            className="cr-input cr-input--mono webpage__address"
            aria-label="Address"
            aria-invalid={draftInvalid}
            title={draftInvalid ? 'Enter an http or https address.' : page.url}
            spellCheck={false}
            value={draft ?? page.url}
            onFocus={(event) => {
              setDraft(page.url)
              event.target.select()
            }}
            onChange={(event) => {
              setDraft(event.target.value)
              setDraftInvalid(false)
            }}
            onBlur={() => {
              setDraft(null)
              setDraftInvalid(false)
            }}
          />
          <button
            type="button"
            className="cr-icon-button"
            aria-label="Open in default browser"
            title="Open in default browser"
            onClick={() => void window.spadeHost.files.openExternal(page.url)}
          >
            ↗
          </button>
        </form>
      ) : null}
      <div className="webpage__surface">
        {live ? (
          <>
            <Guest initialUrl={latest.current.url} zoom={zoom} onElement={setGuest} />
            {ready ? null : (
              <div className="webpage__pending" aria-hidden="true">
                Loading page…
              </div>
            )}
          </>
        ) : (
          <div className="webpage__placeholder" data-testid="webpage-placeholder">
            <span className="webpage__placeholder-host">{hostOf(page.url)}</span>
            <span className="mono webpage__placeholder-url">{page.url}</span>
            {full ? <span className="webpage__placeholder-hint">Click to load the page.</span> : null}
          </div>
        )}
        {live && page.loading ? <div className="webpage__progress" role="progressbar" aria-label="Loading page" /> : null}
        {live && page.failure ? (
          <div className="webpage__failure" role="alert" data-testid="webpage-failure">
            <p className="webpage__failure-title">This page could not be loaded</p>
            <p className="webpage__failure-reason">{page.failure.description}</p>
            <p className="mono webpage__failure-url">{page.failure.url}</p>
            <button type="button" className="cr-button" onClick={retry}>
              Retry
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function Guest({
  initialUrl,
  zoom,
  onElement
}: {
  initialUrl: string
  zoom: number
  onElement(element: WebviewElement | null): void
}): React.JSX.Element {
  // Set once: changing `src` on a live <webview> navigates it, and the guest's own navigation is not a
  // reason to navigate again. Later moves go through loadURL.
  const [src] = useState(initialUrl)
  const ref = useCallback((element: HTMLElement | null) => onElement(element as WebviewElement | null), [onElement])
  return (
    <webview
      ref={ref}
      className="webpage__guest"
      data-testid="webpage-guest"
      src={src}
      partition={WEB_PAGE_PARTITION}
      style={guestZoomStyle(zoom)}
    />
  )
}
