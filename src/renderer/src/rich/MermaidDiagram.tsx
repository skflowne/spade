import { useEffect, useState } from 'react'
import type { Mermaid, MermaidConfig } from 'mermaid/dist/mermaid.core.mjs'
import { BlockAction, BlockFrame } from './BlockFrame'
import './rich.css'

type DiagramState =
  | { status: 'loading' }
  // `width` is the diagram's natural width; wide diagrams scroll instead of shrinking.
  | { status: 'ready'; svg: string; width: number | null }
  | { status: 'error'; message: string }

let mermaidLoad: Promise<Mermaid> | null = null
let renderSequence = 0

// Mermaid is loaded on first use so it stays out of the initial bundle.
function loadMermaid(): Promise<Mermaid> {
  mermaidLoad ??= import('mermaid/dist/mermaid.core.mjs').then(
    ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'base', ...themeFromTokens() })
      return mermaid
    },
    (reason: unknown) => {
      mermaidLoad = null
      throw reason
    }
  )
  return mermaidLoad
}

function themeFromTokens(): Pick<MermaidConfig, 'fontFamily' | 'themeVariables'> {
  const style = getComputedStyle(document.documentElement)
  const token = (name: string): string | undefined => style.getPropertyValue(name).trim() || undefined
  const variables: Record<string, string | boolean | undefined> = {
    darkMode: true,
    background: token('--panel'),
    mainBkg: token('--panel-2'),
    primaryColor: token('--panel-2'),
    primaryTextColor: token('--text'),
    primaryBorderColor: token('--accent'),
    secondaryColor: token('--cr-ink-700'),
    tertiaryColor: token('--canvas'),
    nodeBorder: token('--accent'),
    lineColor: token('--muted'),
    textColor: token('--text'),
    clusterBkg: token('--canvas'),
    clusterBorder: token('--line'),
    edgeLabelBackground: token('--panel'),
    noteBkgColor: token('--panel-2'),
    noteTextColor: token('--text'),
    noteBorderColor: token('--warning'),
    errorBkgColor: token('--panel-2'),
    errorTextColor: token('--danger'),
    fontFamily: token('--font'),
    fontSize: '13px'
  }
  const themeVariables = Object.fromEntries(Object.entries(variables).filter(([, value]) => value !== undefined))
  return { fontFamily: token('--font'), themeVariables }
}

// Mermaid renders inside a temporary container on document.body and may leave it behind on failure.
function removeRenderLeftovers(id: string): void {
  document.getElementById(`d${id}`)?.remove()
}

type MermaidDiagramProps = {
  source: string
  title?: string | null
}

export function MermaidDiagram({ source, title }: MermaidDiagramProps): React.JSX.Element {
  const [state, setState] = useState<DiagramState>({ status: 'loading' })
  const [showSource, setShowSource] = useState(false)

  useEffect(() => {
    let active = true
    renderSequence += 1
    const id = `spade-mermaid-${renderSequence}`
    setState({ status: 'loading' })

    loadMermaid()
      .then(async (mermaid) => {
        await mermaid.parse(source)
        const { svg } = await mermaid.render(id, source)
        if (active) setState({ status: 'ready', svg, width: naturalWidth(svg) })
      })
      .catch((reason: unknown) => {
        if (active) setState({ status: 'error', message: errorMessage(reason) })
      })
      .finally(() => removeRenderLeftovers(id))

    return () => {
      active = false
      removeRenderLeftovers(id)
    }
  }, [source])

  const failed = state.status === 'error'
  const actions = failed ? null : (
    <BlockAction onClick={() => setShowSource((current) => !current)} pressed={showSource}>
      Source
    </BlockAction>
  )

  return (
    <BlockFrame label="mermaid" title={title} actions={actions} className="rich-mermaid">
      {failed ? (
        <pre className="rich-block__error" role="alert">
          Diagram could not be rendered: {state.message}
        </pre>
      ) : null}
      {failed || showSource ? (
        <pre className="rich-code__body">
          <code>{source}</code>
        </pre>
      ) : state.status === 'ready' ? (
        // Mermaid's strict security level sanitizes labels; the SVG is Mermaid's own output.
        <div className="rich-mermaid__diagram">
          <div
            className="rich-mermaid__canvas"
            style={{ width: state.width ?? undefined }}
            dangerouslySetInnerHTML={{ __html: state.svg }}
          />
        </div>
      ) : (
        <div className="rich-mermaid__diagram rich-mermaid__diagram--loading" aria-busy="true">
          Rendering diagram…
        </div>
      )}
    </BlockFrame>
  )
}

// Mermaid sizes its SVG to the container (width="100%") capped by an inline max-width.
function naturalWidth(svg: string): number | null {
  const match = /max-width:\s*([\d.]+)px/.exec(svg)
  return match ? Math.ceil(Number(match[1])) : null
}

function errorMessage(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason)
  return message.trim() || 'Unknown error'
}
