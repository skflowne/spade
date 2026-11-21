import { createContext, useContext } from 'react'
import type { ConversationExpansionPreferences } from '@shared/domain'
import type { AnnotateHandler, SubmitHandler } from '../../rich'
import type { AnnotationStore } from './annotations'

// What every conversation item can use. Kept stable between renders except when its values change, so
// memoized item views re-render only for their own item or for a change that concerns them all.
export type ConversationServices = {
  expansion: ConversationExpansionPreferences
  annotations: AnnotationStore
  // Stable per answer key: an HTML answer's bridge calls become follow-up prompts (plan §11).
  answerHandlers(answerKey: string, title: string | null): { onSubmit: SubmitHandler; onAnnotate: AnnotateHandler }
  // Why HTML answer submissions cannot reach the agent right now; null when they can.
  submitBlocked: string | null
  subagentIds: ReadonlySet<string>
  openSubagent(subagentId: string): Promise<void>
  // Escape inside an HTML answer that the answer did not handle: hands input back to the canvas (plan §6).
  leaveAnswer(): void
}

export const ConversationContext = createContext<ConversationServices | null>(null)

export function useConversation(): ConversationServices {
  const services = useContext(ConversationContext)
  if (!services) throw new Error('Conversation items render only inside an agent conversation')
  return services
}
