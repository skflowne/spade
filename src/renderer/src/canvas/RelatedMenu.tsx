import type { CanvasNode } from '@shared/domain'
import { entities } from '../entities'
import { MenuButton, type MenuItem } from '../ui/Menu'
import { useCanvasActions } from './CanvasContext'
import { archivedEntryOf } from './model/archivedNodes'
import { canvasIndex } from './model/canvasIndex'
import { icons, type Icon } from '../ui/icons'

// Incoming and outgoing provenance controls (plan §6): the parent, the children, and the references of a node,
// each one a jump. The trigger doubles as the context-sharing indicator: it shows the reference count.
export function RelatedMenu({ record, referenceCount }: { record: CanvasNode; referenceCount: number }): React.JSX.Element {
  const actions = useCanvasActions()
  const label = referenceCount > 0 ? `Related nodes (${referenceCount} ${referenceCount === 1 ? 'reference' : 'references'})` : 'Related nodes'

  const items = (): MenuItem[] => {
    const index = canvasIndex(actions.getCanvas())
    const node = (id: string): CanvasNode | undefined => index.byId.get(id)
    const typeOf = (entry: CanvasNode): string =>
      entities.has(entry.entityType) ? entities.resolve(entry.entityType).displayName : entry.entityType
    const jump = (entry: CanvasNode, Direction: Icon, detail?: string): MenuItem =>
      entry.archived
        ? {
            label: entry.title,
            icon: <Direction />,
            detail: 'Archived',
            onSelect: () => actions.openPanel('archived', archivedEntryOf(index, entry.id) ?? undefined)
          }
        : { label: entry.title, icon: <Direction />, detail: detail ?? typeOf(entry), onSelect: () => actions.focusNode(entry.id) }

    const parentId = index.tree.parentOf(record.id)
    const parent = parentId === null ? undefined : node(parentId)
    const children = index.tree.childrenOf(record.id).flatMap((id) => node(id) ?? [])
    const references = index.referencesOf(record.id)

    return [
      { heading: 'Parent' },
      parent ? jump(parent, icons.parent) : { label: 'None: this node is a root', onSelect: () => {}, disabled: true },
      { heading: `Children (${children.length})` },
      ...(children.length > 0 ? children.map((child) => jump(child, icons.child)) : [{ label: 'None', onSelect: () => {}, disabled: true }]),
      { heading: `References (${references.length})` },
      ...references.flatMap((reference) => {
        const other = node(reference.otherNodeId)
        if (!other) return []
        const direction = reference.direction === 'out' ? 'references' : 'referenced by'
        return [jump(other, reference.direction === 'out' ? icons.referenceOut : icons.referenceIn, reference.edge.label ?? direction)]
      }),
      'separator',
      { label: 'Connect existing…', onSelect: () => void actions.connectExisting(record.id) }
    ]
  }

  return (
    <MenuButton
      label={label}
      menuLabel={`Related to ${record.title}`}
      className={referenceCount > 0 ? 'cr-icon-button spade-node__related spade-node__related--shared' : 'cr-icon-button spade-node__related'}
      items={items}
      testId="related-nodes"
    >
      <icons.related aria-hidden="true" />
      {referenceCount > 0 ? (
        <span className="spade-node__reference-count" data-testid="reference-count" aria-hidden="true">
          {referenceCount}
        </span>
      ) : null}
    </MenuButton>
  )
}
