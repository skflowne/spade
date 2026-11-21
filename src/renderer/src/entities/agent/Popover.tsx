import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

type PopoverProps = {
  anchor: HTMLElement
  // Accessible name of the popover.
  label: string
  onClose(): void
  children: ReactNode
  className?: string
}

const GAP = 4

// A small non-modal dialog anchored to an element. It renders in a portal at screen coordinates, so the
// canvas zoom never scales it and an inactive (inert) node body never disables it. Escape and a click
// elsewhere close it; Escape returns focus to the anchor and never also deactivates the node.
export function Popover({ anchor, label, onClose, children, className }: PopoverProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const latestClose = useRef(onClose)
  latestClose.current = onClose

  useLayoutEffect(() => {
    const place = (): void => {
      const box = anchor.getBoundingClientRect()
      const own = ref.current!.getBoundingClientRect()
      const left = Math.max(GAP, Math.min(box.left, window.innerWidth - own.width - GAP))
      const below = box.bottom + GAP
      const top = below + own.height > window.innerHeight ? Math.max(GAP, box.top - own.height - GAP) : below
      setPosition({ left, top })
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(ref.current!)
    return () => observer.disconnect()
  }, [anchor])

  const positioned = position !== null
  useEffect(() => {
    if (positioned) ref.current?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled)')?.focus()
  }, [positioned])

  useEffect(() => {
    const dismiss = (event: PointerEvent): void => {
      const target = event.target as Node
      if (ref.current?.contains(target) || anchor.contains(target)) return
      latestClose.current()
    }
    // Wherever focus is: a disabled button the user just pressed leaves it on the document body.
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      const hadFocus = ref.current?.contains(document.activeElement) || document.activeElement === document.body
      latestClose.current()
      if (hadFocus && anchor.isConnected) anchor.focus()
    }
    document.addEventListener('pointerdown', dismiss, true)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('pointerdown', dismiss, true)
      document.removeEventListener('keydown', escape, true)
    }
  }, [anchor])

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      className={className ? `agent-popover ${className}` : 'agent-popover'}
      style={position ? { left: position.left, top: position.top } : { visibility: 'hidden' }}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {children}
    </div>,
    document.body
  )
}
