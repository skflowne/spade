import {
  applyPrototypeCommand,
  createInitialLedger,
  type PrototypeCommand
} from '../shared/commands'
import type { PrototypeLedger } from '../shared/model'

export type PrototypeLedgerStore = {
  load(): Promise<PrototypeLedger | null>
  save(ledger: PrototypeLedger): Promise<void>
}

export class PrototypeCommandService {
  private ledger: PrototypeLedger | null = null
  private executionQueue: Promise<void> = Promise.resolve()

  constructor(private readonly store: PrototypeLedgerStore) {}

  async initialize(seed?: PrototypeLedger): Promise<PrototypeLedger> {
    const stored = await this.store.load()
    const initial = stored ?? seed ?? createInitialLedger('project-p3', 'P3 prototype')
    if (!stored) await this.store.save(initial)
    this.ledger = initial
    return this.snapshot()
  }

  snapshot(): PrototypeLedger {
    if (!this.ledger) throw new Error('Prototype command service is not initialized.')
    return structuredClone(this.ledger)
  }

  execute(command: PrototypeCommand): Promise<PrototypeLedger> {
    const operation = this.executionQueue.then(async () => {
      const current = this.snapshot()
      const next = applyPrototypeCommand(current, command).ledger
      await this.store.save(next)
      this.ledger = next
      return this.snapshot()
    })
    this.executionQueue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }
}
