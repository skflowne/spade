import { realTimer, type Timer } from './timer'
import { sameWebAddress } from './webAddress'

const RECENT_WRITES = 4

type LocatorOptions = {
  // The URL the node's record holds.
  saved: string
  delayMs: number
  write(url: string): void
  timer?: Timer
}

// Keeps a web page node's durable URL in step with its guest (plan §7.3) without writing the record on
// every navigation: only the address a navigation chain settles on is written, and never an unchanged one.
export class LocatorPersistence {
  private saved: string
  private pending: string | null = null
  // Own writes whose echo has not come back yet, oldest first. Each echo is expected once: the record reports
  // changes in order, so an echo also stands for the earlier ones it overtook, and a later change to the same
  // address is another writer's.
  private readonly unechoed: string[] = []
  private cancel: (() => void) | null = null
  private readonly timer: Timer

  constructor(private readonly options: LocatorOptions) {
    this.saved = options.saved
    this.timer = options.timer ?? realTimer
  }

  // The guest committed a main-frame navigation.
  navigated(url: string): void {
    this.cancel?.()
    this.cancel = null
    if (sameWebAddress(url, this.saved)) {
      this.pending = null
      return
    }
    this.pending = url
    this.cancel = this.timer.schedule(() => this.flush(), this.options.delayMs)
  }

  // The record's URL changed. True when another writer changed it (the guest should follow); false when it
  // is this locator's own write coming back.
  recordChanged(url: string): boolean {
    const echo = this.unechoed.findIndex((written) => sameWebAddress(url, written))
    if (echo !== -1) {
      this.unechoed.splice(0, echo + 1)
      return false
    }
    if (sameWebAddress(url, this.saved)) return false
    this.saved = url
    // Any echo still expected was overtaken by this change and will not be reported.
    this.unechoed.length = 0
    this.cancel?.()
    this.cancel = null
    this.pending = null
    return true
  }

  flush(): void {
    this.cancel?.()
    this.cancel = null
    const url = this.pending
    this.pending = null
    if (url === null || sameWebAddress(url, this.saved)) return
    this.saved = url
    this.unechoed.push(url)
    if (this.unechoed.length > RECENT_WRITES) this.unechoed.shift()
    this.options.write(url)
  }
}
