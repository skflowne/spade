import { expect, test } from '@playwright/test'
import { PrototypeCommandService } from '../../prototypes/paseo-issue-to-pr-bridge/main/commandService'
import { P3IntegrationService } from '../../prototypes/paseo-issue-to-pr-bridge/main/integrationService'
import { GitHubAdapterError } from '../../prototypes/paseo-issue-to-pr-bridge/main/spadeGitHubAdapter'
import type { SpadePaseoCheckoutAdapter } from '../../prototypes/paseo-issue-to-pr-bridge/main/spadePaseoCheckout'
import {
  applyPrototypeCommand,
  createInitialLedger
} from '../../prototypes/paseo-issue-to-pr-bridge/shared/commands'
import type {
  CheckoutStatus,
  CreateCheckoutPullRequestInput
} from '../../prototypes/paseo-issue-to-pr-bridge/shared/checkout'
import type {
  GitHubIssue,
  GitHubPullRequest
} from '../../prototypes/paseo-issue-to-pr-bridge/shared/github'
import { reconcileGitHubIssue } from '../../prototypes/paseo-issue-to-pr-bridge/shared/githubReconciliation'
import { isP3IntegrationRequest } from '../../prototypes/paseo-issue-to-pr-bridge/shared/integration'
import type { PrototypeLedger } from '../../prototypes/paseo-issue-to-pr-bridge/shared/model'

const issue: GitHubIssue = {
  repository: 'skflowne/spade-fixture',
  number: 1,
  title: 'Scaffold a Vue app',
  state: 'OPEN',
  labels: [],
  body: 'Build the fixture.',
  url: 'https://github.com/skflowne/spade-fixture/issues/1',
  updatedAt: '2026-08-20T12:03:05Z'
}

const pullRequest: GitHubPullRequest = {
  repository: 'skflowne/spade-fixture',
  number: 7,
  title: 'Build fixture',
  state: 'OPEN',
  author: 'octocat',
  url: 'https://github.com/skflowne/spade-fixture/pull/7',
  baseBranch: 'main',
  headBranch: 'spade-fixture',
  latestRevision: 'abcdef123456',
  updatedAt: '2026-08-20T13:00:00Z',
  checks: [],
  reviews: [],
  comments: [],
  reviewComments: []
}

const checkoutStatus: CheckoutStatus = {
  workspaceId: 'workspace-opaque-1',
  branch: 'spade-fixture',
  headRevision: 'abcdef123456',
  baseRef: 'main',
  changedFiles: 3,
  additions: 20,
  deletions: 4,
  stagedFiles: 1,
  unstagedFiles: 1,
  untrackedFiles: 1,
  conflicts: 0
}

function fixtureLedger(): PrototypeLedger {
  let ledger = reconcileGitHubIssue(
    createInitialLedger('project-1', 'Fixture project'),
    issue
  ).ledger
  ledger = applyPrototypeCommand(ledger, {
    type: 'attach-placeholder',
    targetGroup: 'work-item-1',
    nodeKind: 'workspace',
    title: 'Fixture checkout',
    resourceRef: { provider: 'paseo', kind: 'workspace', id: 'workspace-opaque-1', revision: null }
  }).ledger
  return ledger
}

async function commandService(ledger = fixtureLedger()): Promise<PrototypeCommandService> {
  let stored: PrototypeLedger | null = null
  const service = new PrototypeCommandService({
    load: async () => stored,
    save: async (next) => {
      stored = structuredClone(next)
    }
  })
  await service.initialize(ledger)
  return service
}

function checkoutAdapter(overrides: Partial<SpadePaseoCheckoutAdapter> = {}): SpadePaseoCheckoutAdapter {
  return {
    checkoutStatus: async () => checkoutStatus,
    checkoutCommit: async () => ({ revision: 'commit-1' }),
    checkoutPush: async () => ({ remote: 'origin', branch: 'spade-fixture' }),
    checkoutCreatePullRequest: async () => ({
      repository: pullRequest.repository,
      number: pullRequest.number,
      url: pullRequest.url
    }),
    checkoutPullRequestStatus: async () => ({
      pullRequest: {
        repository: pullRequest.repository,
        number: pullRequest.number,
        url: pullRequest.url
      },
      state: 'OPEN'
    }),
    ...overrides
  }
}

