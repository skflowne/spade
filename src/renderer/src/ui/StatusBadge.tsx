import type { NodeStatus } from '../entities/types'

export function StatusBadge({ status }: { status: NodeStatus }): React.JSX.Element {
  return (
    <span className={`cr-badge cr-badge--${status.tone}`} title={status.description}>
      {status.label}
    </span>
  )
}
