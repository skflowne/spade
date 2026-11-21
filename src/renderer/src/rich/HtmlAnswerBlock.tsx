import { useState } from 'react'
import { BlockAction, BlockFrame } from './BlockFrame'
import { CodeBlockBody } from './CodeBlock'
import type { AnnotateHandler, SubmitHandler } from './handlers'
import { HtmlAnswerRuntime } from './HtmlAnswerRuntime'
import './rich.css'

type HtmlAnswerBlockProps = {
  html: string
  title?: string | null
  onSubmit: SubmitHandler
  onAnnotate: AnnotateHandler
  onOpenUrl?: (url: string, anchor: HTMLElement) => void
}

// A live HTML answer with explicit runtime controls: Reload starts a fresh runtime, Dispose
// removes it, Mount starts it again, Source shows the document without disposing the runtime.
export function HtmlAnswerBlock({ html, title, onSubmit, onAnnotate, onOpenUrl }: HtmlAnswerBlockProps): React.JSX.Element {
  const [generation, setGeneration] = useState(1)
  const [mounted, setMounted] = useState(true)
  const [showSource, setShowSource] = useState(false)

  const actions = (
    <>
      <BlockAction onClick={() => setGeneration((current) => current + 1)} disabled={!mounted}>
        Reload
      </BlockAction>
      <BlockAction
        onClick={() => {
          if (!mounted) setGeneration((current) => current + 1)
          setMounted(!mounted)
        }}
      >
        {mounted ? 'Dispose' : 'Mount'}
      </BlockAction>
      <BlockAction onClick={() => setShowSource((current) => !current)} pressed={showSource}>
        Source
      </BlockAction>
    </>
  )

  return (
    <BlockFrame label="html answer" title={title} actions={actions} className="rich-html">
      {showSource ? <CodeBlockBody text={html} language="html" /> : null}
      {mounted ? (
        <div className="rich-html__runtime" hidden={showSource}>
          <HtmlAnswerRuntime
            key={generation}
            html={html}
            title={title ?? 'HTML answer'}
            onSubmit={onSubmit}
            onAnnotate={onAnnotate}
            onOpenUrl={onOpenUrl}
          />
        </div>
      ) : showSource ? null : (
        <p className="rich-html__disposed">Runtime disposed</p>
      )}
    </BlockFrame>
  )
}
