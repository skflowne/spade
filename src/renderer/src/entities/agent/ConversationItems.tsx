import { memo, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { ConversationImage, ConversationItem, ToolCallKind, ToolCallStatus } from '@shared/agents'
import { pathArtifact } from '@shared/artifacts'
import { ArtifactChip, ArtifactText, CodeBlock, RichImage } from '../../rich'
import { StatusBadge } from '../../ui/StatusBadge'
import type { NodeStatusTone } from '../types'
import { useArtifacts } from './ArtifactLayer'
import { AssistantMessage } from './AssistantMessage'
import { useConversation } from './ConversationContext'
import { paneKindOf, type PaneKind } from './expansion'
import { icons } from '../../ui/icons'

type ToolCall = Extract<ConversationItem, { kind: 'tool-call' }>

// One conversation item. Memoized on the item object: the timeline keeps unchanged items identical, so a
// streaming message re-renders alone.
export const ConversationItemView = memo(function ConversationItemView({ item }: { item: ConversationItem }): React.JSX.Element {
  switch (item.kind) {
    case 'user-message':
      return (
        <article
          className={item.sender ? 'agent-item agent-message agent-message--agent' : 'agent-item agent-message agent-message--user'}
          data-item-kind={item.kind}
          aria-label={item.sender ? `Message from ${item.sender.title ?? item.sender.agentId}` : 'Your message'}
        >
          <p className="agent-message__author">{item.sender ? `From ${item.sender.title ?? item.sender.agentId}` : 'You'}</p>
          <BoundedText className="agent-message__text">
            <LinkedText text={item.text} />
          </BoundedText>
          <ItemImages images={item.images} />
        </article>
      )
    case 'assistant-message':
      return (
        <article className="agent-item agent-message agent-message--assistant" data-item-kind={item.kind} aria-label="Agent message">
          <AssistantMessage itemId={item.id} text={item.text} />
          <ItemImages images={item.images} />
        </article>
      )
    case 'thinking':
      return (
        <Pane kind="thinking" label="Thinking" summary={firstLine(item.text)} itemKind={item.kind}>
          <BoundedText className="agent-thinking">{item.text}</BoundedText>
        </Pane>
      )
    case 'tool-call':
      return <ToolCallPane call={item} />
    case 'todo':
      return (
        <section className="agent-item agent-todo" data-item-kind={item.kind} aria-label="Task list">
          <p className="agent-item__label">Tasks</p>
          <ul>
            {item.items.map((entry, index) => (
              <li key={index} className={entry.done ? 'agent-todo__done' : undefined}>
                <input type="checkbox" checked={entry.done} disabled aria-label={entry.done ? 'Done' : 'Not done'} />
                <span>{entry.text}</span>
              </li>
            ))}
          </ul>
        </section>
      )
    case 'error':
      return (
        <p className="agent-item agent-error" data-item-kind={item.kind} role="note">
          <span className="agent-item__label">Error</span> <LinkedText text={item.message} />
        </p>
      )
    case 'notice':
      return (
        <p className="agent-item agent-notice" data-item-kind={item.kind}>
          <LinkedText text={item.text} />
        </p>
      )
  }
})

function LinkedText({ text }: { text: string }): React.JSX.Element {
  const { onArtifact } = useArtifacts()
  return <ArtifactText text={text} onArtifact={onArtifact} />
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/, 1)[0] ?? ''
}

// An expandable pane. Its initial state follows the expansion preference for its kind; toggling it never
// changes the preference.
function Pane({
  kind,
  label,
  summary,
  status,
  extra,
  itemKind,
  toolKind,
  children
}: {
  kind: PaneKind
  label: string
  summary: ReactNode
  status?: ReactNode
  extra?: ReactNode
  itemKind: ConversationItem['kind']
  toolKind?: ToolCallKind
  children: ReactNode
}): React.JSX.Element {
  const { expansion } = useConversation()
  const [toggled, setToggled] = useState<boolean | null>(null)
  const expanded = toggled ?? expansion[kind]
  const bodyId = useId()
  return (
    <section
      className={expanded ? 'agent-item agent-pane agent-pane--expanded' : 'agent-item agent-pane'}
      data-item-kind={itemKind}
      data-pane-kind={kind}
      data-tool-kind={toolKind}
      data-testid="conversation-pane"
    >
      <div className="agent-pane__header">
        <button
          type="button"
          className="agent-pane__toggle"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setToggled(!expanded)}
        >
          <span className="agent-pane__chevron" aria-hidden="true">
            {expanded ? <icons.expanded /> : <icons.collapsed />}
          </span>
          <span className="agent-pane__label">{label}</span>
          <span className="agent-pane__summary">{summary}</span>
        </button>
        {extra}
        {status}
      </div>
      {expanded ? (
        <div id={bodyId} className="agent-pane__body">
          {children}
        </div>
      ) : null}
    </section>
  )
}

const TOOL_STATUS_TONE: Record<ToolCallStatus, NodeStatusTone> = {
  running: 'info',
  completed: 'success',
  failed: 'danger',
  canceled: 'neutral'
}

const TOOL_LABELS: Record<ToolCallKind, string> = {
  read: 'Read',
  edit: 'Edit',
  shell: 'Shell',
  search: 'Search',
  fetch: 'Fetch',
  subagent: 'Sub-agent',
  other: 'Tool'
}

