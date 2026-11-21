import { expect, test } from '@playwright/test'
import { initialNoteDraft, noteDraft, textToSave, type NoteDraft, type NoteDraftEvent } from '../../src/renderer/src/entities/note/noteDraft'

const run = (start: NoteDraft, ...events: NoteDraftEvent[]): NoteDraft => events.reduce(noteDraft, start)

test.describe('note draft', () => {
  test('never writes text the user only read', () => {
    const draft = initialNoteDraft('Agent wrote this')
    expect(textToSave(draft)).toBeNull()
    expect(textToSave(run(draft, { type: 'pushed', body: 'Then changed it' }))).toBeNull()
  })

  test('takes a pushed body while it has no unsaved edits, whether or not the user is in it', () => {
    const draft = run(initialNoteDraft('First'), { type: 'pushed', body: 'Changed elsewhere' })
    expect(draft.text).toBe('Changed elsewhere')
    expect(draft.dirty).toBe(false)
    expect(draft.conflict).toBeNull()
    expect(textToSave(draft)).toBeNull()
  })

  test('saves an edit once and recognizes its own write coming back', () => {
    let draft = run(initialNoteDraft('First'), { type: 'edit', text: 'First, edited' })
    expect(draft.dirty).toBe(true)
    expect(textToSave(draft)).toBe('First, edited')
    draft = run(draft, { type: 'writing', body: 'First, edited' })
    expect(textToSave(draft)).toBeNull()

    // The user keeps typing while the write is on its way: its echo is no conflict.
    draft = run(draft, { type: 'edit', text: 'First, edited more' }, { type: 'pushed', body: 'First, edited' })
    expect(draft.conflict).toBeNull()
    expect(draft.text).toBe('First, edited more')
    expect(textToSave(draft)).toBe('First, edited more')

    draft = run(draft, { type: 'writing', body: 'First, edited more' }, { type: 'pushed', body: 'First, edited more' })
    expect(draft.dirty).toBe(false)
    expect(textToSave(draft)).toBeNull()
  })

  test('tries a failed write again with the next save', () => {
    const draft = run(
      initialNoteDraft('First'),
      { type: 'edit', text: 'Mine' },
      { type: 'writing', body: 'Mine' },
      { type: 'write-failed', body: 'Mine' }
    )
    expect(draft.dirty).toBe(true)
    expect(textToSave(draft)).toBe('Mine')
  })

  test('keeps unsaved edits when another body arrives, and holds every write until the user chooses', () => {
    const conflicted = run(initialNoteDraft('First'), { type: 'edit', text: 'Mine' }, { type: 'pushed', body: 'Theirs' })
    expect(conflicted.text).toBe('Mine')
    expect(conflicted.conflict).toBe('Theirs')
    expect(textToSave(conflicted)).toBeNull()

    const kept = run(conflicted, { type: 'keep-mine' })
    expect(kept.conflict).toBeNull()
    expect(kept.text).toBe('Mine')
    expect(textToSave(kept)).toBe('Mine')

    const taken = run(conflicted, { type: 'take-theirs' })
    expect(taken.conflict).toBeNull()
    expect(taken.text).toBe('Theirs')
    expect(textToSave(taken)).toBeNull()
  })

  test('shows the newest other body when several arrive during a conflict', () => {
    const draft = run(
      initialNoteDraft('First'),
      { type: 'edit', text: 'Mine' },
      { type: 'pushed', body: 'Theirs' },
      { type: 'pushed', body: 'Theirs again' }
    )
    expect(draft.conflict).toBe('Theirs again')
  })

  test('ends the conflict when the other body matches the edit', () => {
    const draft = run(initialNoteDraft('First'), { type: 'edit', text: 'Same' }, { type: 'pushed', body: 'Same' })
    expect(draft.conflict).toBeNull()
    expect(draft.dirty).toBe(false)
  })

  test('writes their text back when the user takes it after an earlier save of theirs landed over it', () => {
    // The user's save was already on its way when the other change arrived, and lands after it.
    const draft = run(
      initialNoteDraft('First'),
      { type: 'edit', text: 'Mine' },
      { type: 'writing', body: 'Mine' },
      { type: 'pushed', body: 'Theirs' },
      { type: 'pushed', body: 'Mine' }
    )
    expect(draft.conflict).toBe('Theirs')
    const taken = run(draft, { type: 'take-theirs' })
    expect(taken.text).toBe('Theirs')
    expect(textToSave(taken)).toBe('Theirs')
    expect(textToSave(run(draft, { type: 'keep-mine' }))).toBeNull()
  })
})
