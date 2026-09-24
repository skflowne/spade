import { execFile } from 'node:child_process'
import type {
  GitHubCheck,
  GitHubCheckState,
  GitHubComment,
  GitHubIssue,
  GitHubIssueState,
  GitHubPullRequest,
  GitHubPullRequestState,
  GitHubReview,
  GitHubReviewComment
} from '../shared/github'

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const DELETED_GITHUB_ACTOR = 'Deleted user'

export type GitHubAdapterErrorKind =
  | 'auth'
  | 'repository'
  | 'network'
  | 'not-found'
  | 'timeout'
  | 'invalid-response'
  | 'command'

export class GitHubAdapterError extends Error {
  constructor(
    readonly kind: GitHubAdapterErrorKind,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'GitHubAdapterError'
  }
}

export type GhCommandResult = { stdout: string; stderr: string }
export type GhCommandRunner = (
  arguments_: readonly string[],
  signal: AbortSignal
) => Promise<GhCommandResult>

export const executeGhCommand: GhCommandRunner = (arguments_, signal) =>
  new Promise((resolve, reject) => {
    execFile(
      'gh',
      [...arguments_],
      { encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES, signal },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stderr }))
          return
        }
        resolve({ stdout, stderr })
      }
    )
  })

export class SpadeGitHubAdapter {
  constructor(
    private readonly runCommand: GhCommandRunner = executeGhCommand,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error('GitHub adapter timeout must be a positive number.')
    }
  }

  async getIssue(repository: string, number: number): Promise<GitHubIssue> {
    const target = validateRepository(repository)
    const issueNumber = validateNumber(number, 'issue')
    const result = await this.run([
      'issue',
      'view',
      String(issueNumber),
      '--repo',
      target,
      '--json',
      'number,title,state,labels,body,url,updatedAt'
    ])
    return parseIssue(result.stdout, target, issueNumber)
  }

  async getPullRequest(repository: string, number: number): Promise<GitHubPullRequest> {
    const target = validateRepository(repository)
    const pullRequestNumber = validateNumber(number, 'pull request')
    const [detail, reviewComments] = await Promise.all([
      this.run([
        'pr',
        'view',
        String(pullRequestNumber),
        '--repo',
        target,
        '--json',
        [
          'number',
          'title',
          'state',
          'author',
          'url',
          'baseRefName',
          'headRefName',
          'headRefOid',
          'updatedAt',
          'statusCheckRollup',
          'reviews',
          'comments'
        ].join(',')
      ]),
      this.run([
        'api',
        '--method',
        'GET',
        `repos/${target}/pulls/${pullRequestNumber}/comments`,
        '--paginate',
        '--slurp'
      ])
    ])
    return parsePullRequest(detail.stdout, reviewComments.stdout, target, pullRequestNumber)
  }

  private async run(arguments_: readonly string[]): Promise<GhCommandResult> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      return await this.runCommand(arguments_, controller.signal)
    } catch (error) {
      if (controller.signal.aborted) {
        throw new GitHubAdapterError(
          'timeout',
          `GitHub command timed out after ${this.timeoutMs}ms.`,
          { cause: error }
        )
      }
      throw classifyCommandError(error)
    } finally {
      clearTimeout(timeout)
    }
  }
}

export function parseIssue(
  serialized: string,
  repository: string,
  expectedNumber: number
): GitHubIssue {
  const target = validateRepository(repository)
  const issueNumber = validateNumber(expectedNumber, 'issue')
  const value = parseJson(serialized, 'GitHub issue')
  const record = requireRecord(value, 'GitHub issue')
  const responseNumber = requirePositiveInteger(record.number, 'GitHub issue number')
  const state = requireOneOf(record.state, ['OPEN', 'CLOSED'] as const, 'GitHub issue state')
  const labels = requireArray(record.labels, 'GitHub issue labels').map((label, index) =>
    requireString(requireRecord(label, `GitHub issue label ${index + 1}`).name, 'GitHub issue label name')
  )
  requireResourceIdentity(record.url, target, 'issues', issueNumber, responseNumber)

  return {
    repository: target,
    number: responseNumber,
    title: requireString(record.title, 'GitHub issue title'),
    state: state satisfies GitHubIssueState,
    labels,
    body: requireString(record.body, 'GitHub issue body', true),
    url: requireString(record.url, 'GitHub issue URL'),
    updatedAt: requireTimestamp(record.updatedAt, 'GitHub issue update timestamp')
  }
}