function ToolCallPane({ call }: { call: ToolCall }): React.JSX.Element {
  const { onArtifact } = useArtifacts()
  const { subagentIds, openSubagent } = useConversation()
  const kind = paneKindOf(call) ?? 'toolCall'
  const linkedSubagent = call.toolKind === 'subagent' && subagentIds.has(call.callId)
  const [opening, setOpening] = useState(false)
  const extra = (
    <>
      {call.path ? (
        <span className="agent-pane__path">
          <ArtifactChip artifact={pathArtifact(call.path)} text={call.path} onArtifact={onArtifact} />
        </span>
      ) : null}
      {linkedSubagent ? (
        <button
          type="button"
          className="cr-button cr-button--ghost agent-pane__action"
          disabled={opening}
          onClick={() => {
            setOpening(true)
            void openSubagent(call.callId).finally(() => setOpening(false))
          }}
        >
          Open as node
        </button>
      ) : null}
    </>
  )
  return (
    <Pane
      kind={kind}
      label={TOOL_LABELS[call.toolKind]}
      summary={<span className="mono">{call.toolKind === 'other' ? `${call.name} ${call.summary}` : call.summary || call.name}</span>}
      status={<StatusBadge status={{ label: call.status, tone: TOOL_STATUS_TONE[call.status] }} />}
      extra={extra}
      itemKind="tool-call"
      toolKind={call.toolKind}
    >
      <ToolCallDetails call={call} />
    </Pane>
  )
}

function ToolCallDetails({ call }: { call: ToolCall }): React.JSX.Element {
  const sections: ReactNode[] = []
  switch (call.toolKind) {
    case 'shell':
      sections.push(
        <Output key="command" label="Command" text={call.input ?? call.summary} prefix="$ " />,
        call.output ? <Output key="output" label="Output" text={call.output} /> : null
      )
      break
    case 'read':
      sections.push(call.output ? <Output key="content" label="Content" text={call.output} /> : null)
      break
    case 'edit':
      sections.push(
        call.diff ? (
          <BoundedText key="diff" className="agent-diff">
            <CodeBlock text={call.diff} language="diff" title={call.path} />
          </BoundedText>
        ) : (
          <InputOutput key="io" call={call} />
        )
      )
      break
    default:
      sections.push(<InputOutput key="io" call={call} />)
  }
  return (
    <>
      {sections}
      {call.error ? (
        <p className="agent-tool__error" role="note">
          <LinkedText text={call.error} />
        </p>
      ) : null}
      <ItemImages images={call.images} />
      {sections.every((section) => section === null) && !call.error && call.images.length === 0 ? (
        <p className="agent-tool__empty">{call.status === 'running' ? 'Running…' : 'No output.'}</p>
      ) : null}
    </>
  )
}

function InputOutput({ call }: { call: ToolCall }): React.JSX.Element {
  return (
    <>
      {call.input ? <Output label="Input" text={call.input} /> : null}
      {call.output ? <Output label="Output" text={call.output} /> : null}
    </>
  )
}

function Output({ label, text, prefix = '' }: { label: string; text: string; prefix?: string }): React.JSX.Element {
  return (
    <div className="agent-tool__section">
      <p className="agent-item__label">{label}</p>
      <BoundedText className="agent-tool__output">
        {prefix}
        <LinkedText text={text} />
      </BoundedText>
    </div>
  )
}

const BOUNDED_HEIGHT = 240

// Long content is clipped to a sensible height until the user asks for more; then it scrolls.
function BoundedText({ className, children }: { className: string; children: ReactNode }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [overflowing, setOverflowing] = useState(false)
  const [expanded, setExpanded] = useState(false)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = (): void => setOverflowing(element.scrollHeight > BOUNDED_HEIGHT + 8)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    for (const child of Array.from(element.children)) observer.observe(child)
    return () => observer.disconnect()
  }, [children])
  const clipped = overflowing && !expanded
  return (
    <div className={`agent-bounded ${expanded ? 'agent-bounded--expanded' : ''} ${clipped ? 'agent-bounded--clipped' : ''}`}>
      <div ref={ref} className={className} style={expanded ? undefined : { maxHeight: BOUNDED_HEIGHT }}>
        {children}
      </div>
      {overflowing ? (
        <button type="button" className="agent-bounded__toggle" onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </div>
  )
}

export function ItemImages({ images }: { images: readonly ConversationImage[] }): React.JSX.Element | null {
  const { onArtifact, resolveImage, openInlineImage } = useArtifacts()
  if (images.length === 0) return null
  return (
    <div className="agent-images">
      {images.map((image, index) =>
        /^data:/i.test(image.source) ? (
          <button
            key={index}
            type="button"
            className="rich-image rich-image--interactive"
            data-artifact-kind="image"
            aria-label="Image from the agent"
            onClick={(event) => openInlineImage(image.source, event.currentTarget)}
          >
            <img src={image.source} alt="" draggable={false} />
          </button>
        ) : (
          <RichImage
            key={index}
            src={image.source}
            alt=""
            title={image.source}
            artifact={pathArtifact(image.source)}
            resolveImage={resolveImage}
            onArtifact={onArtifact}
          />
        )
      )}
    </div>
  )
}
