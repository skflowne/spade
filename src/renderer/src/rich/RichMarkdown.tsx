import { createContext, memo, useContext, useMemo, useState, type ReactNode } from 'react'
import { parseArtifact } from '../../../shared/artifacts'
import { ArtifactChip } from './ArtifactChip'
import { BlockAction } from './BlockFrame'
import { CodeBlock } from './CodeBlock'
import type { RichContentHandlers } from './handlers'
import { HtmlAnswerBlock } from './HtmlAnswerBlock'
import { parseRichMarkdown, type ArtifactTextSegment, type RichBlock, type RichInline } from './markdownModel'
import { MermaidDiagram } from './MermaidDiagram'
import { RichImage } from './RichImage'
import './rich.css'

export type RichMarkdownProps = RichContentHandlers & {
  source: string
  className?: string
}

const HandlersContext = createContext<RichContentHandlers | null>(null)

function useHandlers(): RichContentHandlers {
  const handlers = useContext(HandlersContext)
  if (!handlers) throw new Error('Rich Markdown content rendered outside RichMarkdown')
  return handlers
}

// Renders agent or user Markdown as React elements. Raw HTML in the source is shown as inert text,
// links and artifacts are buttons that report to `onArtifact`, and nothing navigates the app.
export const RichMarkdown = memo(function RichMarkdown({
  source,
  className,
  onArtifact,
  resolveImage,
  onSubmit,
  onAnnotate,
  onEscape
}: RichMarkdownProps): React.JSX.Element {
  const blocks = useMemo(() => parseRichMarkdown(source), [source])
  const handlers = useMemo(
    () => ({ onArtifact, resolveImage, onSubmit, onAnnotate, onEscape }),
    [onAnnotate, onArtifact, onSubmit, resolveImage, onEscape]
  )
  return (
    <HandlersContext.Provider value={handlers}>
      <div className={className ? `rich-markdown ${className}` : 'rich-markdown'}>
        <Blocks blocks={blocks} />
      </div>
    </HandlersContext.Provider>
  )
})

function Blocks({ blocks }: { blocks: RichBlock[] }): React.JSX.Element {
  return (
    <>
      {blocks.map((block, index) => (
        <Block key={index} block={block} />
      ))}
    </>
  )
}

