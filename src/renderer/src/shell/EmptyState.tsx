import { useSpadeStore } from '../store/hooks'

export function EmptyState(): React.JSX.Element {
  const store = useSpadeStore()
  return (
    <div className="empty-state" data-testid="empty-state">
      <div className="empty-state__panel" role="region" aria-labelledby="empty-state-title">
        <p className="eyebrow">No project yet</p>
        <h1 id="empty-state-title">Open a project</h1>
        <p>
          A project is a directory and its own canvas. SPADE keeps the canvas in its application data and never
          writes into the directory.
        </p>
        <button type="button" className="cr-button cr-button--primary" onClick={() => void store.openProject()}>
          Open project…
        </button>
      </div>
    </div>
  )
}