test('loads a native issue and creates its WorkItem through the serialized service', async () => {
  const service = await commandService(createInitialLedger('project-1', 'Fixture project'))
  const integrations = new P3IntegrationService(
    service,
    { getIssue: async () => issue, getPullRequest: async () => pullRequest },
    null,
    async () => undefined
  )

  await expect(integrations.execute({
    type: 'github-issue-detail',
    repository: issue.repository,
    number: issue.number
  })).resolves.toEqual({ ok: true, value: { type: 'github-issue-detail', issue } })

  const created = await integrations.execute({
    type: 'github-issue-create-work-item',
    repository: issue.repository,
    number: issue.number
  })
  expect(created.ok).toBe(true)
  expect(service.snapshot().groups).toHaveLength(1)
  expect(service.snapshot().nodes).toHaveLength(1)
  expect(service.snapshot().nodes[0]).toMatchObject({ kind: 'github-issue', issue })
})

test('passes only the selected opaque workspace ID to generic checkout methods', async () => {
  const service = await commandService()
  const calls: Array<{ method: string; workspaceId: string; value?: unknown }> = []
  const checkout = checkoutAdapter({
    checkoutStatus: async (workspaceId) => {
      calls.push({ method: 'status', workspaceId })
      return checkoutStatus
    },
    checkoutCommit: async (workspaceId, message) => {
      calls.push({ method: 'commit', workspaceId, value: message })
      return { revision: 'commit-1' }
    },
    checkoutPush: async (workspaceId) => {
      calls.push({ method: 'push', workspaceId })
      return { remote: 'origin', branch: 'spade-fixture' }
    }
  })
  const integrations = new P3IntegrationService(
    service,
    { getIssue: async () => issue, getPullRequest: async () => pullRequest },
    checkout,
    async () => undefined
  )

  await integrations.execute({ type: 'checkout-status', workspaceNodeId: 'node-3' })
  await integrations.execute({
    type: 'checkout-commit',
    workspaceNodeId: 'node-3',
    message: '  Build fixture  '
  })
  await integrations.execute({ type: 'checkout-push', workspaceNodeId: 'node-3' })

  expect(calls).toEqual([
    { method: 'status', workspaceId: 'workspace-opaque-1' },
    { method: 'commit', workspaceId: 'workspace-opaque-1', value: 'Build fixture' },
    { method: 'push', workspaceId: 'workspace-opaque-1' }
  ])
})

test('creates and refreshes one PR node from checkout-returned identity', async () => {
  const service = await commandService()
  const inputs: CreateCheckoutPullRequestInput[] = []
  const checkout = checkoutAdapter({
    checkoutCreatePullRequest: async (_workspaceId, input) => {
      inputs.push(input)
      return { repository: pullRequest.repository, number: pullRequest.number, url: pullRequest.url }
    }
  })
  const integrations = new P3IntegrationService(
    service,
    { getIssue: async () => issue, getPullRequest: async () => pullRequest },
    checkout,
    async () => undefined
  )

  const created = await integrations.execute({
    type: 'checkout-create-pull-request',
    workspaceNodeId: 'node-3',
    input: { title: 'Build fixture', body: 'Fixture body', baseBranch: 'main' }
  })
  const refreshed = await integrations.execute({
    type: 'checkout-pull-request-status',
    workspaceNodeId: 'node-3'
  })

  expect(created).toMatchObject({
    ok: true,
    value: { type: 'checkout-create-pull-request', warning: null }
  })
  expect(refreshed).toMatchObject({
    ok: true,
    value: { type: 'checkout-pull-request-status', warning: null }
  })
  expect(inputs).toEqual([{ title: 'Build fixture', body: 'Fixture body', baseBranch: 'main' }])
  expect(service.snapshot().nodes.filter((node) => node.kind === 'github-pull-request')).toHaveLength(1)
  expect(service.snapshot().edges.filter((edge) => edge.relation === 'derived')).toHaveLength(1)
})