export function parsePullRequest(
  serialized: string,
  serializedReviewComments: string,
  repository: string,
  expectedNumber: number
): GitHubPullRequest {
  const target = validateRepository(repository)
  const pullRequestNumber = validateNumber(expectedNumber, 'pull request')
  const record = requireRecord(parseJson(serialized, 'GitHub pull request'), 'GitHub pull request')
  const responseNumber = requirePositiveInteger(record.number, 'GitHub pull request number')
  const state = requireOneOf(
    record.state,
    ['OPEN', 'CLOSED', 'MERGED'] as const,
    'GitHub pull request state'
  )
  requireResourceIdentity(record.url, target, 'pull', pullRequestNumber, responseNumber)

  return {
    repository: target,
    number: responseNumber,
    title: requireString(record.title, 'GitHub pull request title'),
    state: state satisfies GitHubPullRequestState,
    author: parseActor(record.author, 'GitHub pull request author'),
    url: requireString(record.url, 'GitHub pull request URL'),
    baseBranch: requireString(record.baseRefName, 'GitHub pull request base branch'),
    headBranch: requireString(record.headRefName, 'GitHub pull request head branch'),
    latestRevision: requireString(record.headRefOid, 'GitHub pull request latest revision'),
    updatedAt: requireTimestamp(record.updatedAt, 'GitHub pull request update timestamp'),
    checks: parseChecks(record.statusCheckRollup),
    reviews: parseReviews(record.reviews),
    comments: parseComments(record.comments),
    reviewComments: parseReviewComments(serializedReviewComments)
  }
}

function parseChecks(value: unknown): GitHubCheck[] {
  return requireArray(value, 'GitHub pull request checks').map((item, index) => {
    const check = requireRecord(item, `GitHub check ${index + 1}`)
    const type = requireString(check.__typename, 'GitHub check type')
    if (type === 'CheckRun') {
      const status = requireString(check.status, 'GitHub check status')
      const conclusion = check.conclusion === null
        ? null
        : requireString(check.conclusion, 'GitHub check conclusion')
      return {
        name: requireString(check.name, 'GitHub check name'),
        state: checkRunState(status, conclusion),
        url: optionalUrl(check.detailsUrl, 'GitHub check URL')
      }
    }
    if (type === 'StatusContext') {
      return {
        name: requireString(check.context, 'GitHub status context name'),
        state: statusContextState(requireString(check.state, 'GitHub status context state')),
        url: optionalUrl(check.targetUrl, 'GitHub status context URL')
      }
    }
    throw invalidResponse(`GitHub check ${index + 1} has unsupported type “${type}”.`)
  })
}

function parseReviews(value: unknown): GitHubReview[] {
  return requireArray(value, 'GitHub pull request reviews').map((item, index) => {
    const review = requireRecord(item, `GitHub review ${index + 1}`)
    return {
      author: parseActor(review.author, `GitHub review ${index + 1} author`),
      state: requireString(review.state, 'GitHub review state'),
      body: requireString(review.body, 'GitHub review body', true),
      submittedAt: requireTimestamp(review.submittedAt, 'GitHub review submission timestamp')
    }
  })
}

function parseComments(value: unknown): GitHubComment[] {
  return requireArray(value, 'GitHub pull request comments').map((item, index) => {
    const comment = requireRecord(item, `GitHub pull request comment ${index + 1}`)
    return {
      author: parseActor(comment.author, `GitHub pull request comment ${index + 1} author`),
      body: requireString(comment.body, 'GitHub pull request comment body', true),
      createdAt: requireTimestamp(comment.createdAt, 'GitHub pull request comment creation timestamp')
    }
  })
}

function parseReviewComments(serialized: string): GitHubReviewComment[] {
  const value = parseJson(serialized, 'GitHub pull request review comment pages')
  const pages = requireArray(value, 'GitHub pull request review comment pages')
  const comments = pages.flatMap((page, index) =>
    requireArray(page, `GitHub pull request review comment page ${index + 1}`)
  )
  return comments.map((item, index) => {
    const comment = requireRecord(item, `GitHub review comment ${index + 1}`)
    return {
      author: parseActor(comment.user, `GitHub review comment ${index + 1} author`),
      body: requireString(comment.body, 'GitHub review comment body', true),
      path: requireString(comment.path, 'GitHub review comment path'),
      createdAt: requireTimestamp(comment.created_at, 'GitHub review comment creation timestamp')
    }
  })
}

function parseActor(value: unknown, label: string): string {
  if (value === null) return DELETED_GITHUB_ACTOR
  return requireString(requireRecord(value, label).login, `${label} login`)
}

