import type {
  CheckoutCommitResult,
  CheckoutPullRequestIdentity,
  CheckoutPullRequestStatus,
  CheckoutPushResult,
  CheckoutStatus,
  CreateCheckoutPullRequestInput
} from '../shared/checkout'

export type CheckoutAdapterErrorKind = 'unavailable' | 'missing-workspace' | 'check' | 'mutation'

export class CheckoutAdapterError extends Error {
  constructor(readonly kind: CheckoutAdapterErrorKind, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CheckoutAdapterError'
  }
}

// The single SpadePaseoAdapter introduced by #18 implements this checkout-only surface.
export type CheckoutMutationOutcome<Result> = {
  result: Result | null
  warning: CheckoutAdapterError | null
}

export type SpadePaseoCheckoutAdapter = {
  checkoutStatus(workspaceId: string): Promise<CheckoutStatus>
  checkoutCommit(workspaceId: string, message: string): Promise<CheckoutMutationOutcome<CheckoutCommitResult>>
  checkoutPush(workspaceId: string): Promise<CheckoutMutationOutcome<CheckoutPushResult>>
  checkoutCreatePullRequest(
    workspaceId: string,
    input: CreateCheckoutPullRequestInput
  ): Promise<CheckoutPullRequestIdentity>
  checkoutPullRequestStatus(workspaceId: string): Promise<CheckoutPullRequestStatus>
}
