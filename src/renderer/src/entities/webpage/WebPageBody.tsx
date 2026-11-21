import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useStore } from '@xyflow/react'
import { WEB_PAGE_PARTITION, type WebPageConfig } from '@shared/builtinEntities'
import { useCanvasActions } from '../../canvas/CanvasContext'
import type { EntityBodyProps, NodeStatus } from '../types'
import { useGuestSlot } from './guestSlots'
import { LocatorPersistence } from './locatorPersistence'
import { registerReload } from './reloadRequests'
import { normalizeWebAddress, sameWebAddress } from './webAddress'
import {
  ABORTED_LOAD,
  guestUrl,
  isCallable,
  whenCallable,
  type WebviewConsoleEvent,
  type WebviewElement,
  type WebviewFailedLoadEvent,
  type WebviewNavigationEvent,
  type WebviewGoneEvent,
  type WebviewTitleEvent
} from './webviewElement'
import './webpage.css'

const LOCATOR_SAVE_DELAY_MS = 750
const STATUS_TITLE_LENGTH = 28
// Chromium refuses page zoom below 25%.
const MIN_PAGE_ZOOM = 0.25

const pageZoom = (zoom: number): number => Math.max(zoom, MIN_PAGE_ZOOM)

type PageState = {
  // The guest's current URL, or the durable one while no guest is mounted.
  url: string
  title: string | null
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  failure: { description: string; url: string } | null
  // The guest's renderer process ended; only a fresh guest can show the page again.
  crashed: { description: string } | null
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

function crashDescription(reason: string): string {
  if (reason === 'oom') return 'The page ran out of memory.'
  if (reason === 'killed') return 'The page’s process was ended.'
  return 'The page’s process crashed.'
}

function statusOf(page: PageState, live: boolean): NodeStatus | null {
  if (!live) return null
  if (page.crashed) return { label: 'Crashed', tone: 'danger', description: `${page.crashed.description}\n${page.url}` }
  if (page.failure) return { label: 'Failed', tone: 'danger', description: `${page.failure.description}: ${page.failure.url}` }
  if (page.loading) return { label: 'Loading', tone: 'info', description: page.url }
  if (!page.title) return null
  const label = page.title.length > STATUS_TITLE_LENGTH ? `${page.title.slice(0, STATUS_TITLE_LENGTH - 1)}…` : page.title
  return { label, tone: 'neutral', description: `${page.title}\n${page.url}` }
}

const ignore = (): void => undefined

// An address waiting for the mounted guest to become callable. `follow`: it comes from another writer, so the
// locator ignores the guest's navigations until the guest has settled on it.
type WantedAddress = { url: string; follow: boolean }

export function WebPageBody({ node, config, project, active, detail, host }: EntityBodyProps<WebPageConfig>): React.JSX.Element {
  const canvas = useCanvasActions()
  const zoom = useStore((state) => state.transform[2])
  const root = useRef<HTMLDivElement>(null)
  const slot = useGuestSlot(project.id, node.id)
  const full = detail === 'full'
  const live = full && slot.live

  const [guest, setGuest] = useState<WebviewElement | null>(null)
  // The guest's methods can be called; long before `dom-ready`, which a page that never answers never fires.
  const [callable, setCallable] = useState(false)
  // The first document is ready; until then the surface says the page is loading.
  const [ready, setReady] = useState(false)
  const [page, setPage] = useState<PageState>(() => ({
    url: config.url,
    title: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    failure: null,
    crashed: null
  }))
  // Changing it replaces the guest with a fresh one at the latest address.
  const [guestKey, setGuestKey] = useState(0)
  const [draft, setDraft] = useState<string | null>(null)
  const [draftInvalid, setDraftInvalid] = useState(false)
  // `guest` and `callable` still describe an unmounted guest for one commit, when its element is already
  // detached and every webview method throws; `live` is current in that commit.
  const attached = live && callable ? guest : null
  // The mounted element, current even within a commit, for calls made outside render.
  const element = useRef<WebviewElement | null>(null)
  const wanted = useRef<WantedAddress | null>(null)
  // Only the newest followed load may end the locator's following.
  const followLoads = useRef(0)
  const onElement = useCallback((next: WebviewElement | null) => {
    element.current = next
    setGuest(next)
  }, [])

  const latest = useRef({ host, active, url: config.url, zoom })
  latest.current.host = host
  latest.current.active = active
  latest.current.zoom = zoom

  const [locator] = useState(
    () =>
      new LocatorPersistence({
        saved: config.url,
        delayMs: LOCATOR_SAVE_DELAY_MS,
        write: (url) => void latest.current.host.execute({ type: 'updateNode', nodeId: node.id, patch: { config: { url } } })
      })
  )
  useEffect(() => () => locator.flush(), [locator])

  const load = useCallback(
    (target: WebviewElement, { url, follow }: WantedAddress) => {
      if (!follow) {
        target.loadURL(url).catch(ignore)
        return
      }
      const followLoad = ++followLoads.current
      const settle = (settled: string | null): void => {
        if (followLoad === followLoads.current) locator.followed(settled)
      }
      if (sameWebAddress(guestUrl(target) ?? '', url)) settle(null)
      else target.loadURL(url).then(() => settle(guestUrl(target)), () => settle(null))
    },
    [locator]
  )

  // Moves the guest to `url` as soon as it can take calls. Without a mounted guest, the next one starts there.
  const go = useCallback(
    (address: WantedAddress) => {
      const target = element.current
      if (target && isCallable(target)) {
        load(target, address)
      } else if (target) {
        // An address from the user replaces one being followed.
        if (wanted.current?.follow && !address.follow) locator.followed(null)
        wanted.current = address
      } else {
        latest.current.url = address.url
        setPage((current) => ({ ...current, url: address.url }))
        if (address.follow) locator.followed(null)
      }
    },
    [load, locator]
  )

  useEffect(() => {
    if (!attached || !wanted.current) return
    const address = wanted.current
    wanted.current = null
    load(attached, address)
  }, [attached, load])

  // Another writer (an agent, another window) moved the page: the guest follows.
  useEffect(() => {
    if (!locator.recordChanged(config.url)) return
    latest.current.url = config.url
    setPage((current) => ({ ...current, url: config.url }))
    go({ url: config.url, follow: true })
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
    setCallable(false)
    setReady(false)
    setPage((current) => ({ ...current, loading: false, canGoBack: false, canGoForward: false, failure: null, crashed: null }))
  }, [live])

  const syncHistory = useCallback((target: WebviewElement) => {
    if (!isCallable(target)) return
    // Read now, while the event's guest is attached, not in the updater, which may run after it unmounts.
    const history = { canGoBack: target.canGoBack(), canGoForward: target.canGoForward() }
    setPage((current) => ({ ...current, ...history }))
  }, [])

  useEffect(() => {
    if (!guest) return
    const target = guest
    const escapeSignal = `spade-escape:${crypto.randomUUID()}`

    const stopWaiting = whenCallable(target, () => {
      setCallable(true)
      // Loading may have started before these listeners were added.
      const loading = target.isLoading()
      setPage((current) => ({ ...current, loading }))
      syncHistory(target)
    })
    const navigated = (url: string): void => {
      // A commit from the page the guest is leaving is not where the node is going.
      if (!locator.isFollowing) latest.current.url = url
      locator.navigated(url)
      setPage((current) => ({ ...current, url }))
      syncHistory(target)
    }
    const listeners: Record<string, (event: Event) => void> = {
      // A load on a crashed guest (from the address bar) brings its process back.
      'did-start-loading': () => setPage((current) => ({ ...current, loading: true, failure: null, crashed: null })),
      'did-stop-loading': () => {
        setPage((current) => ({ ...current, loading: false }))
        syncHistory(target)
      },
      'did-navigate': (event) => {
        // Chromium resets page zoom when a document commits (it keeps zoom per host), including the first one,
        // which may commit after the zoom was set on the freshly callable guest.
        if (isCallable(target)) target.setZoomFactor(pageZoom(latest.current.zoom))
        navigated((event as WebviewNavigationEvent).url)
      },
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
      'render-process-gone': (event) => {
        const { reason } = (event as WebviewGoneEvent).details
        // Keep where the user was: the fresh guest starts there.
        locator.flush()
        setPage((current) => ({ ...current, loading: false, failure: null, crashed: { description: crashDescription(reason) } }))
      },
      'page-title-updated': (event) => setPage((current) => ({ ...current, title: (event as WebviewTitleEvent).title })),
      'dom-ready': () => {
        setReady(true)
        syncHistory(target)
        // Keys pressed inside the guest never reach this document, so Escape (plan §6: return control to the
        // canvas) is relayed from the page as a console message. The guest has no preload to do it otherwise.
        target
          .executeJavaScript(
            `addEventListener('keydown', (event) => { if (event.key === 'Escape') console.debug(${JSON.stringify(escapeSignal)}) }, true)`
          )
          .catch(ignore)
        if (latest.current.active) target.focus()
      },
      'console-message': (event) => {
        if ((event as WebviewConsoleEvent).message === escapeSignal && latest.current.active) canvas.setActiveNode(null)
      }
    }
    for (const [name, listener] of Object.entries(listeners)) target.addEventListener(name, listener)
    return () => {
      stopWaiting()
      for (const [name, listener] of Object.entries(listeners)) target.removeEventListener(name, listener)
      // This guest will not settle on anything any more; the next one starts at the latest address.
      if (wanted.current?.follow || locator.isFollowing) locator.followed(null)
      wanted.current = null
    }
  }, [guest, locator, syncHistory, canvas])

  // A zoom into preview unmounts the guest in the same commit, while `guest` still holds the detached element.
  useEffect(() => {
    if (attached) attached.setZoomFactor(pageZoom(zoom))
  }, [attached, zoom])

  // Activation hands keyboard focus to the page; deactivation returns it to the canvas.
  useEffect(() => {
    if (!attached) return
    if (active) attached.focus()
    else if (document.activeElement === attached) attached.blur()
  }, [active, attached])

  const crashed = page.crashed !== null
  const reload = useMemo(() => {
    if (!attached) return null
    if (!crashed) return () => attached.reload()
    return () => {
      setCallable(false)
      setReady(false)
      setPage((current) => ({ ...current, crashed: null, failure: null, loading: false, canGoBack: false, canGoForward: false }))
      setGuestKey((key) => key + 1)
    }
  }, [attached, crashed])
  useEffect(() => (reload ? registerReload(node.id, reload) : undefined), [node.id, reload])

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
    go({ url, follow: false })
  }

  const retry = (): void => {
    if (!attached) return
    const failed = page.failure?.url
    if (failed && normalizeWebAddress(failed)) attached.loadURL(failed).catch(ignore)
    else attached.reload()
  }

  const usable = attached !== null
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
            onClick={() => attached?.goBack()}
          >
            ←
          </button>
          <button
            type="button"
            className="cr-icon-button"
            aria-label="Forward"
            title="Forward"
            disabled={!usable || !page.canGoForward}
            onClick={() => attached?.goForward()}
          >
            →
          </button>
          {page.loading ? (
            <button type="button" className="cr-icon-button" aria-label="Stop" title="Stop" disabled={!usable} onClick={() => attached?.stop()}>
              ✕
            </button>
          ) : (
            <button
              type="button"
              className="cr-icon-button"
              aria-label="Reload"
              title="Reload"
              disabled={!usable}
              onClick={() => reload?.()}
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
            <Guest key={guestKey} initialUrl={latest.current.url} zoom={zoom} onElement={onElement} />
            {ready || (callable && !page.loading) ? null : (
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
        {live && page.crashed ? (
          <div className="webpage__failure" role="alert" data-testid="webpage-failure">
            <p className="webpage__failure-title">This page stopped working</p>
            <p className="webpage__failure-reason">{page.crashed.description}</p>
            <p className="mono webpage__failure-url">{page.url}</p>
            <button type="button" className="cr-button" onClick={() => reload?.()}>
              Reload
            </button>
          </div>
        ) : null}
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
