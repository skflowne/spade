// Message protocol between an HTML answer runtime frame and its host component (plan §11).
//
// The frame first loads a static bootstrap document (htmlRuntime.html) that is a separate document
// from the app, so the app's strict script-src does not apply to agent-authored scripts. The
// bootstrap announces `ready`; the host answers with `load`, and the bootstrap replaces itself with
// the answer document built here, which starts with the bridge prelude defining `window.spade`.
//
// Every message carries a per-runtime token. It keeps lifecycles apart (a reloaded runtime ignores
// its predecessor's messages); it is not a security boundary, since the answer script can read it.

export const RUNTIME_MESSAGE_SOURCE = 'spade-html-runtime'
export const HOST_MESSAGE_SOURCE = 'spade-html-host'

export type RuntimeMessage =
  | { type: 'ready' }
  | { type: 'resize'; height: number }
  | { type: 'open-url'; url: string }
  | { type: 'call'; id: number; method: unknown; input: unknown }
  // Escape pressed inside the answer and not handled by it: the host leaves the answer (plan §6).
  | { type: 'escape' }

export type HostMessage =
  | { source: typeof HOST_MESSAGE_SOURCE; token: string; type: 'load'; html: string }
  | { source: typeof HOST_MESSAGE_SOURCE; token: string; type: 'result'; id: number; error: string | null }

export function parseRuntimeMessage(data: unknown, token: string): RuntimeMessage | null {
  if (!data || typeof data !== 'object') return null
  const message = data as Record<string, unknown>
  if (message.source !== RUNTIME_MESSAGE_SOURCE || message.token !== token) return null

  switch (message.type) {
    case 'ready':
      return { type: 'ready' }
    case 'escape':
      return { type: 'escape' }
    case 'resize':
      return typeof message.height === 'number' && Number.isFinite(message.height) && message.height >= 0
        ? { type: 'resize', height: Math.ceil(message.height) }
        : null
    case 'open-url':
      return typeof message.url === 'string' && /^https?:\/\//i.test(message.url)
        ? { type: 'open-url', url: message.url }
        : null
    case 'call':
      return Number.isInteger(message.id)
        ? { type: 'call', id: message.id as number, method: message.method, input: message.input }
        : null
    default:
      return null
  }
}

export function buildAnswerDocument(html: string, options: { token: string; themeCss: string }): string {
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)
  const head = doctype ? doctype[0] : '<!doctype html>'
  const body = doctype ? html.slice(doctype[0].length) : html
  const themeCss = options.themeCss.replace(/</g, '\\3c ')
  return `${head}<style data-spade-theme>${themeCss}</style><script>${prelude(options.token)}</script>${body}`
}

function prelude(token: string): string {
  return `(() => {
  const token = ${JSON.stringify(token)};
  const host = window.parent;
  const pending = new Map();
  let nextId = 1;
  let lastHeight = -1;
  const post = (message) => host.postMessage(Object.assign({ source: ${JSON.stringify(RUNTIME_MESSAGE_SOURCE)}, token }, message), '*');
  const call = (method, input) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    try {
      post({ type: 'call', id, method, input });
    } catch (error) {
      pending.delete(id);
      reject(error);
    }
  });
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (event.source !== host || !data || data.source !== ${JSON.stringify(HOST_MESSAGE_SOURCE)} || data.token !== token || data.type !== 'result') return;
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.error === null) entry.resolve();
    else entry.reject(new Error(String(data.error)));
  });
  Object.defineProperty(window, 'spade', {
    value: Object.freeze({
      submit: (input) => call('submit', input),
      annotate: (input) => call('annotate', input)
    }),
    enumerable: true
  });
  const measure = () => {
    const body = document.body;
    if (!body) return;
    const style = getComputedStyle(body);
    const height = Math.ceil(Math.max(
      document.documentElement.offsetHeight,
      body.offsetHeight + parseFloat(style.marginTop) + parseFloat(style.marginBottom)
    ));
    if (height === lastHeight) return;
    lastHeight = height;
    post({ type: 'resize', height });
  };
  const observer = new ResizeObserver(measure);
  const observe = () => {
    observer.observe(document.documentElement);
    if (document.body) observer.observe(document.body);
    measure();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observe);
  else observe();
  window.addEventListener('load', measure);
  // Keyboard events never leave the frame. An Escape the answer did not handle is reported once dispatch has
  // finished, so handlers registered later than this one still get to prevent it.
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.isComposing) return;
    setTimeout(() => {
      if (!event.defaultPrevented) post({ type: 'escape' });
    }, 0);
  });
  document.addEventListener('click', (event) => {
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!anchor || event.defaultPrevented) return;
    const url = new URL(anchor.href, location.href);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      event.preventDefault();
      post({ type: 'open-url', url: url.href });
      return;
    }
    const target = (anchor.getAttribute('target') || '').toLowerCase();
    if (target === '_top' || target === '_parent') event.preventDefault();
  });
})();`
}
