import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export type MenuItem =
  | {
      label: string
      onSelect(): void
      disabled?: boolean
      danger?: boolean
    }
  | 'separator'

type MenuButtonProps = {
  // Accessible name of the trigger button.
  label: string
  // Accessible name of the opened menu.
  menuLabel: string
  items: () => MenuItem[]
  children: ReactNode
  className?: string
  title?: string
}

const MENU_GAP = 4

// A button that opens a menu of actions. The menu renders in a portal at screen coordinates so it is never
// scaled by the canvas zoom or clipped by a node.
export function MenuButton(props: MenuButtonProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={props.className}
        aria-label={props.label}
        title={props.title ?? props.label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation()
          setOpen((current) => !current)
        }}
      >
        {props.children}
      </button>
      {open && trigger.current ? (
        <MenuPopup
          anchor={trigger.current}
          label={props.menuLabel}
          items={props.items()}
          onClose={(restoreFocus) => {
            setOpen(false)
            if (restoreFocus) trigger.current?.focus()
          }}
        />
      ) : null}
    </>
  )
}

function MenuPopup(props: {
  anchor: HTMLElement
  label: string
  items: MenuItem[]
  onClose(restoreFocus: boolean): void
}): React.JSX.Element {
  const menu = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const anchor = props.anchor.getBoundingClientRect()
    const own = menu.current!.getBoundingClientRect()
    const left = Math.max(MENU_GAP, Math.min(anchor.left, window.innerWidth - own.width - MENU_GAP))
    const below = anchor.bottom + MENU_GAP
    const top = below + own.height > window.innerHeight ? Math.max(MENU_GAP, anchor.top - own.height - MENU_GAP) : below
    setPosition({ left, top })
  }, [props.anchor])

  // Only once positioned: a hidden element cannot take focus.
  const positioned = position !== null
  useEffect(() => {
    if (positioned) menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
  }, [positioned])

  const { onClose, anchor } = props
  useEffect(() => {
    const dismiss = (event: PointerEvent): void => {
      const target = event.target as Node
      if (menu.current?.contains(target) || anchor.contains(target)) return
      onClose(false)
    }
    const blur = (): void => onClose(false)
    document.addEventListener('pointerdown', dismiss, true)
    window.addEventListener('blur', blur)
    return () => {
      document.removeEventListener('pointerdown', dismiss, true)
      window.removeEventListener('blur', blur)
    }
  }, [onClose, anchor])

  const moveFocus = (step: number): void => {
    const items = [...menu.current!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')]
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    items[(index + step + items.length) % items.length]?.focus()
  }

  return createPortal(
    <div
      ref={menu}
      role="menu"
      aria-label={props.label}
      className="cr-menu"
      style={position ? { left: position.left, top: position.top } : { visibility: 'hidden' }}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Escape') props.onClose(true)
        else if (event.key === 'ArrowDown') moveFocus(1)
        else if (event.key === 'ArrowUp') moveFocus(-1)
        else if (event.key === 'Tab') props.onClose(false)
        else return
        event.preventDefault()
      }}
    >
      {props.items.map((item, index) =>
        item === 'separator' ? (
          <div key={`separator-${index}`} role="separator" className="cr-menu__separator" />
        ) : (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            className={item.danger ? 'cr-menu__item cr-menu__item--danger' : 'cr-menu__item'}
            onClick={() => {
              props.onClose(false)
              item.onSelect()
            }}
          >
            {item.label}
          </button>
        )
      )}
    </div>,
    document.body
  )
}
