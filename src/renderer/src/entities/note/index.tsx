import { useEffect, useRef, useState } from 'react'
import { NOTE_ENTITY, type NoteConfig } from '@shared/builtinEntities'
import { TextField } from '../../ui/fields'
import { defineEntityRenderer } from '../registry'
import type { EntityBodyProps, EntityCreateFormProps } from '../types'

const SAVE_DELAY_MS = 600

function NoteBody({ node, config, active, host }: EntityBodyProps<NoteConfig>): React.JSX.Element {
  const [draft, setDraft] = useState(config.body)
  const latest = useRef({ draft, saved: config.body, active, nodeId: node.id, host })
  latest.current.draft = draft
  latest.current.active = active
  latest.current.nodeId = node.id
  latest.current.host = host
  const text = useRef<HTMLTextAreaElement>(null)

  const save = (): void => {
    const { draft: body, saved, nodeId, host: current } = latest.current
    if (body === saved) return
    latest.current.saved = body
    void current.execute({ type: 'updateNode', nodeId, patch: { config: { body } } })
  }

  // A pushed change (another window, an agent) replaces the text unless the user is editing it.
  useEffect(() => {
    latest.current.saved = config.body
    if (!latest.current.active) setDraft(config.body)
  }, [config.body])

  useEffect(() => {
    if (!active) return
    const timer = setTimeout(save, SAVE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [draft, active])

  useEffect(() => {
    if (active) text.current?.focus()
    else save()
  }, [active])

  useEffect(() => save, [])

  return (
    <textarea
      ref={text}
      className="note-body"
      aria-label="Note text"
      value={draft}
      readOnly={!active}
      placeholder={active ? 'Write a note…' : 'Empty note. Click to write.'}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={save}
    />
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
