import type { PrototypeCommandService } from './commandService'
import type { PrototypeLedger } from '../shared/model'

export type SnapshotPublicationTarget = {
  isDestroyed(): boolean
  send(snapshot: PrototypeLedger): void
}

export function registerSnapshotPublication(
  service: Pick<PrototypeCommandService, 'subscribe'>,
  target: SnapshotPublicationTarget
): () => void {
  return service.subscribe((snapshot) => {
    if (!target.isDestroyed()) target.send(snapshot)
  })
}
