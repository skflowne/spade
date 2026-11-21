import { useNotices, useSpadeStore } from '../store/hooks'

// Startup problems and failed actions, each shown until the user dismisses it.
export function Notices(): React.JSX.Element {
  const store = useSpadeStore()
  const notices = useNotices()
  return (
    <section className="notices" aria-label="Notices">
      {notices.map((notice) => (
        <div key={notice.id} role="alert" className={`notice notice--${notice.kind}`}>
          <span className="notice__icon" aria-hidden="true">
            !
          </span>
          <p className="notice__message">{notice.message}</p>
          <button type="button" className="cr-button cr-button--ghost notice__dismiss" onClick={() => store.dismissNotice(notice.id)}>
            Dismiss
          </button>
        </div>
      ))}
    </section>
  )
}
