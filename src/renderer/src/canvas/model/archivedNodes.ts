import type { CanvasIndex } from './canvasIndex'

// Archived nodes the user can bring back. Each entry is the top of an archived stretch of a tree: an archived
// node whose parent is not archived. Archived descendants are counted in their entry.
export type ArchivedEntry = {
  nodeId: string
  title: string
  entityType: string
  // When the node was archived; archiving is its last change.
  archivedAt: string
  // Archived nodes in its branch, itself included: what Restore branch brings back.
  archivedInBranch: number
  // Every descendant, archived or not: what Remove branch removes.
  descendantCount: number
}

// Most recently archived first.
export function archivedEntries(index: CanvasIndex): ArchivedEntry[] {
  const { tree, byId } = index
  const entries: ArchivedEntry[] = []
  for (const node of index.canvas.nodes) {
    if (!node.archived) continue
    const parent = tree.parentOf(node.id)
    if (parent !== null && byId.get(parent)?.archived) continue
    const descendants = tree.descendantsOf(node.id)
    entries.push({
      nodeId: node.id,
      title: node.title,
      entityType: node.entityType,
      archivedAt: node.updatedAt,
      archivedInBranch: 1 + descendants.filter((id) => byId.get(id)?.archived).length,
      descendantCount: descendants.length
    })
  }
  return entries.sort((a, b) => b.archivedAt.localeCompare(a.archivedAt))
}

// The nodes archiving `nodeId` (with its branch, or alone) would archive now: what undoing it must restore,
// and nothing archived before.
export function newlyArchived(index: CanvasIndex, nodeId: string, branch: boolean): string[] {
  if (!index.byId.has(nodeId)) return []
  const affected = branch ? index.tree.branchOf(nodeId) : [nodeId]
  return affected.filter((id) => index.byId.get(id)?.archived === false)
}

// The entry an archived node is listed under; null when the node is not archived.
export function archivedEntryOf(index: CanvasIndex, nodeId: string): string | null {
  if (!index.byId.get(nodeId)?.archived) return null
  let entry = nodeId
  for (const ancestor of [...index.pathTo(nodeId)].reverse().slice(1)) {
    if (!index.byId.get(ancestor)?.archived) break
    entry = ancestor
  }
  return entry
}
