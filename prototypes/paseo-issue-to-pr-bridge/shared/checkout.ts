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

export type SelectedCheckoutStatus = {
  workspaceNodeId: string
  status: CheckoutStatus
}

export function bindCheckoutStatus(
  requestedWorkspaceNodeId: string,
  selectedWorkspaceNodeId: string,
  status: CheckoutStatus
): SelectedCheckoutStatus | null {
  return requestedWorkspaceNodeId === selectedWorkspaceNodeId
    ? { workspaceNodeId: requestedWorkspaceNodeId, status }
    : null
}

export function checkoutStatusForSelection(
  selected: SelectedCheckoutStatus | null,
  workspaceNodeId: string
): CheckoutStatus | null {
  return selected?.workspaceNodeId === workspaceNodeId ? selected.status : null
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
