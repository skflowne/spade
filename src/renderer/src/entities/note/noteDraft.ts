// The note text the user sees against the body the record holds. The record can change at any time (an agent,
// the CLI); the user's text is written back only when the user edited it, and a change from elsewhere never
// silently replaces unsaved edits nor gets silently overwritten by them.

export type NoteDraft = {
  // What the text area shows.
  text: string
  // The body of the record, as last pushed.
  record: string
  // The text holds edits the record does not have yet.
  dirty: boolean
  // A body that arrived from elsewhere while the text held unsaved edits, until the user keeps theirs or takes it.
  conflict: string | null
  // Bodies this note wrote whose push has not come back yet, oldest first.
  writes: readonly string[]
}

export type NoteDraftEvent =
  | { type: 'edit'; text: string }
  | { type: 'pushed'; body: string }
  | { type: 'writing'; body: string }
  | { type: 'write-failed'; body: string }
  | { type: 'keep-mine' }
  | { type: 'take-theirs' }

export function initialNoteDraft(body: string): NoteDraft {
  return { text: body, record: body, dirty: false, conflict: null, writes: [] }
}

export function noteDraft(draft: NoteDraft, event: NoteDraftEvent): NoteDraft {
  switch (event.type) {
    case 'edit':
      return { ...draft, text: event.text, dirty: event.text !== draft.record }
    case 'writing':
      return { ...draft, writes: [...draft.writes, event.body] }
    case 'write-failed':
      return { ...draft, writes: draft.writes.filter((body) => body !== event.body) }
    case 'keep-mine':
      return { ...draft, conflict: null }
    case 'take-theirs':
      return draft.conflict === null
        ? draft
        : { ...draft, text: draft.conflict, dirty: draft.conflict !== draft.record, conflict: null }
    case 'pushed':
      return pushed(draft, event.body)
  }
}

function pushed(draft: NoteDraft, body: string): NoteDraft {
  const own = draft.writes.indexOf(body)
  if (own !== -1) {
    // This note's own write coming back, with any older ones it superseded.
    return { ...draft, record: body, dirty: draft.text !== body, writes: draft.writes.slice(own + 1) }
  }
  if (body === draft.record) return draft
  if (!draft.dirty || draft.text === body) return { ...draft, text: body, record: body, dirty: false, conflict: null }
  return { ...draft, record: body, conflict: body }
}

// The text to write now, or null: nothing edited, already on its way, or waiting for the user's choice.
export function textToSave(draft: NoteDraft): string | null {
  if (!draft.dirty || draft.conflict !== null) return null
  if (draft.writes.at(-1) === draft.text) return null
  return draft.text
}
