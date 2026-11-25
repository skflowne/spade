// Relative shared imports: this module is also loaded by plain Playwright specs, which do not resolve `@shared`.
import type { Canvas } from '../../../shared/domain'

// Pushes arrive as structured clones, so nothing in them is identical to what the renderer already holds.
// Sharing keeps every previous object that is equal in value to its incoming counterpart, so components
// memoized on a record (node wrappers, entity bodies) re-render only for the records that changed.

export function shareCanvas(previous: Canvas | undefined, next: Canvas): Canvas {
  if (previous === undefined || previous.projectId !== next.projectId) return next
  const shared: Canvas = {
    ...next,
    nodes: shareRecords(previous.nodes, next.nodes),
    edges: shareRecords(previous.edges, next.edges),
    workspaces: shareRecords(previous.workspaces, next.workspaces),
    activity: shareRecords(previous.activity, next.activity),
    viewport: sameValue(previous.viewport, next.viewport) ? previous.viewport : next.viewport
  }
  // Cheap: shared lists compare by identity, and a changed list differs at its first replaced record.
  return sameValue(shared, previous) ? previous : shared
}

// Records matched by id. The previous list itself is kept when every record is reused in the same order.
export function shareRecords<Entry extends { id: string }>(previous: readonly Entry[], next: Entry[]): Entry[] {
  const byId = new Map(previous.map((entry) => [entry.id, entry]))
  const shared = next.map((entry) => {
    const old = byId.get(entry.id)
    return old !== undefined && sameValue(old, entry) ? old : entry
  })
  const reused = shared.length === previous.length && shared.every((entry, index) => entry === previous[index])
  return reused ? (previous as Entry[]) : shared
}

// Deep equality of plain data: what crosses IPC (objects, arrays, and primitives).
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const other = b as unknown[]
    return a.length === other.length && a.every((item, index) => sameValue(item, other[index]))
  }
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((key) => key in right && sameValue(left[key], right[key]))
}