function checkRunState(status: string, conclusion: string | null): GitHubCheckState {
  const knownStatuses = ['QUEUED', 'IN_PROGRESS', 'COMPLETED', 'WAITING', 'REQUESTED', 'PENDING']
  if (!knownStatuses.includes(status)) throw invalidResponse(`GitHub check status “${status}” is invalid.`)
  if (status !== 'COMPLETED') return 'pending'

  const knownConclusions = [
    'ACTION_REQUIRED',
    'CANCELLED',
    'FAILURE',
    'NEUTRAL',
    'SKIPPED',
    'STALE',
    'STARTUP_FAILURE',
    'SUCCESS',
    'TIMED_OUT'
  ]
  if (conclusion === null || !knownConclusions.includes(conclusion)) {
    throw invalidResponse('Completed GitHub check conclusion is invalid.')
  }
  if (['SUCCESS', 'NEUTRAL'].includes(conclusion)) return 'passed'
  if (['SKIPPED', 'STALE'].includes(conclusion)) return 'skipped'
  return 'failed'
}

function statusContextState(state: string): GitHubCheckState {
  if (!['ERROR', 'EXPECTED', 'FAILURE', 'PENDING', 'SUCCESS'].includes(state)) {
    throw invalidResponse(`GitHub status context state “${state}” is invalid.`)
  }
  if (state === 'SUCCESS') return 'passed'
  if (['PENDING', 'EXPECTED'].includes(state)) return 'pending'
  return 'failed'
}

function parseJson(serialized: string, label: string): unknown {
  try {
    return JSON.parse(serialized)
  } catch (error) {
    throw invalidResponse(`${label} response is not valid JSON.`, error)
  }
}

function validateRepository(repository: string): string {
  const normalized = repository.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(normalized)) {
    throw new GitHubAdapterError(
      'repository',
      'GitHub repository must use the owner/name format.'
    )
  }
  return normalized.toLowerCase()
}

function validateNumber(value: number, kind: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new GitHubAdapterError('repository', `GitHub ${kind} number must be a positive integer.`)
  }
  return value
}

function classifyCommandError(error: unknown): GitHubAdapterError {
  const stderr = commandStderr(error)
  const normalized = stderr.toLowerCase()
  if (/auth|authentication|gh auth login|http 401|bad credentials/.test(normalized)) {
    return new GitHubAdapterError('auth', 'GitHub authentication failed. Run `gh auth login` and retry.', { cause: error })
  }
  if (/could not resolve host|network|connection|timed out|http 5\d\d/.test(normalized)) {
    return new GitHubAdapterError('network', 'GitHub could not be reached.', { cause: error })
  }
  if (/could not resolve to a repository|repository not found/.test(normalized)) {
    return new GitHubAdapterError('repository', 'GitHub repository was not found or is not accessible.', { cause: error })
  }
  if (/not found|no pull requests found|could not resolve to an issue/.test(normalized)) {
    return new GitHubAdapterError('not-found', 'GitHub issue or pull request was not found.', { cause: error })
  }
  return new GitHubAdapterError(
    'command',
    stderr ? `GitHub command failed: ${stderr}` : 'GitHub command failed.',
    { cause: error }
  )
}

function commandStderr(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('stderr' in error)) return ''
  const stderr = error.stderr
  return typeof stderr === 'string' ? stderr.trim() : ''
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidResponse(`${label} must be an object.`)
  }
  return value as Record<string, unknown>
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw invalidResponse(`${label} must be an array.`)
  return value
}

function requireString(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0)) {
    throw invalidResponse(`${label} must be ${allowEmpty ? 'a string' : 'a non-empty string'}.`)
  }
  return value
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw invalidResponse(`${label} must be a positive integer.`)
  }
  return Number(value)
}

function requireOneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string
): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw invalidResponse(`${label} is invalid.`)
  }
  return value as T[number]
}

function requireTimestamp(value: unknown, label: string): string {
  const timestamp = requireString(value, label)
  if (Number.isNaN(Date.parse(timestamp))) throw invalidResponse(`${label} is invalid.`)
  return timestamp
}

function requireUrl(value: unknown, label: string): string {
  const url = requireString(value, label)
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('unsupported protocol')
  } catch (error) {
    throw invalidResponse(`${label} is invalid.`, error)
  }
  return url
}

function requireResourceIdentity(
  value: unknown,
  repository: string,
  resourcePath: 'issues' | 'pull',
  expectedNumber: number,
  responseNumber: number
): void {
  if (responseNumber !== expectedNumber) {
    throw invalidResponse('GitHub response number does not match the requested resource.')
  }
  const url = requireUrl(value, 'GitHub resource URL')
  const parsed = new URL(url)
  const expectedPath = `/${repository}/${resourcePath}/${expectedNumber}`.toLowerCase()
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname.toLowerCase() !== 'github.com' ||
    parsed.pathname.toLowerCase() !== expectedPath ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw invalidResponse('GitHub response URL does not match the requested resource.')
  }
}

function optionalUrl(value: unknown, label: string): string | null {
  return value === null || value === '' ? null : requireUrl(value, label)
}

function invalidResponse(message: string, cause?: unknown): GitHubAdapterError {
  return new GitHubAdapterError('invalid-response', message, cause === undefined ? undefined : { cause })
}
