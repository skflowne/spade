import { useCallback, useEffect, useRef, useState } from 'react'
import { GITHUB_ISSUE_URL, GITHUB_PARTITION } from '../../shared/constants'
import { readGitHubAuthentication } from './guestWebview'
import { PrototypeNodeFrame } from './PrototypeNodeFrame'
import type { PrototypeWebviewElement } from './prototype-api'

const guestTargets = [
  GITHUB_ISSUE_URL,
  'https://github.com/electron/electron',
  'https://github.com/electron/electron/issues',
  'https://github.com/electron/electron/pulls'
]

const resizePatterns = [
  { width: 1024, height: 640 },
  { width: 1280, height: 720 },
  { width: 800, height: 600 }
]

type StressGuestProps = {
  id: number
  revision: number
  url: string
  authStatus: string
  onGuestChange: (id: number, guest: PrototypeWebviewElement | null) => void
}

function StressGuest({
  id,
  revision,
  url,
  authStatus,
  onGuestChange
}: StressGuestProps): React.JSX.Element {
  const surfaceRef = useRef<HTMLDivElement>(null)
  const [guest, setGuest] = useState<PrototypeWebviewElement | null>(null)
  const [activity, setActivity] = useState('loading')
  const [surfaceSize, setSurfaceSize] = useState({ width: 0, height: 0, count: 0 })
  const attachGuest = useCallback((element: HTMLElement | null) => {
    setGuest(element as PrototypeWebviewElement | null)
  }, [])

  useEffect(() => {
    onGuestChange(id, guest)
    if (!guest) return

    const ready = (): void => setActivity('ready')
    const failed = (): void => setActivity('load failed')
    const gone = (): void => setActivity('renderer gone')
    guest.addEventListener('dom-ready', ready)
    guest.addEventListener('did-fail-load', failed)
    guest.addEventListener('render-process-gone', gone)

    return () => {
      guest.removeEventListener('dom-ready', ready)
      guest.removeEventListener('did-fail-load', failed)
      guest.removeEventListener('render-process-gone', gone)
      onGuestChange(id, null)
    }
  }, [guest, id, onGuestChange])

  useEffect(() => {
    const surface = surfaceRef.current
    if (!surface) return
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.round(entry.contentRect.width)
      const height = Math.round(entry.contentRect.height)
      setSurfaceSize((current) => current.width === width && current.height === height
        ? current
        : { width, height, count: current.count + 1 })
    })
    observer.observe(surface)
    return () => observer.disconnect()
  }, [])

  return (
    <section className="stress-guest">
      <header>
        <strong>Guest {id + 1}</strong>
        <span>{activity} · {surfaceSize.count} resizes</span>
        <small>{authStatus}</small>
      </header>
      <div ref={surfaceRef} className="stress-guest__surface">
        <webview
          key={`${id}-${revision}`}
          ref={attachGuest}
          src={url}
          partition={GITHUB_PARTITION}
        />
      </div>
    </section>
  )
}

export function BrowserStressNode(): React.JSX.Element {
  const guests = useRef(new Map<number, PrototypeWebviewElement>())
  const [guestCount, setGuestCount] = useState(20)
  const [revision, setRevision] = useState(1)
  const [resizeRunning, setResizeRunning] = useState(false)
  const [resizePhase, setResizePhase] = useState(0)
  const [authStatuses, setAuthStatuses] = useState<Record<number, string>>({})

  const onGuestChange = useCallback((id: number, guest: PrototypeWebviewElement | null) => {
    if (guest) guests.current.set(id, guest)
    else guests.current.delete(id)
  }, [])

  useEffect(() => {
    if (!resizeRunning) return
    const interval = window.setInterval(() => {
      setResizePhase((phase) => (phase + 1) % resizePatterns.length)
    }, 1200)
    return () => window.clearInterval(interval)
  }, [resizeRunning])

  const checkAuthentication = (): void => {
    const mountedGuests = [...guests.current.entries()]
    setAuthStatuses(Object.fromEntries(mountedGuests.map(([id]) => [id, 'checking…'])))
    void Promise.all(mountedGuests.map(async ([id, guest]) => {
      try {
        const authentication = await readGitHubAuthentication(guest)
        return [
          id,
          authentication.login ? `@${authentication.login}` : 'signed out'
        ] as const
      } catch (reason) {
        return [id, `check failed: ${String(reason)}`] as const
      }
    })).then((statuses) => setAuthStatuses(Object.fromEntries(statuses)))
  }

  const toggleResizeLoop = (): void => {
    if (resizeRunning) setResizePhase(0)
    setResizeRunning((running) => !running)
  }

  const pattern = resizePatterns[resizePhase]
  return (
    <PrototypeNodeFrame
      title="Multi-webview stress lab"
      kind={`${guestCount} guests · ${pattern.width}×${pattern.height} viewport · shared GitHub session`}
    >
      <div className="stress-toolbar">
        <label>
          Guests
          <select
            value={guestCount}
            onChange={(event) => {
              setGuestCount(Number(event.target.value))
              setResizePhase(0)
              setAuthStatuses({})
            }}
          >
            {[1, 4, 8, 12, 16, 20].map((count) => <option key={count}>{count}</option>)}
          </select>
        </label>
        <button type="button" onClick={toggleResizeLoop}>
          {resizeRunning ? 'Stop and reset layout' : 'Start resize loop'}
        </button>
        <button type="button" onClick={() => setResizePhase((phase) => (phase + 1) % resizePatterns.length)}>
          Resize once
        </button>
        <button type="button" onClick={() => setRevision((current) => current + 1)}>
          Remount all
        </button>
        <button type="button" onClick={checkAuthentication}>
          Check shared auth
        </button>
      </div>
      <p className="stress-guidance">
        Each guest keeps a real page viewport while canvas zoom changes only its presentation. Sign in through the large guest, check shared auth, then run the resize loop through 1024×640, 1280×720, and 800×600.
      </p>
      <div
        className="stress-grid"
        style={{
          gridTemplateColumns: `repeat(5, ${pattern.width + 2}px)`,
          gridAutoRows: `${pattern.height + 36}px`
        }}
      >
        {Array.from({ length: guestCount }, (_, id) => (
          <StressGuest
            key={`${id}-${revision}`}
            id={id}
            revision={revision}
            url={guestTargets[id % guestTargets.length]}
            authStatus={authStatuses[id] ?? 'auth not checked'}
            onGuestChange={onGuestChange}
          />
        ))}
      </div>
    </PrototypeNodeFrame>
  )
}
