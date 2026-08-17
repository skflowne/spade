import { useCallback, useContext, useEffect, useState } from 'react'
import { BrowserCanvasContext } from './PrototypeContext'
import { PrototypeNodeFrame } from './PrototypeNodeFrame'
import type { PrototypeWebviewElement, WebviewNavigationEvent } from './prototype-api'

const issueUrl = 'https://github.com/skflowne/spade/issues/14'
const sessionMarker = 'spade-p2-session-marker-v1'

export function BrowserNode(): React.JSX.Element {
  const { parented, toggleParent } = useContext(BrowserCanvasContext)
  const [guest, setGuest] = useState<PrototypeWebviewElement | null>(null)
  const [guestRevision, setGuestRevision] = useState(1)
  const [url, setUrl] = useState(issueUrl)
  const [ready, setReady] = useState(false)
  const [history, setHistory] = useState({ back: false, forward: false })
  const [events, setEvents] = useState<string[]>([])

  const record = useCallback((message: string) => {
    setEvents((current) => [...current.slice(-14), message])
  }, [])

  useEffect(() => {
    if (!guest) return

    const loading = (): void => record('loading started')
    const loaded = (): void => record('loading stopped')
    const updateHistory = (): void => {
      setHistory({ back: guest.canGoBack(), forward: guest.canGoForward() })
    }
    const domReady = (): void => {
      setReady(true)
      updateHistory()
      record(`guest ${guestRevision} DOM ready`)
    }
    const focused = (): void => record('guest focused')
    const navigated = (event: Event): void => {
      const destination = (event as WebviewNavigationEvent).url
      setUrl(destination)
      updateHistory()
      record(`navigated: ${destination}`)
    }
    const failed = (event: Event): void => {
      const failure = event as Event & { errorDescription?: string }
      record(`load failed: ${failure.errorDescription ?? 'unknown error'}`)
    }

    guest.addEventListener('did-start-loading', loading)
    guest.addEventListener('did-stop-loading', loaded)
    guest.addEventListener('dom-ready', domReady)
    guest.addEventListener('focus', focused)
    guest.addEventListener('did-navigate', navigated)
    guest.addEventListener('did-navigate-in-page', navigated)
    guest.addEventListener('did-fail-load', failed)

    return () => {
      guest.removeEventListener('did-start-loading', loading)
      guest.removeEventListener('did-stop-loading', loaded)
      guest.removeEventListener('dom-ready', domReady)
      guest.removeEventListener('focus', focused)
      guest.removeEventListener('did-navigate', navigated)
      guest.removeEventListener('did-navigate-in-page', navigated)
      guest.removeEventListener('did-fail-load', failed)
    }
  }, [guest, guestRevision, record])

  const run = (action: () => void | Promise<unknown>): void => {
    try {
      void Promise.resolve(action()).catch((reason: unknown) => record(`error: ${String(reason)}`))
    } catch (reason) {
      record(`error: ${String(reason)}`)
    }
  }

  const writeSessionMarker = (): void => {
    if (!guest) return
    run(async () => {
      const origin = await guest.executeJavaScript<string>(
        `localStorage.setItem('spade-p2-session-marker', ${JSON.stringify(sessionMarker)}); location.origin`
      )
      record(`session marker written at ${origin}`)
    })
  }

  const readSessionMarker = (): void => {
    if (!guest) return
    run(async () => {
      const marker = await guest.executeJavaScript<string | null>(
        "localStorage.getItem('spade-p2-session-marker')"
      )
      record(`session marker: ${marker ?? 'missing'}`)
    })
  }

  return (
    <PrototypeNodeFrame title="GitHub guest" kind="Electron <webview> · persistent partition" resizable>
      <div className="browser-toolbar">
        <button type="button" onClick={() => guest?.goBack()} disabled={!history.back}>Back</button>
        <button type="button" onClick={() => guest?.goForward()} disabled={!history.forward}>Forward</button>
        <button type="button" onClick={() => guest?.reload()} disabled={!ready}>Reload</button>
        <button type="button" onClick={() => guest?.focus()} disabled={!ready}>Focus</button>
        <button
          type="button"
          onClick={() => {
            setReady(false)
            setHistory({ back: false, forward: false })
            setGuestRevision((current) => current + 1)
            record('guest remounted')
          }}
        >
          Remount
        </button>
        <button type="button" onClick={toggleParent}>{parented ? 'Detach from group' : 'Reparent into group'}</button>
      </div>
      <form
        className="browser-address"
        onSubmit={(event) => {
          event.preventDefault()
          if (guest) run(() => guest.loadURL(url))
        }}
      >
        <input aria-label="Guest URL" value={url} onChange={(event) => setUrl(event.target.value)} />
        <button type="submit">Go</button>
      </form>
      <div className="browser-probes">
        <button type="button" onClick={writeSessionMarker} disabled={!ready}>Write session marker</button>
        <button type="button" onClick={readSessionMarker} disabled={!ready}>Read session marker</button>
        <button
          type="button"
          disabled={!ready}
          onClick={() => {
            if (!guest) return
            record('popup requested; main policy keeps GitHub in this guest')
            run(() => guest.executeJavaScript("window.open('https://github.com/electron/electron/issues', '_blank')"))
          }}
        >
          Request popup
        </button>
      </div>
      <div className="browser-surface">
        <webview
          key={guestRevision}
          ref={(element) => setGuest(element as PrototypeWebviewElement | null)}
          src={issueUrl}
          partition="persist:spade-p2-github"
          allowpopups={'' as unknown as boolean}
        />
        <div className="stacking-probe">DOM stacking probe</div>
      </div>
      <ol className="browser-events" aria-label="Guest event log">
        {events.map((event, index) => <li key={`${index}-${event}`}>{event}</li>)}
      </ol>
    </PrototypeNodeFrame>
  )
}
