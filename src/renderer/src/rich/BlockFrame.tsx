import type { ReactNode } from 'react'
import './rich.css'

type BlockFrameProps = {
  // Short metadata label, e.g. the code language.
  label: string
  title?: string | null
  actions?: ReactNode
  className?: string
  children: ReactNode
}

// Shared chrome for code, diagram, and HTML answer blocks.
export function BlockFrame({ label, title, actions, className, children }: BlockFrameProps): React.JSX.Element {
  return (
    <figure className={className ? `rich-block ${className}` : 'rich-block'}>
      <figcaption className="rich-block__header">
        <span className="rich-block__label">{label}</span>
        {title ? <span className="rich-block__title">{title}</span> : null}
        {actions ? <span className="rich-block__actions">{actions}</span> : null}
      </figcaption>
      {children}
    </figure>
  )
}

type BlockActionProps = {
  onClick: () => void
  disabled?: boolean
  pressed?: boolean
  children: ReactNode
}

export function BlockAction({ onClick, disabled, pressed, children }: BlockActionProps): React.JSX.Element {
  return (
    <button type="button" className="rich-block__action" onClick={onClick} disabled={disabled} aria-pressed={pressed}>
      {children}
    </button>
  )
}
