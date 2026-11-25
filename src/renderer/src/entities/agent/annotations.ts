import { useSyncExternalStore } from 'react'
import type { PendingAnnotation } from './submission'

// Annotations made inside one conversation's HTML answers, per answer, until that answer submits.
// An external store so adding one re-renders only its answer, not the whole conversation.
export class AnnotationStore {
  private readonly byAnswer = new Map<string, readonly PendingAnnotation[]>()
  private readonly listeners = new Set<() => void>()
  private counter = 0

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get(answerKey: string): readonly PendingAnnotation[] {
    return this.byAnswer.get(answerKey) ?? NONE
  }

  add(answerKey: string, annotation: Omit<PendingAnnotation, 'id'>): void {
    this.counter += 1
    this.set(answerKey, [...this.get(answerKey), { ...annotation, id: String(this.counter) }])
  }

  remove(answerKey: string, id: string): void {
    this.set(
      answerKey,
      this.get(answerKey).filter((annotation) => annotation.id !== id)
    )
  }

  // Removes and returns an answer's annotations, so a submission carries them exactly once.
  take(answerKey: string): readonly PendingAnnotation[] {
    const taken = this.get(answerKey)
    if (taken.length > 0) this.set(answerKey, NONE)
    return taken
  }

  // Puts back the annotations of a submission that failed, ahead of any added meanwhile.
  restore(answerKey: string, taken: readonly PendingAnnotation[]): void {
    if (taken.length > 0) this.set(answerKey, [...taken, ...this.get(answerKey)])
  }

  private set(answerKey: string, annotations: readonly PendingAnnotation[]): void {
    if (annotations.length === 0) this.byAnswer.delete(answerKey)
    else this.byAnswer.set(answerKey, annotations)
    for (const listener of this.listeners) listener()
  }
}

const NONE: readonly PendingAnnotation[] = []

export function useAnnotations(store: AnnotationStore, answerKey: string): readonly PendingAnnotation[] {
  return useSyncExternalStore(store.subscribe, () => store.get(answerKey))
}
