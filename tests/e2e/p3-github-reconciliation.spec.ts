import { expect, test } from '@playwright/test'
import {
  applyPrototypeCommand,
  createInitialLedger
} from '../../prototypes/paseo-issue-to-pr-bridge/shared/commands'
import type {
  GitHubIssue,
  GitHubPullRequest
} from '../../prototypes/paseo-issue-to-pr-bridge/shared/github'
import {
  reconcileGitHubIssue,
  reconcileGitHubPullRequest
} from '../../prototypes/paseo-issue-to-pr-bridge/shared/githubReconciliation'
import {
  isPrototypeLedger,
  type PrototypeLedger
} from '../../prototypes/paseo-issue-to-pr-bridge/shared/model'

const issue: GitHubIssue = {
  repository: 'skflowne/spade-fixture',
  number: 1,
  title: 'Scaffold a Vue app',
  state: 'OPEN',
  labels: ['prototype'],
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
  checks: [{ name: 'build', state: 'passed', url: null }],
  reviews: [],
  comments: [],
  reviewComments: []
}

function apply(
  ledger: PrototypeLedger,
  command: Parameters<typeof applyPrototypeCommand>[1]
): PrototypeLedger {
  return applyPrototypeCommand(ledger, command).ledger
}

test('creates one WorkItem and native Issue node from exact GitHub identity', () => {
  const initial = createInitialLedger('project-1', 'Fixture project')
  const created = reconcileGitHubIssue(initial, issue)

  expect(created.ledger.groups).toHaveLength(1)
  expect(created.ledger.nodes).toHaveLength(1)
  expect(created.ledger.groups[0]).toMatchObject({
    id: created.affectedId,
    kind: 'work-item',
    name: issue.title,
    task: issue.body,
    sourceRef: {
      provider: 'github',
      kind: 'issue',
      id: 'skflowne/spade-fixture#1',
      revision: issue.updatedAt
    }
  })
  expect(created.ledger.nodes[0]).toMatchObject({
    id: created.nodeId,
    kind: 'github-issue',
    groupId: created.affectedId,
    workItemId: created.affectedId,
    issue
  })
  expect(isPrototypeLedger(created.ledger)).toBe(true)
})

test('refreshes the existing Issue node and source WorkItem without duplicates', () => {
  const initial = createInitialLedger('project-1', 'Fixture project')
  const created = reconcileGitHubIssue(initial, {
    ...issue,
    repository: 'SKFLOWNE/SPADE-FIXTURE'
  })
  const refreshedIssue: GitHubIssue = {
    ...issue,
    title: 'Scaffold the Vue fixture',
    state: 'CLOSED',
    body: 'Completed fixture.',
    updatedAt: '2026-08-20T14:00:00Z'
  }
  const refreshed = reconcileGitHubIssue(created.ledger, refreshedIssue)

  expect(refreshed.affectedId).toBe(created.affectedId)
  expect(refreshed.nodeId).toBe(created.nodeId)
  expect(refreshed.ledger.groups).toHaveLength(1)
  expect(refreshed.ledger.nodes).toHaveLength(1)
  expect(refreshed.ledger.groups[0]).toMatchObject({
    name: refreshedIssue.title,
    task: refreshedIssue.body,
    status: 'done',
    sourceRef: { revision: refreshedIssue.updatedAt }
  })
  expect(refreshed.ledger.nodes[0]).toMatchObject({
    resourceRef: { revision: refreshedIssue.updatedAt },
    issue: refreshedIssue
  })
})

test('reconciles one native PR with WorkItem membership and one derived edge', () => {
  let ledger = reconcileGitHubIssue(
    createInitialLedger('project-1', 'Fixture project'),
    issue
  ).ledger
  ledger = apply(ledger, {
    type: 'attach-placeholder',
    targetGroup: 'work-item-1',
    nodeKind: 'workspace',
    title: 'Fixture checkout',
    resourceRef: { provider: 'paseo', kind: 'workspace', id: 'workspace-opaque-1', revision: null }
  })

  const created = reconcileGitHubPullRequest(
    ledger,
    { ...pullRequest, repository: 'SKFLOWNE/SPADE-FIXTURE' },
    'node-3'
  )
  const refreshedPullRequest: GitHubPullRequest = {
    ...pullRequest,
    title: 'Build the fixture app',
    latestRevision: 'fedcba654321',
    checks: [{ name: 'build', state: 'failed', url: null }]
  }
  const refreshed = reconcileGitHubPullRequest(
    created.ledger,
    refreshedPullRequest,
    'node-3'
  )

  const pullRequestNodes = refreshed.ledger.nodes.filter(
    (node) => node.kind === 'github-pull-request'
  )
  expect(pullRequestNodes).toHaveLength(1)
  expect(pullRequestNodes[0]).toMatchObject({
    id: created.nodeId,
    groupId: 'work-item-1',
    workItemId: 'work-item-1',
    title: refreshedPullRequest.title,
    resourceRef: {
      provider: 'github',
      kind: 'pull-request',
      id: 'skflowne/spade-fixture#7',
      revision: refreshedPullRequest.latestRevision
    },
    pullRequest: refreshedPullRequest
  })
  expect(refreshed.ledger.edges.filter((edge) => edge.relation === 'derived')).toEqual([
    {
      id: created.edgeId,
      fromNodeId: 'node-3',
      toNodeId: created.nodeId,
      relation: 'derived'
    }
  ])
  expect(isPrototypeLedger(refreshed.ledger)).toBe(true)
})

test('rejects PR reconciliation from a node that is not an agent or workspace', () => {
  const issueResult = reconcileGitHubIssue(
    createInitialLedger('project-1', 'Fixture project'),
    issue
  )

  expect(() => reconcileGitHubPullRequest(
    issueResult.ledger,
    pullRequest,
    issueResult.nodeId
  )).toThrow(`No workspace or agent node has stable ID “${issueResult.nodeId}”.`)
})

test('keeps version-1 placeholder ledgers valid while accepting native GitHub nodes', () => {
  let placeholderLedger = createInitialLedger('project-1', 'Fixture project')
  placeholderLedger = apply(placeholderLedger, { type: 'create-group', name: 'Existing group' })
  placeholderLedger = apply(placeholderLedger, {
    type: 'attach-placeholder',
    targetGroup: 'group-1',
    nodeKind: 'agent',
    title: 'Existing agent',
    resourceRef: { provider: 'placeholder', kind: 'agent', id: 'agent-1', revision: null }
  })

  expect(placeholderLedger.version).toBe(1)
  expect(isPrototypeLedger(structuredClone(placeholderLedger))).toBe(true)
  expect(isPrototypeLedger(
    structuredClone(reconcileGitHubIssue(placeholderLedger, issue).ledger)
  )).toBe(true)
})
