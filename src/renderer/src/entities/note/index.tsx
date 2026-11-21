import { useEffect, useRef, useState } from 'react'
import { NOTE_ENTITY, type NoteConfig } from '@shared/builtinEntities'
import { TextField } from '../../ui/fields'
import { defineEntityRenderer } from '../registry'
import type { EntityBodyProps, EntityCreateFormProps } from '../types'
import { initialNoteDraft, noteDraft, textToSave, type NoteDraft, type NoteDraftEvent } from './noteDraft'

const SAVE_DELAY_MS = 600

function NoteBody({ node, config, active, host }: EntityBodyProps<NoteConfig>): React.JSX.Element {
  // Kept in a ref as well, so saves issued in the same tick (blur, then deactivation) see each other.
  const state = useRef<NoteDraft>(initialNoteDraft(config.body))
  const [draft, setDraft] = useState(state.current)
  const apply = (event: NoteDraftEvent): void => {
    state.current = noteDraft(state.current, event)
    setDraft(state.current)
  }
  const context = useRef({ nodeId: node.id, title: node.title, host })
  context.current = { nodeId: node.id, title: node.title, host }
  const text = useRef<HTMLTextAreaElement>(null)

  const save = (): void => {
    const body = textToSave(state.current)
    if (body === null) return
    apply({ type: 'writing', body })
    const { nodeId, host: current } = context.current
    void current.execute({ type: 'updateNode', nodeId, patch: { config: { body } } }).then((response) => {
      if (!response.ok) apply({ type: 'write-failed', body })
    })
  }

  // Every pushed body reaches the draft, also while the user is in the note: unedited text follows it.
  useEffect(() => apply({ type: 'pushed', body: config.body }), [config.body])

  useEffect(() => {
    if (!active) return
    const timer = setTimeout(save, SAVE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [draft.text, active])

  useEffect(() => {
    if (active) text.current?.focus()
    else save()
  }, [active])

  useEffect(
    () => () => {
      const { dirty, conflict } = state.current
      if (dirty && conflict !== null) {
        context.current.host.notify(`Your unsaved edits to ${context.current.title} were not kept: the note changed elsewhere.`)
      } else save()
    },
    []
  )

  const resolve = (event: NoteDraftEvent): void => {
    apply(event)
    save()
  }

  return (
    <div className="note">
      {draft.conflict !== null ? (
        <div className="note-conflict" role="alert">
          <p className="note-conflict__message">This note changed elsewhere while you were editing it.</p>
          <p className="note-conflict__theirs" title={draft.conflict}>
            {draft.conflict || 'The note is now empty.'}
          </p>
          <div className="note-conflict__actions">
            <button type="button" className="cr-button" onClick={() => resolve({ type: 'take-theirs' })}>
              Take theirs
            </button>
            <button type="button" className="cr-button cr-button--primary" onClick={() => resolve({ type: 'keep-mine' })}>
              Keep mine
            </button>
          </div>
        </div>
      ) : null}
      <textarea
        ref={text}
        className="note-body"
        aria-label="Note text"
        value={draft.text}
        readOnly={!active}
        placeholder={active ? 'Write a note…' : 'Empty note. Click to write.'}
        onChange={(event) => apply({ type: 'edit', text: event.target.value })}
        onBlur={save}
      />
    </div>
  )
}

function NoteCreateForm({ formId, onSubmit }: EntityCreateFormProps): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  return (
    <form
      id={formId}
      className="entity-form"
      onSubmit={(event) => {
        event.preventDefault()
        const trimmed = title.trim()
        onSubmit({ entityType: NOTE_ENTITY, config: { body }, ...(trimmed ? { title: trimmed } : {}) })
      }}
    >
      <TextField label="Title" value={title} onChange={setTitle} placeholder="Note" autoFocus />
      <TextField label="Text" value={body} onChange={setBody} multiline />
    </form>
  )
}

export const noteRenderer = defineEntityRenderer<NoteConfig>({
  type: NOTE_ENTITY,
  icon: 'N',
  Body: NoteBody,
  CreateForm: NoteCreateForm
})
