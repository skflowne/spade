import type { RelatedDirection } from './relatedNodes'

// Canvas keyboard shortcuts. Navigation chords all use Alt so they never collide with text editing; the
// sibling keys match the physical bracket keys whatever the keyboard layout prints on them.

export type CanvasShortcut =
  | { kind: 'search' }
  | { kind: 'history'; step: -1 | 1 }
  | { kind: 'related'; direction: RelatedDirection }

export type KeyChord = {
  key: string
  code: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

export function canvasShortcut(chord: KeyChord): CanvasShortcut | null {
  const { altKey, ctrlKey, metaKey, shiftKey } = chord
  if ((ctrlKey || metaKey) && !altKey && !shiftKey) {
    const key = chord.key.toLowerCase()
    return key === 'k' || key === 'f' ? { kind: 'search' } : null
  }
  if (!altKey || ctrlKey || metaKey || shiftKey) return null
  switch (chord.code) {
    case 'ArrowLeft':
      return { kind: 'history', step: -1 }
    case 'ArrowRight':
      return { kind: 'history', step: 1 }
    case 'ArrowUp':
      return { kind: 'related', direction: 'parent' }
    case 'ArrowDown':
      return { kind: 'related', direction: 'first-child' }
    case 'BracketLeft':
      return { kind: 'related', direction: 'previous-sibling' }
    case 'BracketRight':
      return { kind: 'related', direction: 'next-sibling' }
    default:
      return null
  }
}

// What the Keyboard shortcuts popover lists, in order.
export const SHORTCUT_HELP: ReadonlyArray<{ keys: string[]; action: string }> = [
  { keys: ['Ctrl', 'K'], action: 'Search nodes (also Ctrl+F)' },
  { keys: ['Alt', '←'], action: 'Back to the previous focus' },
  { keys: ['Alt', '→'], action: 'Forward' },
  { keys: ['Alt', '↑'], action: 'Go to the parent' },
  { keys: ['Alt', '↓'], action: 'Go to the first child' },
  { keys: ['Alt', '['], action: 'Previous sibling' },
  { keys: ['Alt', ']'], action: 'Next sibling' },
  { keys: ['Tab'], action: "Move between nodes' headers" },
  { keys: ['Enter'], action: "Use the focused node's content" },
  { keys: ['Esc'], action: 'Give input back to the canvas' }
]
