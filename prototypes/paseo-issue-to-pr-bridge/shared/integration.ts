import type {
  CheckoutCommitResult,
  CheckoutPullRequestIdentity,
  CheckoutPullRequestStatus,
  CheckoutPushResult,
  CheckoutStatus,
  CreateCheckoutPullRequestInput
} from './checkout'
import type { GitHubIssue } from './github'
import type { PrototypeLedger } from './model'

export type P3IntegrationRequest =
  | { type: 'github-issue-detail'; repository: string; number: number }
  | { type: 'github-issue-create-work-item'; repository: string; number: number }
  | { type: 'github-pull-request-refresh'; nodeId: string }
  | { type: 'checkout-status'; workspaceNodeId: string }
  | { type: 'checkout-commit'; workspaceNodeId: string; message: string }
  | { type: 'checkout-push'; workspaceNodeId: string }
  | {
      type: 'checkout-create-pull-request'
      workspaceNodeId: string
      input: CreateCheckoutPullRequestInput
    }
  | { type: 'checkout-pull-request-status'; workspaceNodeId: string }
  | {
      type: 'open-github-resource'
      repository: string
      resource: 'issues' | 'pull'
      number: number
    }

export type P3IntegrationSuccess =
  | { type: 'github-issue-detail'; issue: GitHubIssue }
  | { type: 'github-issue-create-work-item'; ledger: PrototypeLedger }
  | { type: 'github-pull-request-refresh'; ledger: PrototypeLedger }
  | { type: 'checkout-status'; status: CheckoutStatus }
  | { type: 'checkout-commit'; result: CheckoutCommitResult }
  | { type: 'checkout-push'; result: CheckoutPushResult }
  | {
      type: 'checkout-create-pull-request'
      pullRequest: CheckoutPullRequestIdentity
      ledger: PrototypeLedger
      warning: P3IntegrationError | null
    }
  | {
      type: 'checkout-pull-request-status'
      status: CheckoutPullRequestStatus
      ledger: PrototypeLedger
      warning: P3IntegrationError | null
    }
  | { type: 'open-github-resource' }

export type P3IntegrationErrorKind =
  | 'auth'
  | 'repository'
  | 'network'
  | 'not-found'
  | 'timeout'
  | 'invalid-response'
  | 'command'
  | 'unavailable'
  | 'missing-workspace'
  | 'check'
  | 'mutation'
  | 'invalid-request'

export type P3IntegrationError = {
  kind: P3IntegrationErrorKind
  message: string
}

export type P3IntegrationResult =
  | { ok: true; value: P3IntegrationSuccess }
  | { ok: false; error: P3IntegrationError }

export function isP3IntegrationRequest(value: unknown): value is P3IntegrationRequest {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  switch (value.type) {
    case 'github-issue-detail':
    case 'github-issue-create-work-item':
      return (
        hasOnlyKeys(value, ['type', 'repository', 'number']) &&
        isRepository(value.repository) &&
        isPositiveInteger(value.number)
      )
    case 'github-pull-request-refresh':
      return hasOnlyKeys(value, ['type', 'nodeId']) && hasText(value.nodeId)
    case 'checkout-status':
    case 'checkout-push':
    case 'checkout-pull-request-status':
      return hasOnlyKeys(value, ['type', 'workspaceNodeId']) && hasText(value.workspaceNodeId)
    case 'checkout-commit':
      return (
        hasOnlyKeys(value, ['type', 'workspaceNodeId', 'message']) &&
        hasText(value.workspaceNodeId) &&
        hasText(value.message)
      )
    case 'checkout-create-pull-request':
      return (
        hasOnlyKeys(value, ['type', 'workspaceNodeId', 'input']) &&
        hasText(value.workspaceNodeId) &&
        isCreatePullRequestInput(value.input)
      )
    case 'open-github-resource':
      return (
        hasOnlyKeys(value, ['type', 'repository', 'resource', 'number']) &&
        isRepository(value.repository) &&
        (value.resource === 'issues' || value.resource === 'pull') &&
        isPositiveInteger(value.number)
      )
    default:
      return false
  }
}

function isCreatePullRequestInput(value: unknown): value is CreateCheckoutPullRequestInput {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['title', 'body', 'baseBranch']) &&
    hasText(value.title) &&
    typeof value.body === 'string' &&
    (value.baseBranch === undefined || hasText(value.baseBranch))
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(record).every((key) => keys.includes(key))
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function isRepository(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value.trim())
}