function Block({ block }: { block: RichBlock }): React.JSX.Element {
  switch (block.type) {
    case 'heading': {
      const Heading = `h${Math.min(6, Math.max(1, block.depth))}` as 'h1'
      return (
        <Heading className="rich-heading">
          <Inlines inlines={block.children} />
        </Heading>
      )
    }
    case 'paragraph':
      return (
        <p>
          <Inlines inlines={block.children} />
        </p>
      )
    case 'list': {
      const items = block.items.map((item, index) => (
        <li key={index} className={item.checked === null ? undefined : 'rich-task'}>
          {item.checked === null ? null : (
            <input type="checkbox" checked={item.checked} disabled aria-label={item.checked ? 'Done' : 'Not done'} />
          )}
          <div className="rich-list__content">
            <Blocks blocks={item.children} />
          </div>
        </li>
      ))
      const className = block.loose ? 'rich-list' : 'rich-list rich-list--tight'
      return block.ordered ? (
        <ol className={className} start={block.start ?? undefined}>
          {items}
        </ol>
      ) : (
        <ul className={className}>{items}</ul>
      )
    }
    case 'table':
      return (
        <div className="rich-scroll">
          <table className="rich-table">
            <thead>
              <tr>
                {block.header.map((cell, index) => (
                  <th key={index} style={{ textAlign: block.align[index] ?? undefined }}>
                    <Inlines inlines={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, index) => (
                    <td key={index} style={{ textAlign: block.align[index] ?? undefined }}>
                      <Inlines inlines={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'blockquote':
      return block.callout ? (
        <aside className={`rich-callout rich-callout--${block.callout}`}>
          <p className="rich-callout__label">{CALLOUT_LABELS[block.callout]}</p>
          <Blocks blocks={block.children} />
        </aside>
      ) : (
        <blockquote className="rich-quote">
          <Blocks blocks={block.children} />
        </blockquote>
      )
    case 'code':
      return <FencedBlock block={block} />
    case 'rule':
      return <hr className="rich-rule" />
    case 'raw-html':
      return (
        <pre className="rich-raw-html" title="Raw HTML is shown as text">
          <code>{block.text}</code>
        </pre>
      )
  }
}

const CALLOUT_LABELS = {
  note: 'Note',
  tip: 'Tip',
  important: 'Important',
  warning: 'Warning',
  caution: 'Caution'
} as const

function FencedBlock({ block }: { block: Extract<RichBlock, { type: 'code' }> }): React.JSX.Element {
  switch (block.presentation) {
    case 'mermaid':
      return <MermaidDiagram source={block.text} title={block.title} />
    case 'live-html':
      return <LiveHtml html={block.text} title={block.title} />
    case 'html':
      return <HtmlCode block={block} />
    case 'code':
      return <CodeBlock text={block.text} language={block.language} title={block.title} />
  }
}

function LiveHtml({ html, title }: { html: string; title: string | null }): React.JSX.Element {
  const { onSubmit, onAnnotate, onArtifact, onEscape } = useHandlers()
  const onOpenUrl = (url: string, anchor: HTMLElement): void => {
    const artifact = parseArtifact(url)
    if (artifact) onArtifact(artifact, anchor)
  }
  return (
    <HtmlAnswerBlock html={html} title={title} onSubmit={onSubmit} onAnnotate={onAnnotate} onOpenUrl={onOpenUrl} onEscape={onEscape} />
  )
}

// A plain ```html fence is code until the user chooses to run it.
function HtmlCode({ block }: { block: Extract<RichBlock, { type: 'code' }> }): React.JSX.Element {
  const [rendered, setRendered] = useState(false)
  if (rendered) return <LiveHtml html={block.text} title={block.title} />
  return (
    <CodeBlock
      text={block.text}
      language={block.language}
      title={block.title}
      actions={<BlockAction onClick={() => setRendered(true)}>Render</BlockAction>}
    />
  )
}

function Inlines({ inlines, inLink = false }: { inlines: RichInline[]; inLink?: boolean }): React.JSX.Element {
  return (
    <>
      {inlines.map((inline, index) => (
        <Inline key={index} inline={inline} inLink={inLink} />
      ))}
    </>
  )
}

function Inline({ inline, inLink }: { inline: RichInline; inLink: boolean }): ReactNode {
  const { onArtifact, resolveImage } = useHandlers()
  switch (inline.type) {
    case 'text':
      return inline.text
    case 'artifact':
      return <ArtifactChip artifact={inline.artifact} text={inline.text} onArtifact={onArtifact} />
    case 'strong':
      return (
        <strong>
          <Inlines inlines={inline.children} inLink={inLink} />
        </strong>
      )
    case 'emphasis':
      return (
        <em>
          <Inlines inlines={inline.children} inLink={inLink} />
        </em>
      )
    case 'strikethrough':
      return (
        <del>
          <Inlines inlines={inline.children} inLink={inLink} />
        </del>
      )
    case 'code':
      return (
        <code className="rich-inline-code">
          <Segments segments={inline.segments} />
        </code>
      )
    case 'link': {
      const label = <Inlines inlines={inline.children} inLink />
      const artifact = inline.artifact
      if (!artifact || inLink) {
        return (
          <span className="rich-link rich-link--inert" title={inline.title ?? inline.href}>
            {label}
          </span>
        )
      }
      return (
        <button
          type="button"
          className="rich-link"
          data-artifact-kind={artifact.isImage ? 'image' : artifact.kind}
          title={inline.title ?? inline.href}
          onClick={(event) => onArtifact(artifact, event.currentTarget)}
        >
          {label}
        </button>
      )
    }
    case 'image':
      return (
        <RichImage
          src={inline.src}
          alt={inline.alt}
          title={inline.title}
          artifact={inLink ? null : inline.artifact}
          resolveImage={resolveImage}
          onArtifact={onArtifact}
        />
      )
    case 'break':
      return <br />
    case 'raw-html':
      return (
        <code className="rich-raw-html" title="Raw HTML is shown as text">
          {inline.text}
        </code>
      )
  }
}

function Segments({ segments }: { segments: ArtifactTextSegment[] }): React.JSX.Element {
  const { onArtifact } = useHandlers()
  return (
    <>
      {segments.map((segment, index) =>
        segment.type === 'artifact' ? (
          <ArtifactChip key={index} artifact={segment.artifact} text={segment.text} onArtifact={onArtifact} />
        ) : (
          <span key={index}>{segment.text}</span>
        )
      )}
    </>
  )
}