test('reports a created PR identity when native GitHub refresh fails', async () => {
  const service = await commandService()
  const integrations = new P3IntegrationService(
    service,
    {
      getIssue: async () => issue,
      getPullRequest: async () => {
        throw new GitHubAdapterError('network', 'GitHub could not be reached.')
      }
    },
    checkoutAdapter(),
    async () => undefined
  )

  const result = await integrations.execute({
    type: 'checkout-create-pull-request',
    workspaceNodeId: 'node-3',
    input: { title: 'Build fixture', body: '' }
  })

  expect(result).toEqual({
    ok: true,
    value: {
      type: 'checkout-create-pull-request',
      pullRequest: {
        repository: pullRequest.repository,
        number: pullRequest.number,
        url: pullRequest.url
      },
      ledger: service.snapshot(),
      warning: { kind: 'network', message: 'GitHub could not be reached.' }
    }
  })
  expect(service.snapshot().nodes.some((node) => node.kind === 'github-pull-request')).toBe(false)
})

test('renders explicit unavailable, missing-workspace, and GitHub auth result kinds', async () => {
  const service = await commandService()
  const unavailable = new P3IntegrationService(
    service,
    { getIssue: async () => issue, getPullRequest: async () => pullRequest },
    null,
    async () => undefined
  )
  await expect(unavailable.execute({
    type: 'checkout-status',
    workspaceNodeId: 'node-3'
  })).resolves.toEqual({
    ok: false,
    error: {
      kind: 'unavailable',
      message: 'Paseo checkout actions are unavailable until the SPADE Paseo adapter is connected.'
    }
  })

  const integrations = new P3IntegrationService(
    service,
    {
      getIssue: async () => {
        throw new GitHubAdapterError('auth', 'GitHub authentication failed.')
      },
      getPullRequest: async () => pullRequest
    },
    checkoutAdapter(),
    async () => undefined
  )
  await expect(integrations.execute({
    type: 'checkout-status',
    workspaceNodeId: 'node-2'
  })).resolves.toMatchObject({ ok: false, error: { kind: 'missing-workspace' } })
  await expect(integrations.execute({
    type: 'github-issue-detail',
    repository: issue.repository,
    number: issue.number
  })).resolves.toEqual({
    ok: false,
    error: { kind: 'auth', message: 'GitHub authentication failed.' }
  })
})

test('opens only a constructed canonical GitHub resource URL', async () => {
  const service = await commandService()
  const opened: string[] = []
  const integrations = new P3IntegrationService(
    service,
    { getIssue: async () => issue, getPullRequest: async () => pullRequest },
    null,
    async (url) => {
      opened.push(url)
    }
  )

  await integrations.execute({
    type: 'open-github-resource',
    repository: 'SKFLOWNE/SPADE-FIXTURE',
    resource: 'pull',
    number: 7
  })

  expect(opened).toEqual(['https://github.com/skflowne/spade-fixture/pull/7'])
})

test('rejects malformed integration requests and extra renderer-controlled fields', () => {
  expect(isP3IntegrationRequest({
    type: 'checkout-commit',
    workspaceNodeId: 'node-3',
    message: 'Commit',
    cwd: '/tmp/injected'
  })).toBe(false)
  expect(isP3IntegrationRequest({
    type: 'checkout-create-pull-request',
    workspaceNodeId: 'node-3',
    input: { title: 'PR', body: '', merge: true }
  })).toBe(false)
  expect(isP3IntegrationRequest({
    type: 'github-issue-detail',
    repository: 'skflowne/spade-fixture',
    number: 0
  })).toBe(false)
  expect(isP3IntegrationRequest({
    type: 'paseo-issue-to-pr-review-stage',
    workspaceNodeId: 'node-3'
  })).toBe(false)
})
