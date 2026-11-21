import { sameWebAddress } from './webAddress'

export type LocatorTimer = {
  // Returns a function that cancels the callback.
  schedule(callback: () => void, delayMs: number): () => void
}

const realTimer: LocatorTimer = {
  schedule(callback, delayMs) {
    const handle = setTimeout(callback, delayMs)
    return () => clearTimeout(handle)
  }
}

const RECENT_WRITES = 4

type LocatorOptions = {
  // The URL the node's record holds.
  saved: string
  delayMs: number
  write(url: string): void
  timer?: LocatorTimer
}

// Keeps a web page node's durable URL in step with its guest (plan §7.3) without writing the record on
// every navigation: only the address a navigation chain settles on is written, and never an unchanged one.
export class LocatorPersistence {
  private saved: string
  private pending: string | null = null
  // Writes whose echo may still be on its way back; a quick later write can overtake an earlier one's echo.
  private readonly recentWrites: string[] = []
  private cancel: (() => void) | null = null
  private readonly timer: LocatorTimer

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
    if (sameWebAddress(url, this.saved) || this.recentWrites.some((written) => sameWebAddress(url, written))) return false
    this.saved = url
    if (this.pending !== null) {
      this.cancel?.()
      this.cancel = null
      this.pending = null
    }
    return true
  }

  flush(): void {
    this.cancel?.()
    this.cancel = null
    const url = this.pending
    this.pending = null
    if (url === null || sameWebAddress(url, this.saved)) return
    this.saved = url
    this.recentWrites.push(url)
    if (this.recentWrites.length > RECENT_WRITES) this.recentWrites.shift()
    this.options.write(url)
  }
}
