import type { ConversationItem } from '../../../../shared/agents'
import { AnnotationStore } from './annotations'
import type { TimelineState } from './timeline'

// What one agent node's conversation UI keeps while its body is not mounted: below the level-of-detail zoom
// and while the node is collapsed, the body unmounts, and remounting must bring the conversation back as the
// user left it. Kept per node id for the renderer's lifetime, until the node is removed from its canvas.

export type ScrollPosition = { top: number; atBottom: boolean }

export class NodeConversationState {
  draft = ''
  // Node ids shared with the next prompt.
  context: readonly string[] = []
  readonly annotations = new AnnotationStore()
  // The loaded part of the conversation: the newest page plus any older pages the user asked for.
  timeline: TimelineState | null = null
  // True until a newest page was read, and again when the conversation changed since the last read.
  stale = true
  scroll: ScrollPosition | null = null
  // The last assistant message with text seen in any page, for the preview: the newest page may hold only
  // tool calls.
  lastAnswer: Extract<ConversationItem, { kind: 'assistant-message' }> | null = null

  setTimeline(timeline: TimelineState): void {
    this.timeline = timeline
    this.stale = false
    for (let index = timeline.items.length - 1; index >= 0; index -= 1) {
      const item = timeline.items[index]
      if (item.kind === 'assistant-message' && item.text.trim()) {
        this.lastAnswer = item
        return
      }
    }
  }
}

const states = new Map<string, NodeConversationState>()

export function conversationState(nodeId: string): NodeConversationState {
  let state = states.get(nodeId)
  if (!state) {
    state = new NodeConversationState()
    states.set(nodeId, state)
  }
  return state
}

// The node's conversation changed; nothing may be listening for it right now.
export function noteTimelineChanged(nodeId: string): void {
  const state = states.get(nodeId)
  if (state) state.stale = true
}

export function forgetConversationState(nodeId: string): void {
  states.delete(nodeId)
}

// The draft left after `sent` was accepted: whatever the user typed while it was in flight.
export function remainingDraft(current: string, sent: string): string {
  if (current === sent) return ''
  return current.startsWith(sent) ? current.slice(sent.length).replace(/^\s+/, '') : current
}
