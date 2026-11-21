import type { ConversationItem } from '../../../../shared/agents'
import type { ConversationExpansionPreferences } from '../../../../shared/domain'

// Conversation expansion preferences (plan §7.1): global defaults, an optional per-conversation override,
// and per-pane toggles that never change either.

export type PaneKind = keyof ConversationExpansionPreferences
export type ExpansionOverride = Partial<ConversationExpansionPreferences>

export const PANE_KINDS: ReadonlyArray<{ kind: PaneKind; label: string }> = [
  { kind: 'toolCall', label: 'Tool calls' },
  { kind: 'read', label: 'File reads' },
  { kind: 'diff', label: 'Edits with diffs' },
  { kind: 'thinking', label: 'Thinking' },
  { kind: 'html', label: 'HTML answers' }
]

export function effectiveExpansion(
  global: ConversationExpansionPreferences,
  override: ExpansionOverride | undefined
): ConversationExpansionPreferences {
  return { ...global, ...override }
}

// The preference that decides an item's initial expansion; null for items that are never collapsed.
export function paneKindOf(item: ConversationItem): PaneKind | null {
  if (item.kind === 'thinking') return 'thinking'
  if (item.kind !== 'tool-call') return null
  if (item.toolKind === 'read') return 'read'
  if (item.toolKind === 'edit' && item.diff !== null) return 'diff'
  return 'toolCall'
}

// Sets one key of the override. A value equal to the global one is dropped so the key keeps following
// the global preference; an empty override is undefined.
export function withOverride(
  override: ExpansionOverride | undefined,
  kind: PaneKind,
  value: boolean,
  global: ConversationExpansionPreferences
): ExpansionOverride | undefined {
  const next: ExpansionOverride = { ...override }
  if (value === global[kind]) delete next[kind]
  else next[kind] = value
  return Object.keys(next).length > 0 ? next : undefined
}
