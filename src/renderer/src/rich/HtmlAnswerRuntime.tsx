import { useLayoutEffect, useRef, useState } from 'react'
import { parseBridgeCall } from '../../../shared/richBlocks'
import type { AnnotateHandler, SubmitHandler } from './handlers'
import {
  buildAnswerDocument,
  HOST_MESSAGE_SOURCE,
  parseRuntimeMessage,
  type HostMessage
} from './htmlRuntimeProtocol'
import runtimeUrl from './htmlRuntime.html?url&no-inline'
import './rich.css'

export type HtmlAnswerRuntimeProps = {
  // A complete agent-authored HTML document (or fragment). Changing it starts a new runtime.
  html: string
  // Accessible name of the runtime frame.
  title: string
  onSubmit: SubmitHandler
  onAnnotate: AnnotateHandler
  // http(s) links clicked inside the answer; they never navigate the runtime or the app.
  onOpenUrl?: (url: string, anchor: HTMLElement) => void
  minHeight?: number
  maxHeight?: number
}

const DEFAULT_MIN_HEIGHT = 96
const DEFAULT_MAX_HEIGHT = 640
const INITIAL_HEIGHT = 160

// Runs agent-authored HTML/JS in an unsandboxed iframe with `window.spade` injected (plan §11).
// The iframe isolates CSS and lifecycle, not privileges: the answer document shares the app origin
// (accepted v1 risk). Mount, reload, and disposal follow the component: mounting starts a runtime,
// a new `key` or `html` reloads it, unmounting disposes it. Replacing this with an isolated runtime
// must keep these props unchanged.
export function HtmlAnswerRuntime(props: HtmlAnswerRuntimeProps): React.JSX.Element {
  return <RuntimeFrame key={props.html} {...props} />
}

function RuntimeFrame({
  html,
  title,
  onSubmit,
  onAnnotate,
  onOpenUrl,
  minHeight = DEFAULT_MIN_HEIGHT,
  maxHeight = DEFAULT_MAX_HEIGHT
}: HtmlAnswerRuntimeProps): React.JSX.Element {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [token] = useState(() => crypto.randomUUID())
  const [contentHeight, setContentHeight] = useState<number | null>(null)
  const latest = useRef({ html, onSubmit, onAnnotate, onOpenUrl })

  useLayoutEffect(() => {
    latest.current = { html, onSubmit, onAnnotate, onOpenUrl }
  })

  // A layout effect so the listener exists before the frame can announce itself.
  useLayoutEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    let active = true

    const post = (message: HostMessage): void => {
      if (active) frame.contentWindow?.postMessage(message, '*')
    }

    const receive = (event: MessageEvent<unknown>): void => {
      if (event.source === null || event.source !== frame.contentWindow) return
      const message = parseRuntimeMessage(event.data, token)
      if (!message) return

      switch (message.type) {
        case 'ready':
          post({
            source: HOST_MESSAGE_SOURCE,
            token,
            type: 'load',
            html: buildAnswerDocument(latest.current.html, { token, themeCss: themeCss() })
          })
          return
        case 'resize':
          setContentHeight(message.height)
          return
        case 'open-url':
          latest.current.onOpenUrl?.(message.url, frame)
          return
        case 'call': {
          const reply = (error: string | null): void =>
            post({ source: HOST_MESSAGE_SOURCE, token, type: 'result', id: message.id, error })
          const call = parseBridgeCall(message.method, message.input)
          if (!call) {
            reply(`Invalid window.spade.${typeof message.method === 'string' ? message.method : 'call'} input`)
            return
          }
          Promise.resolve()
            .then(() =>
              call.method === 'submit' ? latest.current.onSubmit(call.input) : latest.current.onAnnotate(call.input)
            )
            .then(
              () => reply(null),
              (reason: unknown) => reply(reason instanceof Error ? reason.message : String(reason))
            )
        }
      }
    }

    window.addEventListener('message', receive)
    return () => {
      active = false
      window.removeEventListener('message', receive)
    }
  }, [token])

  const height = Math.min(maxHeight, Math.max(minHeight, contentHeight ?? INITIAL_HEIGHT))

  return (
    <iframe
      ref={frameRef}
      className="rich-html__frame"
      title={title}
      src={`${runtimeUrl}#${token}`}
      style={{ height }}
      data-runtime-token={token}
    />
  )
}

let cachedThemeCss: string | null = null

// Exposes the app's design tokens to answers as CSS custom properties and gives unstyled answers
// the app's base look; answer styles declared later override it.
function themeCss(): string {
  if (cachedThemeCss !== null) return cachedThemeCss
  const names = new Set<string>()
  const visit = (rules: CSSRuleList): void => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule && rule.selectorText === ':root') {
        for (const name of Array.from(rule.style)) if (name.startsWith('--')) names.add(name)
      } else if (rule instanceof CSSImportRule && rule.styleSheet) {
        visit(rule.styleSheet.cssRules)
      } else if (rule instanceof CSSGroupingRule) {
        visit(rule.cssRules)
      }
    }
  }
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      visit(sheet.cssRules)
    } catch {
      // Cross-origin sheets cannot be read and carry no app tokens.
    }
  }
  const computed = getComputedStyle(document.documentElement)
  const declarations = [...names]
    .map((name) => [name, computed.getPropertyValue(name).trim()] as const)
    .filter(([, value]) => value)
    .map(([name, value]) => `${name}: ${value};`)
  cachedThemeCss = `:root { ${declarations.join(' ')} color-scheme: dark; background: var(--panel); color: var(--text); font-family: var(--font); font-size: var(--cr-text-body); line-height: 1.5; }`
  return cachedThemeCss
}
