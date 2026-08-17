import { useEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import { MermaidDiagram } from './MermaidDiagram'
import { PrototypeNodeFrame } from './PrototypeNodeFrame'

export type ConversationEvent = {
  id: number
  method: 'submit' | 'annotate'
  summary: string
  runtime: number
}

type BridgeMessage = {
  source: 'spade-p2-answer'
  runtime: number
  method: ConversationEvent['method']
  input: Record<string, unknown>
}

type RichAnswerNodeProps = {
  onConversationEvent: (event: Omit<ConversationEvent, 'id'>) => void
}

const markdown = `## Browser composition plan

- Keep remote content in a **guest webview** while it survives canvas transforms.
- Compare one native overlay before selecting the final boundary.
- Turn rich-answer feedback into deterministic conversation events.
`

const diagram = `flowchart LR
  A[Agent answer] --> B{User feedback}
  B -->|submit| C[Follow-up message]
  B -->|annotate| D[Plan annotation]`

function isBridgeMessage(value: unknown, runtime: number): value is BridgeMessage {
  if (!value || typeof value !== 'object') return false

  const candidate = value as Partial<BridgeMessage>
  return (
    candidate.source === 'spade-p2-answer' &&
    candidate.runtime === runtime &&
    (candidate.method === 'submit' || candidate.method === 'annotate') &&
    !!candidate.input &&
    typeof candidate.input === 'object' &&
    !Array.isArray(candidate.input)
  )
}

function summarize(message: BridgeMessage): string {
  if (message.method === 'submit') {
    return typeof message.input.message === 'string'
      ? message.input.message
      : JSON.stringify(message.input.data ?? null)
  }

  const target = typeof message.input.target === 'string' ? ` on ${message.input.target}` : ''
  return `${String(message.input.text)}${target}`
}

function answerDocument(runtime: number): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <style>
    :root { color: #e8edf2; background: #111820; font: 14px system-ui, sans-serif; }
    body { margin: 0; padding: 16px; }
    form, .annotations { display: grid; gap: 10px; }
    label { display: grid; gap: 5px; color: #aeb9c4; }
    input, button { border: 1px solid #3d4a57; border-radius: 3px; padding: 8px; color: inherit; background: #19232d; }
    button { cursor: pointer; }
    .plan { margin: 14px 0; padding: 10px; border-left: 3px solid #5bc0eb; background: #17212a; }
    #status { min-height: 1.2em; color: #75d69c; }
  </style>
</head>
<body>
  <h2>Interactive implementation plan</h2>
  <p>This complete document owns its CSS and JavaScript lifecycle.</p>
  <div class="plan" id="browser-step"><strong>Browser step</strong><br>Validate the guest inside canvas transforms.</div>
  <div class="annotations">
    <button type="button" data-target="browser-step">Annotate browser step</button>
    <button type="button" data-target="answer-runtime">Annotate answer runtime</button>
  </div>
  <form>
    <label>Follow-up message <input name="message" value="Use the guest webview for transformed nodes"></label>
    <button type="submit">Send follow-up</button>
  </form>
  <p id="status" role="status"></p>
  <script>
    const runtime = ${runtime};
    const send = (method, input) => {
      parent.postMessage({ source: 'spade-p2-answer', runtime, method, input }, '*');
      return Promise.resolve();
    };
    window.spade = {
      submit: (input) => send('submit', input),
      annotate: (input) => send('annotate', input)
    };
    document.querySelector('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      await window.spade.submit({ message: new FormData(event.currentTarget).get('message') });
      document.querySelector('#status').textContent = 'Follow-up sent to mock conversation';
    });
    document.querySelectorAll('[data-target]').forEach((button) => {
      button.addEventListener('click', async () => {
        await window.spade.annotate({ target: button.dataset.target, text: 'Needs direct prototype evidence' });
        document.querySelector('#status').textContent = 'Plan annotation sent';
      });
    });
  </script>
</body>
</html>`
}

export function RichAnswerNode({ onConversationEvent }: RichAnswerNodeProps): React.JSX.Element {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [mounted, setMounted] = useState(true)
  const [runtime, setRuntime] = useState(1)
  const renderedMarkdown = useMemo(() => marked.parse(markdown, { async: false }), [])

  useEffect(() => {
    if (!mounted) return

    const receive = (event: MessageEvent<unknown>): void => {
      if (event.source !== iframeRef.current?.contentWindow || !isBridgeMessage(event.data, runtime)) {
        return
      }

      onConversationEvent({
        method: event.data.method,
        summary: summarize(event.data),
        runtime
      })
    }

    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [mounted, onConversationEvent, runtime])

  const reload = (): void => {
    setMounted(true)
    setRuntime((current) => current + 1)
  }

  return (
    <PrototypeNodeFrame title="Rich answer" kind="Markdown · Mermaid · HTML/JavaScript" resizable>
      <section className="rich-answer__standard" aria-label="Standard rich answer">
        <div className="markdown-output" dangerouslySetInnerHTML={{ __html: renderedMarkdown }} />
        <MermaidDiagram source={diagram} />
      </section>
      <div className="runtime-toolbar">
        <button type="button" onClick={() => setMounted(true)} disabled={mounted}>Mount</button>
        <button type="button" onClick={reload}>Reload</button>
        <button type="button" onClick={() => setMounted(false)} disabled={!mounted}>Dispose</button>
        <output>runtime {runtime} · {mounted ? 'mounted' : 'disposed'}</output>
      </div>
      {mounted ? (
        <iframe
          key={runtime}
          ref={iframeRef}
          className="answer-runtime"
          title="Custom HTML answer runtime"
          srcDoc={answerDocument(runtime)}
        />
      ) : (
        <div className="answer-runtime answer-runtime--disposed">Runtime disposed</div>
      )}
    </PrototypeNodeFrame>
  )
}
