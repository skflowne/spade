import { memo, useMemo, useState } from 'react'
import { HtmlAnswerBlock, RichMarkdown } from '../../rich'
import { useAnnotations } from './annotations'
import { useArtifacts } from './ArtifactLayer'
import { useConversation } from './ConversationContext'
import { splitMessage } from './messageSegments'
import { describeAnnotation } from './submission'

// An assistant message: Markdown through RichMarkdown, with each top-level live HTML answer in its own
// collapsible frame. Segments keep their index as key, so while a message streams only its tail changes
// and earlier answers and diagrams stay mounted.
export const AssistantMessage = memo(function AssistantMessage({ itemId, text }: { itemId: string; text: string }): React.JSX.Element {
  const segments = useMemo(() => splitMessage(text), [text])
  return (
    <div className="agent-message__body">
      {segments.map((segment, index) => {
        const answerKey = `${itemId}#${index}`
        switch (segment.type) {
          case 'markdown':
            return <MarkdownSegment key={index} answerKey={answerKey} source={segment.source} />
          case 'html':
            return <HtmlAnswer key={index} answerKey={answerKey} html={segment.html} title={segment.title} />
          case 'pending':
            return (
              <p key={index} className="agent-pending-block" role="status">
                Receiving {segment.language === 'mermaid' ? 'a diagram' : 'an HTML answer'}…
              </p>
            )
        }
      })}
    </div>
  )
})

function MarkdownSegment({ answerKey, source }: { answerKey: string; source: string }): React.JSX.Element {
  const { onArtifact, resolveImage } = useArtifacts()
  const { answerHandlers, leaveAnswer } = useConversation()
  // HTML answers nested inside Markdown (e.g. in a list) share this segment's annotations.
  const { onSubmit, onAnnotate } = answerHandlers(answerKey, null)
  return (
    <>
      <RichMarkdown
        source={source}
        onArtifact={onArtifact}
        resolveImage={resolveImage}
        onSubmit={onSubmit}
        onAnnotate={onAnnotate}
        onEscape={leaveAnswer}
      />
      <AnnotationList answerKey={answerKey} />
    </>
  )
}

function HtmlAnswer({ answerKey, html, title }: { answerKey: string; html: string; title: string | null }): React.JSX.Element {
  const { onArtifact } = useArtifacts()
  const { expansion, answerHandlers, submitBlocked, leaveAnswer } = useConversation()
  const [toggled, setToggled] = useState<boolean | null>(null)
  const expanded = toggled ?? expansion.html
  const { onSubmit, onAnnotate } = answerHandlers(answerKey, title)
  const name = title ?? 'HTML answer'

  return (
    <div className="agent-html-answer" data-testid="html-answer" data-expanded={expanded}>
      {expanded ? (
        <>
          <HtmlAnswerBlock
            html={html}
            title={title}
            onSubmit={onSubmit}
            onAnnotate={onAnnotate}
            onOpenUrl={(url, anchor) => {
              const artifact = { kind: 'url' as const, value: url, line: null, column: null, isImage: false }
              onArtifact(artifact, anchor)
            }}
            onEscape={leaveAnswer}
          />
          <button type="button" className="agent-html-answer__collapse" onClick={() => setToggled(false)}>
            Hide {name}
          </button>
        </>
      ) : (
        <button type="button" className="agent-html-answer__collapsed" aria-expanded={false} onClick={() => setToggled(true)}>
          <span className="agent-pane__chevron" aria-hidden="true">
            ▸
          </span>
          <span className="agent-pane__label">HTML answer</span>
          <span className="agent-pane__summary">{title ?? 'Show the live answer'}</span>
        </button>
      )}
      {submitBlocked && expanded ? <p className="agent-html-answer__blocked">Submitting is unavailable: {submitBlocked}</p> : null}
      <AnnotationList answerKey={answerKey} />
    </div>
  )
}

function AnnotationList({ answerKey }: { answerKey: string }): React.JSX.Element | null {
  const { annotations: store } = useConversation()
  const annotations = useAnnotations(store, answerKey)
  if (annotations.length === 0) return null
  return (
    <section className="agent-annotations" aria-label="Pending annotations">
      <p className="agent-item__label">Sent with the next submission</p>
      <ul>
        {annotations.map((annotation) => (
          <li key={annotation.id}>
            <span className="agent-annotations__text">{describeAnnotation(annotation)}</span>
            <button
              type="button"
              className="cr-icon-button agent-annotations__remove"
              aria-label={`Remove annotation: ${annotation.text}`}
              title="Remove annotation"
              onClick={() => store.remove(answerKey, annotation.id)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
