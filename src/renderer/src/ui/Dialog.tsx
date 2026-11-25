import { useId, useLayoutEffect, useRef, type ReactNode } from 'react'

type DialogProps = {
  open: boolean
  title: string
  // Escape, or the dialog's own cancel button.
  onCancel(): void
  children?: ReactNode
  footer: ReactNode
  // An alertdialog asks to confirm a consequential action.
  alert?: boolean
  description?: ReactNode
  wide?: boolean
}

// A modal native <dialog>: focus moves into it, the rest of the window is inert, and Escape cancels.
// Closing keeps its content mounted, so a dialog can step aside (e.g. while the user picks a node) and return.
export function Dialog(props: DialogProps): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const descriptionId = useId()

  useLayoutEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (props.open && !dialog.open) dialog.showModal()
    if (!props.open && dialog.open) dialog.close()
  }, [props.open])

  return (
    <dialog
      ref={ref}
      className={props.wide ? 'cr-dialog cr-dialog--wide' : 'cr-dialog'}
      role={props.alert ? 'alertdialog' : undefined}
      aria-labelledby={titleId}
      aria-describedby={props.description ? descriptionId : undefined}
      onCancel={(event) => {
        event.preventDefault()
        props.onCancel()
      }}
    >
      <header className="cr-dialog__header">
        <h2 id={titleId}>{props.title}</h2>
      </header>
      {props.description ? (
        <div id={descriptionId} className="cr-dialog__description">
          {props.description}
        </div>
      ) : null}
      {props.children ? <div className="cr-dialog__body">{props.children}</div> : null}
      <footer className="cr-dialog__footer">{props.footer}</footer>
    </dialog>
  )
}
