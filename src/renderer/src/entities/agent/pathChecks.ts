import { hasImageExtension } from '../../../../shared/artifacts'
import type { PathInfo } from '../../../../shared/ipc'
import { isPathInside, isSamePath, pathKey } from '../../../../shared/paths'

// Existence checks for the paths one conversation shows (plan §7.1). Lazy, shared between every chip showing
// the same path, and never final when negative: a missing path may appear (an edit tool's file is checked
// before the tool ran) and a failed bridge call says nothing about the path.
//
// A network (UNC) path outside the project root is never touched because of text in a conversation: it stays
// 'unchecked' without any bridge call until the user asks for that very path. The main process enforces the
// same rule; checking here as well keeps such a path from even reaching it.

// A negative result older than this is checked again after the conversation changed. Younger ones are kept,
// or every streamed chunk would check every visible missing path again.
export const NEGATIVE_RECHECK_MS = 1000

export type PathCheck = { status: 'done'; info: PathInfo; checkedAt: number } | { status: 'failed'; checkedAt: number }

export type PathCheckOptions = {
  // An explicit check is one the user asked for on this very path.
  explicit?: boolean
  // Checks a missing or failed path again at once (the user clicked it).
  refresh?: boolean
}

type Dependencies = {
  projectRoot: string
  // Rejects when the bridge call fails.
  inspect(path: string, explicit: boolean): Promise<PathInfo>
  now(): number
}

export class PathChecks {
  private readonly results = new Map<string, PathCheck>()
  private readonly pending = new Map<string, Promise<PathCheck>>()
  // Negative results to check again on the next passive check.
  private readonly expired = new Set<string>()
  // Network paths the user checked explicitly; the main process allows them for the session too.
  private readonly approved = new Set<string>()
  private readonly listeners = new Set<() => void>()

  constructor(private readonly dependencies: Dependencies) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // The last settled result; a re-check in flight keeps it visible.
  get(path: string): PathCheck | undefined {
    return this.results.get(path)
  }

  // Whether a passive call may touch the path: anything but a network path outside the project root that the
  // user has not checked explicitly.
  mayTouch(path: string): boolean {
    const key = pathKey(path)
    if (!key.startsWith('\\\\')) return true
    const root = this.dependencies.projectRoot
    return isSamePath(path, root) || isPathInside(path, root) || this.approved.has(key)
  }

  approve(path: string): void {
    this.approved.add(pathKey(path))
  }

  check(path: string, { explicit = false, refresh = false }: PathCheckOptions = {}): Promise<PathCheck> {
    if (!explicit) {
      const pending = this.pending.get(path)
      if (pending) return pending
      const current = this.results.get(path)
      if (current && !(isNegative(current) && (refresh || this.expired.has(path)))) return Promise.resolve(current)
      if (!this.mayTouch(path)) {
        return Promise.resolve(this.settle(path, { status: 'done', info: unchecked(path), checkedAt: this.dependencies.now() }))
      }
    }
    const run: Promise<PathCheck> = this.dependencies
      .inspect(path, explicit)
      .then(
        (info): PathCheck => {
          if (explicit && info.kind !== 'unchecked') this.approve(path)
          return { status: 'done', info, checkedAt: this.dependencies.now() }
        },
        (): PathCheck => ({ status: 'failed', checkedAt: this.dependencies.now() })
      )
      .then((result) => {
        if (this.pending.get(path) === run) this.pending.delete(path)
        return this.settle(path, result)
      })
    this.pending.set(path, run)
    return run
  }

  // The conversation changed: negative results old enough are checked again by the next check of their path.
  // Returns how long until the younger ones are old enough (the caller expires again then), or null.
  expireNegatives(): number | null {
    const now = this.dependencies.now()
    let wait: number | null = null
    for (const [path, result] of this.results) {
      if (!isNegative(result) || this.expired.has(path)) continue
      const age = now - result.checkedAt
      if (age >= NEGATIVE_RECHECK_MS) this.expired.add(path)
      else wait = Math.min(wait ?? NEGATIVE_RECHECK_MS, NEGATIVE_RECHECK_MS - age)
    }
    return wait
  }

  private settle(path: string, result: PathCheck): PathCheck {
    this.results.set(path, result)
    this.expired.delete(path)
    for (const listener of this.listeners) listener()
    return result
  }
}

function isNegative(result: PathCheck): boolean {
  return result.status === 'failed' || result.info.kind === 'missing'
}

function unchecked(path: string): PathInfo {
  return { input: path, absolutePath: path, kind: 'unchecked', isImage: hasImageExtension(path), line: null }
}
