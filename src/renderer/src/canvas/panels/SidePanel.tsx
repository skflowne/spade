import { useEffect, useState, type ReactNode } from 'react'
import { useCanvasActions } from '../CanvasContext'

// The frame of a canvas side panel: a labelled region with a title, optional tools, and a close button.
export function SidePanel(props: { title: string; tools?: ReactNode; children: ReactNode }): React.JSX.Element {
  const actions = useCanvasActions()
  return (
    <section className="side-panel" role="region" aria-label={props.title}>
      <header className="side-panel__header">
        <h2>{props.title}</h2>
        <button
          type="button"
          className="cr-icon-button"
          aria-label={`Close ${props.title}`}
          title={`Close ${props.title}`}
          onClick={actions.closePanel}
        >
          ×
        </button>
      </header>
      {props.tools ? <div className="side-panel__tools">{props.tools}</div> : null}
      <div className="side-panel__body">{props.children}</div>
    </section>
  )
}

// The current time, refreshed every `intervalMs`, for relative times that age while shown.
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}
