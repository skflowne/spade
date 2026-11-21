// Keyboard focus on canvas nodes. A node's header is its keyboard stop (Tab reaches it, Enter activates the body).

export function nodeHeader(nodeId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.spade-node[data-node-id="${CSS.escape(nodeId)}"] [data-testid="node-header"]`)
}

// Moves keyboard focus to a node's header once it is rendered; a node just revealed may take a few frames.
export function focusNodeHeader(nodeId: string, attempts = 30): void {
  const header = nodeHeader(nodeId)
  if (header) header.focus({ preventScroll: true })
  else if (attempts > 0) requestAnimationFrame(() => focusNodeHeader(nodeId, attempts - 1))
}

export function isOnNodeHeader(element: Element | null): boolean {
  return element?.closest('[data-testid="node-header"]') != null
}
