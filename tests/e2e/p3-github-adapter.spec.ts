import { expect, test } from '@playwright/test'
import {
  GitHubAdapterError,
  SpadeGitHubAdapter,
  parseIssue,
  parsePullRequest,
  type GhCommandRunner
} from '../../prototypes/paseo-issue-to-pr-bridge/main/spadeGitHubAdapter'

const issueResponse = JSON.stringify({
  number: 1,
  title: 'Scaffold a Vue app',
  state: 'OPEN',
  labels: [{ name: 'prototype' }],
  body: 'Build the fixture.',
  url: 'https://github.com/skflowne/spade-fixture/issues/1',
  updatedAt: '2026-08-20T12:03:05Z'
})

const pullRequestResponse = JSON.stringify({
  number: 7,
  title: 'Build fixture',
  state: 'OPEN',
  author: { login: 'octocat' },
  url: 'https://github.com/skflowne/spade-fixture/pull/7',
  baseRefName: 'main',
  headRefName: 'spade-fixture',
  headRefOid: 'abcdef123456',
  updatedAt: '2026-08-20T13:00:00Z',
  statusCheckRollup: [
    {
      __typename: 'CheckRun',
      name: 'build',
      status: 'COMPLETED',
      conclusion: 'SUCCESS',
      detailsUrl: 'https://github.com/skflowne/spade-fixture/actions/runs/1'
    },
    {
      __typename: 'StatusContext',
      context: 'review-bot',
      state: 'PENDING',
      targetUrl: null
    }
  ],
  reviews: [
    {
      author: { login: 'reviewer' },
      state: 'CHANGES_REQUESTED',
      body: 'Please fix the heading.',
      submittedAt: '2026-08-20T12:40:00Z'
    }
  ],
  comments: [
    {
      author: { login: 'maintainer' },
      body: 'General PR comment.',
      createdAt: '2026-08-20T12:45:00Z'
    }
  ]
})

const reviewCommentsResponse = JSON.stringify([
  [{
    user: { login: 'reviewer' },
    body: 'Inline review comment.',
    path: 'src/App.vue',
    created_at: '2026-08-20T12:41:00Z'
  }],
  [{
    user: { login: 'second-reviewer' },
    body: 'Second page comment.',
    path: 'src/main.ts',
    created_at: '2026-08-20T12:42:00Z'
  }]
])

function commandFailure(stderr: string): GhCommandRunner {
  return async () => {
    throw Object.assign(new Error('gh failed'), { stderr })
  }
}

async function expectAdapterError(
  operation: Promise<unknown>,
  kind: GitHubAdapterError['kind']
): Promise<void> {
  try {
    await operation
    throw new Error('Expected adapter operation to fail.')
  } catch (error) {
    expect(error).toBeInstanceOf(GitHubAdapterError)
    expect((error as GitHubAdapterError).kind).toBe(kind)
  }
}

test('targets one repository and parses structured issue output', async () => {
  const calls: string[][] = []
  const runner: GhCommandRunner = async (arguments_) => {
    calls.push([...arguments_])
    return { stdout: issueResponse, stderr: '' }
  }
  const adapter = new SpadeGitHubAdapter(runner)

  await expect(adapter.getIssue('SKFLOWNE/SPADE-FIXTURE', 1)).resolves.toEqual({
    repository: 'skflowne/spade-fixture',
    number: 1,
    title: 'Scaffold a Vue app',
    state: 'OPEN',
    labels: ['prototype'],
    body: 'Build the fixture.',
    url: 'https://github.com/skflowne/spade-fixture/issues/1',
    updatedAt: '2026-08-20T12:03:05Z'
  })
  expect(calls).toEqual([[
    'issue',
    'view',
    '1',
    '--repo',
    'skflowne/spade-fixture',
    '--json',
    'number,title,state,labels,body,url,updatedAt'
  ]])
})

test('keeps PR checks, reviews, conversation comments, and inline review comments distinct', async () => {
  const pullRequest = parsePullRequest(
    pullRequestResponse,
    reviewCommentsResponse,
    'skflowne/spade-fixture',
    7
  )

  expect(pullRequest).toMatchObject({
    repository: 'skflowne/spade-fixture',
    number: 7,
    author: 'octocat',
    baseBranch: 'main',
    headBranch: 'spade-fixture',
    latestRevision: 'abcdef123456',
    checks: [
      { name: 'build', state: 'passed' },
      { name: 'review-bot', state: 'pending' }
    ],
    reviews: [{ author: 'reviewer', state: 'CHANGES_REQUESTED' }],
    comments: [{ author: 'maintainer', body: 'General PR comment.' }],
    reviewComments: [
      { author: 'reviewer', body: 'Inline review comment.', path: 'src/App.vue' },
      { author: 'second-reviewer', body: 'Second page comment.', path: 'src/main.ts' }
    ]
  })
})

