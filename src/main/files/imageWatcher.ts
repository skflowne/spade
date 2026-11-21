import { unwatchFile, watchFile, type Stats } from 'node:fs'
import { pathKey } from '../../shared/paths'

export type ImageWatcherOptions = {
  // Least recently watched images stop being watched beyond this many.
  maxWatchedImages?: number
  pollIntervalMs?: number
  // Changes closer together than this are reported once.
  debounceMs?: number
}

type Watch = {
  path: string
  listener: (current: Stats, previous: Stats) => void
  timer: NodeJS.Timeout | null
}

// Watches individual image files by polling their status, never a directory. Polling follows the path,
// not the file, so it survives editors that replace a file by rename and files that disappear and return.
export class ImageWatcher {
  private readonly watches = new Map<string, Watch>()
  private readonly maxWatchedImages: number
  private readonly pollIntervalMs: number
  private readonly debounceMs: number
  private closed = false

  constructor(
    private readonly onChange: (path: string) => void,
    options: ImageWatcherOptions = {}
  ) {
    this.maxWatchedImages = options.maxWatchedImages ?? 256
    this.pollIntervalMs = options.pollIntervalMs ?? 1000
    this.debounceMs = options.debounceMs ?? 250
  }

  watch(path: string): void {
    if (this.closed) return
    const key = pathKey(path)
    const existing = this.watches.get(key)
    if (existing) {
      // Re-inserting marks it most recently used.
      this.watches.delete(key)
      this.watches.set(key, existing)
      return
    }

    const watch: Watch = { path, timer: null, listener: () => undefined }
    watch.listener = (current, previous) => {
      // A missing file reports zeroed status; one that stays missing is not a change.
      if (current.mtimeMs === previous.mtimeMs && current.size === previous.size && current.ino === previous.ino) return
      if (watch.timer) clearTimeout(watch.timer)
      watch.timer = setTimeout(() => {
        watch.timer = null
        this.onChange(watch.path)
      }, this.debounceMs)
    }
    watchFile(path, { interval: this.pollIntervalMs, persistent: false }, watch.listener)
    this.watches.set(key, watch)

    for (const [oldest] of this.watches) {
      if (this.watches.size <= this.maxWatchedImages) break
      this.release(oldest)
    }
  }

  close(): void {
    this.closed = true
    for (const key of [...this.watches.keys()]) this.release(key)
  }

  private release(key: string): void {
    const watch = this.watches.get(key)
    if (!watch) return
    this.watches.delete(key)
    if (watch.timer) clearTimeout(watch.timer)
    unwatchFile(watch.path, watch.listener)
  }
}
