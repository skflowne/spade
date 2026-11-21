import type { SpadeSubmitInput } from '../../../../shared/richBlocks'
import type { AnnotationStore } from './annotations'

// How an HTML answer's `window.spade.submit` reaches the agent (plan §11): an explicit follow-up prompt,
// never a direct change to the conversation.

export type PendingAnnotation = { id: string; target?: string; text: string; data?: unknown }

export type Submission = {
  // The answer's title, when the agent gave one.
  title: string | null
  message?: string
  data?: unknown
  annotations: readonly PendingAnnotation[]
}

export function formatSubmission(submission: Submission): string {
  const lines = [
    submission.title ? `[Submitted from the HTML answer “${submission.title}”]` : '[Submitted from an HTML answer]'
  ]
  const message = submission.message?.trim()
  if (message) lines.push(message)
  if (submission.data !== undefined) lines.push(`Data: ${json(submission.data)}`)
  if (submission.annotations.length > 0) {
    lines.push('Annotations:')
    for (const annotation of submission.annotations) lines.push(`- ${describeAnnotation(annotation)}`)
  }
  return lines.join('\n')
}

export function describeAnnotation(annotation: PendingAnnotation): string {
  const target = annotation.target ? `[${annotation.target}] ` : ''
  const data = annotation.data === undefined ? '' : ` ${json(annotation.data)}`
  return `${target}${annotation.text}${data}`
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

export type AnswerSubmitter = (answerKey: string, title: string | null, input: SpadeSubmitInput) => Promise<void>

// Sends an answer's submission with its pending annotations as one prompt. One submission per answer is in
// flight at a time; it takes the annotations when it starts and puts them back if the prompt fails.
export function createAnswerSubmitter(dependencies: {
  annotations: AnnotationStore
  // Why the agent cannot be prompted right now; null when it can.
  blocked(): string | null
  // Resolves with the failure message, or null when the agent accepted the prompt.
  prompt(text: string): Promise<string | null>
}): AnswerSubmitter {
  const inFlight = new Set<string>()
  return async (answerKey, title, input) => {
    const reason = dependencies.blocked()
    if (reason) throw new Error(reason)
    if (inFlight.has(answerKey)) throw new Error('The previous submission from this answer is still being sent.')
    inFlight.add(answerKey)
    const sent = dependencies.annotations.take(answerKey)
    try {
      const problem = await dependencies.prompt(formatSubmission({ title, ...input, annotations: sent }))
      if (problem !== null) throw new Error(problem)
    } catch (error) {
      dependencies.annotations.restore(answerKey, sent)
      throw error
    } finally {
      inFlight.delete(answerKey)
    }
  }
}
