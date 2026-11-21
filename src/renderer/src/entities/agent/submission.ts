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