test('represents deleted PR actors without discarding the remaining PR state', () => {
  const response = JSON.parse(pullRequestResponse) as {
    author: unknown
    reviews: Array<{ author: unknown }>
    comments: Array<{ author: unknown }>
  }
  response.author = null
  response.reviews[0].author = null
  response.comments[0].author = null
  const reviewComments = JSON.parse(reviewCommentsResponse) as Array<Array<Record<string, unknown>>>
  reviewComments[0][0].user = null

  const pullRequest = parsePullRequest(
    JSON.stringify(response),
    JSON.stringify(reviewComments),
    'skflowne/spade-fixture',
    7
  )

  expect(pullRequest.author).toBe('Deleted user')
  expect(pullRequest.reviews[0].author).toBe('Deleted user')
  expect(pullRequest.comments[0].author).toBe('Deleted user')
  expect(pullRequest.reviewComments[0].author).toBe('Deleted user')
  expect(pullRequest.state).toBe('OPEN')
  expect(pullRequest.checks[0]).toMatchObject({ name: 'build', state: 'passed' })
  expect(pullRequest.reviews[0]).toMatchObject({ state: 'CHANGES_REQUESTED' })
  expect(pullRequest.comments[0]).toMatchObject({ body: 'General PR comment.' })
  expect(pullRequest.reviewComments[0]).toMatchObject({
    body: 'Inline review comment.',
    path: 'src/App.vue'
  })
})

test('builds separate structured PR detail and inline-review-comment commands', async () => {
  const calls: string[][] = []
  const runner: GhCommandRunner = async (arguments_) => {
    calls.push([...arguments_])
    return arguments_[0] === 'pr'
      ? { stdout: pullRequestResponse, stderr: '' }
      : { stdout: reviewCommentsResponse, stderr: '' }
  }

  const pullRequest = await new SpadeGitHubAdapter(runner).getPullRequest('skflowne/spade-fixture', 7)

  expect(pullRequest.number).toBe(7)
  expect(calls).toHaveLength(2)
  expect(calls).toContainEqual([
    'api',
    '--method',
    'GET',
    'repos/skflowne/spade-fixture/pulls/7/comments',
    '--paginate',
    '--slurp'
  ])
  const detailCall = calls.find(([command]) => command === 'pr')
  expect(detailCall?.at(-1)).toContain('statusCheckRollup')
})

test('rejects invalid repositories and malformed or partial responses before use', async () => {
  let called = false
  const runner: GhCommandRunner = async () => {
    called = true
    return { stdout: issueResponse, stderr: '' }
  }
  await expectAdapterError(new SpadeGitHubAdapter(runner).getIssue('missing-owner', 1), 'repository')
  expect(called).toBe(false)

  for (const response of ['not-json', JSON.stringify({ number: 1, title: 'Incomplete' })]) {
    expect(() => parseIssue(response, 'skflowne/spade-fixture', 1)).toThrow(GitHubAdapterError)
    try {
      parseIssue(response, 'skflowne/spade-fixture', 1)
    } catch (error) {
      expect((error as GitHubAdapterError).kind).toBe('invalid-response')
    }
  }
})

test('rejects response identities that differ from the requested GitHub resource', () => {
  const wrongNumber = JSON.stringify({ ...JSON.parse(issueResponse), number: 2 })
  const wrongHost = JSON.stringify({
    ...JSON.parse(issueResponse),
    url: 'https://example.com/skflowne/spade-fixture/issues/1'
  })
  const wrongPath = JSON.stringify({
    ...JSON.parse(issueResponse),
    url: 'https://github.com/skflowne/other/issues/1'
  })

  for (const response of [wrongNumber, wrongHost, wrongPath]) {
    expect(() => parseIssue(response, 'skflowne/spade-fixture', 1)).toThrow(
      /does not match the requested resource/
    )
  }
})

test('rejects unknown check states instead of silently categorizing them', () => {
  const response = JSON.parse(pullRequestResponse) as Record<string, unknown>
  response.statusCheckRollup = [{
    __typename: 'CheckRun',
    name: 'build',
    status: 'UNKNOWN',
    conclusion: null,
    detailsUrl: null
  }]

  expect(() => parsePullRequest(
    JSON.stringify(response),
    reviewCommentsResponse,
    'skflowne/spade-fixture',
    7
  )).toThrow('GitHub check status “UNKNOWN” is invalid.')
})

test('classifies auth, repository, network, missing-resource, and generic command failures', async () => {
  const cases: Array<[string, GitHubAdapterError['kind']]> = [
    ['authentication required: run gh auth login', 'auth'],
    ['GraphQL: Could not resolve to a Repository', 'repository'],
    ['could not resolve host: github.com', 'network'],
    ['no pull requests found for branch', 'not-found'],
    ['unexpected gh failure', 'command']
  ]

  for (const [stderr, kind] of cases) {
    await expectAdapterError(
      new SpadeGitHubAdapter(commandFailure(stderr)).getIssue('skflowne/spade-fixture', 1),
      kind
    )
  }
})

test('aborts a command at the configured timeout', async () => {
  const runner: GhCommandRunner = (_arguments, signal) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })

  await expectAdapterError(
    new SpadeGitHubAdapter(runner, 5).getIssue('skflowne/spade-fixture', 1),
    'timeout'
  )
})
