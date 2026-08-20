export type GitHubIssueState = 'OPEN' | 'CLOSED'
export type GitHubPullRequestState = 'OPEN' | 'CLOSED' | 'MERGED'
export type GitHubCheckState = 'passed' | 'failed' | 'pending' | 'skipped'

export type GitHubIssue = {
  repository: string
  number: number
  title: string
  state: GitHubIssueState
  labels: string[]
  body: string
  url: string
  updatedAt: string
}

export type GitHubCheck = {
  name: string
  state: GitHubCheckState
  url: string | null
}

export type GitHubReview = {
  author: string
  state: string
  body: string
  submittedAt: string
}

export type GitHubComment = {
  author: string
  body: string
  createdAt: string
}

export type GitHubReviewComment = GitHubComment & {
  path: string
}

export type GitHubPullRequest = {
  repository: string
  number: number
  title: string
  state: GitHubPullRequestState
  author: string
  url: string
  baseBranch: string
  headBranch: string
  latestRevision: string
  updatedAt: string
  checks: GitHubCheck[]
  reviews: GitHubReview[]
  comments: GitHubComment[]
  reviewComments: GitHubReviewComment[]
}

export function githubResourceId(repository: string, number: number): string {
  return `${repository}#${number}`
}
