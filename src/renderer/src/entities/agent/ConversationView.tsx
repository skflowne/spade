import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import type { ConversationItem } from '@shared/agents'
import { ConversationItemView } from './ConversationItems'
import { conversationState } from './conversationState'

type ConversationViewProps = {
  nodeId: string
  items: readonly ConversationItem[]
  hasOlder: boolean
  loadingOlder: boolean
  onLoadOlder(): Promise<'prepended' | 'unchanged'>
  // Shown in place of items when there are none.
  empty: ReactNode
}

// Distance from the bottom within which the view counts as "at the bottom" and follows new content.
const STICK_THRESHOLD = 32

// The scrolling item list. It follows new content while the user is at the bottom and never moves when
// they scrolled up; loading older items keeps the visible content in place. Remounting (after a zoom or a
// collapse) returns to the position the user left.
export function ConversationView({ nodeId, items, hasOlder, loadingOlder, onLoadOlder, empty }: ConversationViewProps): React.JSX.Element {
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const remembered = conversationState(nodeId)
  const restoreScroll = useRef(remembered.scroll)
  const stuck = useRef(remembered.scroll?.atBottom ?? true)
  // Where following last put the view. Its scroll event may arrive after the content grew again, so an
  // event at or below this position is not the user scrolling away.
  const followedTo = useRef(0)
  const follow = (element: HTMLElement): void => {
    element.scrollTop = element.scrollHeight
    followedTo.current = element.scrollTop
  }
  // Distance from the bottom to restore once older items are prepended before `firstId`.
  const restore = useRef<{ fromBottom: number; firstId: string | undefined } | null>(null)

  useLayoutEffect(() => {
    const element = scroller.current
    if (!element) return
    const remembered = restoreScroll.current
    restoreScroll.current = null
    if (restore.current !== null && items[0]?.id !== restore.current.firstId) {
      element.scrollTop = element.scrollHeight - restore.current.fromBottom
      restore.current = null
    } else if (stuck.current) {
      follow(element)
    } else if (remembered) {
      element.scrollTop = remembered.top
    }
  }, [items])

  // Read while the element is still in the document, before the body unmounts.
  useLayoutEffect(() => {
    const element = scroller.current
    return () => {
      if (element) conversationState(nodeId).scroll = { top: element.scrollTop, atBottom: stuck.current }
    }
  }, [nodeId])

  // Content also grows without new items: images load, diagrams render, HTML answers resize.
  useEffect(() => {
    const element = scroller.current
    const inner = content.current
    if (!element || !inner) return
    const observer = new ResizeObserver(() => {
      if (stuck.current) follow(element)
    })
    observer.observe(inner)
    // The visible area shrinks too, e.g. when a permission request appears above the composer.
    observer.observe(element)
    return () => observer.disconnect()
  }, [])


  const loadOlder = async (): Promise<void> => {
    const element = scroller.current
    if (element) restore.current = { fromBottom: element.scrollHeight - element.scrollTop, firstId: items[0]?.id }
    // Nothing was prepended (the request failed, or another epoch replaced everything): no later update may
    // restore this position.
    if ((await onLoadOlder()) !== 'prepended') restore.current = null
  }

  return (
    <div
      ref={scroller}
      className="agent-conversation"
      role="log"
      aria-label="Conversation"
      data-testid="agent-conversation"
      onScroll={(event) => {
        const element = event.currentTarget
        if (stuck.current && element.scrollTop >= followedTo.current - 1) return
        stuck.current = element.scrollHeight - element.scrollTop - element.clientHeight <= STICK_THRESHOLD
        remembered.scroll = { top: element.scrollTop, atBottom: stuck.current }
      }}
    >
      <div ref={content} className="agent-conversation__content">
        {hasOlder ? (
          <button type="button" className="cr-button cr-button--ghost agent-conversation__older" disabled={loadingOlder} onClick={() => void loadOlder()}>
            {loadingOlder ? 'Loading older messages…' : 'Load older messages'}
          </button>
        ) : null}
        {items.length === 0 ? empty : items.map((item) => <ConversationItemView key={item.id} item={item} />)}
      </div>
    </div>
  )
}
