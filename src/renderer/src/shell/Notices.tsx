import { useNotices, useSpadeStore } from '../store/hooks'
import { icons } from '../ui/icons'

// Startup problems and failed actions, each shown until the user dismisses it, and short-lived confirmations.
export function Notices(): React.JSX.Element {
  const store = useSpadeStore()
  const notices = useNotices()
  return (
    <section className="notices" aria-label="Notices">
      {notices.map((notice) => (
        <div key={notice.id} role={notice.kind === 'info' ? 'status' : 'alert'} className={`notice notice--${notice.kind}`}>
          <span className="notice__icon" aria-hidden="true">
            {notice.kind === 'info' ? <icons.info weight="fill" /> : <icons.problem weight="fill" />}
          </span>
          <p className="notice__message">{notice.message}</p>
          <div className="notice__actions">
            {notice.action ? (
              <button
                type="button"
                className="cr-button notice__action"
                onClick={() => {
                  store.dismissNotice(notice.id)
                  notice.action?.run()
                }}
              >
                {notice.action.label}
              </button>
            ) : null}
            <button
              type="button"
              className="cr-button cr-button--ghost notice__dismiss"
              onClick={() => store.dismissNotice(notice.id)}
            >
              Dismiss
            </button>
          </div>
        </div>
      ))}
    </section>
  )
}
