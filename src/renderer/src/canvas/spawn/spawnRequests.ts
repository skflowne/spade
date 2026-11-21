// Relative shared imports: this module is also loaded by plain Playwright specs, which do not resolve `@shared`.
import type { CanvasCommandResponse } from '../../../../shared/commands'

// One spawn dialog at a time. Every dialog is a request with its own answer, and a creation only ever acts
// on the request that started it: a dialog the user closed while its node was still being created lets the
// node appear without taking focus, and never closes, answers, or focuses for a later dialog.

export type SpawnEntry<Mode> = {
  readonly id: number
  readonly mode: Mode
  // The created node's id; null when the user cancelled before creating, or the creation failed after the
  // user closed the dialog.
  readonly result: Promise<string | null>
}

type Entry<Mode> = SpawnEntry<Mode> & { creating: boolean; dismissed: boolean; settle(nodeId: string | null): void }

export type SpawnRequestEvents<Mode> = {
  // The dialog to show, or null for none.
  show(entry: SpawnEntry<Mode> | null): void
  // A node created from the dialog the user is still looking at.
  focusCreated(nodeId: string): void
}

export class SpawnRequests<Mode> {
  private shown: Entry<Mode> | null = null
  private counter = 0

  constructor(private readonly events: SpawnRequestEvents<Mode>) {}

  get current(): SpawnEntry<Mode> | null {
    return this.shown
  }

  // Shows a new dialog; the one shown before is dismissed.
  open(mode: Mode): SpawnEntry<Mode> {
    if (this.shown) this.dismiss(this.shown)
    let settle!: (nodeId: string | null) => void
    const result = new Promise<string | null>((resolve) => (settle = resolve))
    this.counter += 1
    const entry: Entry<Mode> = { id: this.counter, mode, result, creating: false, dismissed: false, settle }
    this.shown = entry
    this.events.show(entry)
    return entry
  }

  // The user closed the dialog. A creation already under way still completes, in the background.
  dismiss(request: SpawnEntry<Mode>): void {
    const entry = request as Entry<Mode>
    entry.dismissed = true
    if (this.shown === entry) {
      this.shown = null
      this.events.show(null)
    }
    if (!entry.creating) entry.settle(null)
  }

  async create(request: SpawnEntry<Mode>, run: () => Promise<CanvasCommandResponse>): Promise<CanvasCommandResponse> {
    const entry = request as Entry<Mode>
    entry.creating = true
    let response: CanvasCommandResponse
    try {
      response = await run()
    } finally {
      entry.creating = false
    }
    if (!response.ok) {
      // A dialog still shown keeps the failure for another try.
      if (entry.dismissed) entry.settle(null)
      return response
    }
    const nodeId = response.nodeId ?? null
    if (this.shown === entry) {
      this.shown = null
      this.events.show(null)
      if (nodeId !== null) this.events.focusCreated(nodeId)
    }
    entry.settle(nodeId)
    return response
  }
}
