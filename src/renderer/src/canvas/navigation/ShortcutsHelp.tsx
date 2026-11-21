import { useEffect, useId, useRef, useState } from 'react'
import { SHORTCUT_HELP } from '../model/shortcuts'

// A small popover listing the canvas keyboard shortcuts.
export function ShortcutsHelp(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const popoverId = useId()
  const titleId = useId()

  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', dismiss, true)
    return () => document.removeEventListener('pointerdown', dismiss, true)
  }, [open])

  return (
    <div
      ref={root}
      className="shortcuts-help"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open) return
        event.preventDefault()
        setOpen(false)
        trigger.current?.focus()
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="cr-icon-button"
        aria-label="Keyboard shortcuts"
        title="Keyboard shortcuts"
        aria-expanded={open}
        aria-controls={popoverId}
        onClick={() => setOpen((current) => !current)}
      >
        ?
      </button>
      {open ? (
        <div id={popoverId} className="shortcuts-help__popover" role="dialog" aria-labelledby={titleId}>
          <h2 id={titleId}>Keyboard shortcuts</h2>
          <dl className="shortcuts-help__list">
            {SHORTCUT_HELP.map((entry) => (
              <div key={entry.action} className="shortcuts-help__row">
                <dt>
                  {entry.keys.map((key, index) => (
                    <span key={key}>
                      {index > 0 ? <span className="shortcuts-help__plus">+</span> : null}
                      <kbd>{key}</kbd>
                    </span>
                  ))}
                </dt>
                <dd>{entry.action}</dd>
              </div>
            ))}
          </dl>
          <p className="shortcuts-help__note">Navigation keys act on the selected node while no node's content is in use.</p>
        </div>
      ) : null}
    </div>
  )
}
