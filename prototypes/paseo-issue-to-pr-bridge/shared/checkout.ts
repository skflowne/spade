export type CheckoutStatus = {
  workspaceId: string
  branch: string | null
  headRevision: string
  baseRef: string | null
  changedFiles: number
  additions: number
  deletions: number
  stagedFiles: number
  unstagedFiles: number
  untrackedFiles: number
  conflicts: number
}

export type CheckoutCommitResult = {
  revision: string
}

export type CheckoutPushResult = {
  remote: string
  branch: string
}

export type CheckoutPullRequestIdentity = {
  repository: string
  number: number
  url: string
}

export type CheckoutPullRequestStatus = {
  pullRequest: CheckoutPullRequestIdentity | null
  state: 'OPEN' | 'CLOSED' | 'MERGED' | null
}

export type CreateCheckoutPullRequestInput = {
  title: string
  body: string
  baseBranch?: string
}
