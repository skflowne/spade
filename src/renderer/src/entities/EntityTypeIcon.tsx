import { icons } from '../ui/icons'
import { entityRenderers } from '.'

// The icon of an entity type; a type this build cannot show gets the unknown-type icon.
export function EntityTypeIcon({ type }: { type: string }): React.JSX.Element {
  const TypeIcon = entityRenderers.get(type)?.icon ?? icons.unknownType
  return <TypeIcon />
}
