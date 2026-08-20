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

export function isGitHubIssue(value: unknown): value is GitHubIssue {
  if (!isRecord(value)) return false
  return (
    isRepository(value.repository) &&
    isPositiveInteger(value.number) &&
    typeof value.title === 'string' &&
    (value.state === 'OPEN' || value.state === 'CLOSED') &&
    Array.isArray(value.labels) &&
    value.labels.every((label) => typeof label === 'string') &&
    typeof value.body === 'string' &&
    isResourceUrl(value.url, value.repository, 'issues', value.number) &&
    isTimestamp(value.updatedAt)
  )
}

export function isGitHubPullRequest(value: unknown): value is GitHubPullRequest {
  if (!isRecord(value)) return false
  return (
    isRepository(value.repository) &&
    isPositiveInteger(value.number) &&
    typeof value.title === 'string' &&
    ['OPEN', 'CLOSED', 'MERGED'].includes(String(value.state)) &&
    typeof value.author === 'string' &&
    isResourceUrl(value.url, value.repository, 'pull', value.number) &&
    typeof value.baseBranch === 'string' &&
    typeof value.headBranch === 'string' &&
    typeof value.latestRevision === 'string' &&
    isTimestamp(value.updatedAt) &&
    Array.isArray(value.checks) &&
    value.checks.every(isCheck) &&
    Array.isArray(value.reviews) &&
    value.reviews.every(isReview) &&
    Array.isArray(value.comments) &&
    value.comments.every(isComment) &&
    Array.isArray(value.reviewComments) &&
    value.reviewComments.every(isReviewComment)
  )
}

function isCheck(value: unknown): value is GitHubCheck {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    ['passed', 'failed', 'pending', 'skipped'].includes(String(value.state)) &&
    (value.url === null || isHttpUrl(value.url))
  )
}

function isReview(value: unknown): value is GitHubReview {
  return (
    isRecord(value) &&
    typeof value.author === 'string' &&
    typeof value.state === 'string' &&
    typeof value.body === 'string' &&
    isTimestamp(value.submittedAt)
  )
}

function isComment(value: unknown): value is GitHubComment {
  return (
    isRecord(value) &&
    typeof value.author === 'string' &&
    typeof value.body === 'string' &&
    isTimestamp(value.createdAt)
  )
}

function isReviewComment(value: unknown): value is GitHubReviewComment {
  return isComment(value) && typeof (value as GitHubReviewComment).path === 'string'
}

function isResourceUrl(
  value: unknown,
  repository: unknown,
  resourcePath: 'issues' | 'pull',
  number: unknown
): boolean {
  if (typeof value !== 'string' || typeof repository !== 'string' || !isPositiveInteger(number)) {
    return false
  }
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      url.hostname.toLowerCase() === 'github.com' &&
      url.pathname.toLowerCase() === `/${repository}/${resourcePath}/${number}`.toLowerCase() &&
      url.search === '' &&
      url.hash === ''
    )
  } catch {
    return false
  }
}

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRepository(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}
