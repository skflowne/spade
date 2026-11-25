// Relative shared imports: this module is also loaded by plain Playwright specs, which do not resolve `@shared`.
import type { AgentProviderInfo, PaseoConnection } from '../../../../shared/agents'
import type { Result } from '../../../../shared/ipc'

export type ProvidersState = {
  status: 'idle' | 'loading' | 'ready' | 'failed'
  providers: readonly AgentProviderInfo[]
}

// Paseo's provider discovery, read once per connection for every mode selector. Another daemon, or the
// same one connected again, may offer other providers, so what was read is read again after either.
export class ProviderCatalog {
  private state: ProvidersState = { status: 'idle', providers: [] }
  private connection: Pick<PaseoConnection, 'state' | 'url'> | null = null
  // Bumped whenever what was read goes stale; an answer to an older read is dropped.
  private generation = 0
  private readonly listeners = new Set<() => void>()

  constructor(private readonly list: () => Promise<Result<{ providers: AgentProviderInfo[] }>>) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly snapshot = (): ProvidersState => this.state

  observe(connection: Pick<PaseoConnection, 'state' | 'url'>): void {
    const previous = this.connection
    this.connection = { state: connection.state, url: connection.url }
    const madeAgain =
      connection.state === 'connected' && previous !== null && (previous.state !== 'connected' || previous.url !== connection.url)
    if (!madeAgain || this.state.status === 'idle') return
    this.generation += 1
    // The last providers stay shown until the new read answers.
    this.set({ ...this.state, status: 'idle' })
  }

  // Reads the providers unless they are known or being read; a failed read is tried again.
  load(): void {
    if (this.state.status === 'loading' || this.state.status === 'ready') return
    const generation = this.generation
    this.set({ ...this.state, status: 'loading' })
    const settle = (next: ProvidersState): void => {
      if (generation === this.generation) this.set(next)
    }
    this.list().then(
      (result) => settle(result.ok ? { status: 'ready', providers: result.providers } : { status: 'failed', providers: [] }),
      () => settle({ status: 'failed', providers: [] })
    )
  }

  private set(next: ProvidersState): void {
    this.state = next
    for (const listener of this.listeners) listener()
  }
}
