import { useMemo, type ReactNode } from 'react'
import { BlockFrame } from './BlockFrame'
import { highlightCode } from './highlight'
import './rich.css'

type CodeBlockProps = {
  text: string
  language: string | null
  title?: string | null
  actions?: ReactNode
}

export function CodeBlock({ text, language, title, actions }: CodeBlockProps): React.JSX.Element {
  return (
    <BlockFrame label={language ?? 'text'} title={title} actions={actions} className="rich-code">
      <CodeBlockBody text={text} language={language} />
    </BlockFrame>
  )
}

export function CodeBlockBody({ text, language }: { text: string; language: string | null }): React.JSX.Element {
  const highlighted = useMemo(() => highlightCode(text, language), [language, text])
  return (
    <pre className="rich-code__body">
      {highlighted === null ? (
        <code>{text}</code>
      ) : (
        // highlight.js escapes the source; its output contains only text and <span class> markup.
        <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} />
      )}
    </pre>
  )
}
