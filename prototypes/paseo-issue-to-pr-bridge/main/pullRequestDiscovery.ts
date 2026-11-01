import type { P3IntegrationRequest, P3IntegrationResult } from '../shared/integration'
import type { PrototypeLedger } from '../shared/model'

export type PullRequestDiscoveryOptions = {
  integrate(request: Extract<P3IntegrationRequest, { type: 'checkout-pull-request-status' }>): Promise<P3IntegrationResult>
  retryAfterMs?: number
  now?: () => number
}

const DEFAULT_RETRY_AFTER_MS = 60_000

// Workflows may open pull requests outside SPADE's checkout actions. After each published snapshot,
// every connected, bound Paseo workspace with a branch and no derived PullRequest is asked for its
// pull request through the same generic checkout-status integration a user would invoke.
export class PullRequestDiscovery {
  private readonly retryAfterMs: number
  private readonly now: () => number
  private readonly lastAttemptByKey = new Map<string, number>()
  private latest: PrototypeLedger | null = null
  private running: Promise<void> | null = null

  constructor(private readonly options: PullRequestDiscoveryOptions) {
    this.retryAfterMs = options.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS
    this.now = options.now ?? Date.now
  }

  observe(ledger: PrototypeLedger): Promise<void> {
    this.latest = ledger
    this.running ??= this.drain().finally(() => {
      this.running = null
    })
    return this.running
  }

  private async drain(): Promise<void> {
    while (this.latest) {
      const ledger = this.latest
      this.latest = null
      for (const workspaceNodeId of this.candidates(ledger)) {
        await this.options.integrate({ type: 'checkout-pull-request-status', workspaceNodeId })
      }
    }
  }

  private candidates(ledger: PrototypeLedger): string[] {
    if (ledger.paseo.connection !== 'connected') return []
    const boundWorkItems = new Set(ledger.paseo.bindings.map(({ workItemId }) => workItemId))
    const pullRequestNodeIds = new Set(
      ledger.nodes.filter(({ kind }) => kind === 'github-pull-request').map(({ id }) => id)
    )
    const linkedSources = new Set(
      ledger.edges
        .filter(({ relation, toNodeId }) => relation === 'derived' && pullRequestNodeIds.has(toNodeId))
        .map(({ fromNodeId }) => fromNodeId)
    )
    const now = this.now()
    const result: string[] = []
    for (const node of ledger.nodes) {
      const runtime = node.paseo
      if (
        runtime?.type !== 'workspace' ||
        runtime.state !== 'connected' ||
        !runtime.branch ||
        !node.workItemId ||
        !boundWorkItems.has(node.workItemId) ||
        linkedSources.has(node.id)
      ) {
        continue
      }
      const key = `${node.id}\u0000${runtime.branch}`
      const lastAttempt = this.lastAttemptByKey.get(key)
      if (lastAttempt !== undefined && now - lastAttempt < this.retryAfterMs) continue
      this.lastAttemptByKey.set(key, now)
      result.push(node.id)
    }
    return result
  }
}
