import { applyPrototypeCommand, type CommandResult } from './commands'
import { githubResourceId, type GitHubIssue, type GitHubPullRequest } from './github'
import {
  sameResourceIdentity,
  type ExternalResourceReference,
  type GitHubIssueNode,
  type GitHubPullRequestNode,
  type PrototypeLedger,
  type PrototypeNode,
  type WorkItem
} from './model'

export type GitHubIssueReconciliationResult = CommandResult & { nodeId: string }
export type GitHubPullRequestReconciliationResult = CommandResult & { nodeId: string; edgeId: string }

export function reconcileGitHubIssue(
  ledger: PrototypeLedger,
  issue: GitHubIssue
): GitHubIssueReconciliationResult {
  const reference = issueReference(issue)
  const existingNode = findResourceNode(ledger, reference)
  if (existingNode && existingNode.kind !== 'github-issue') {
    throw new Error('GitHub issue identity is already assigned to another node kind.')
  }

  const existingWorkItem = findSourceWorkItem(ledger, reference)
  let next = ledger
  let workItemId: string
  if (existingWorkItem) {
    workItemId = existingWorkItem.id
    next = {
      ...next,
      groups: next.groups.map((group) =>
        group.id === workItemId && group.kind === 'work-item'
          ? updateIssueWorkItem(group, issue, reference)
          : group
      )
    }
  } else {
    const created = applyPrototypeCommand(next, {
      type: 'create-work-item',
      name: issue.title,
      task: issue.body.trim() || issue.title,
      sourceRef: reference,
      status: issue.state === 'CLOSED' ? 'done' : 'active'
    })
    next = created.ledger
    workItemId = created.affectedId
  }

  if (existingNode) {
    next = {
      ...next,
      nodes: next.nodes.map((node) =>
        node.id === existingNode.id
          ? {
              ...existingNode,
              groupId: workItemId,
              workItemId,
              title: issue.title,
              resourceRef: reference,
              issue
            }
          : node
      )
    }
    return { ledger: next, affectedId: workItemId, nodeId: existingNode.id }
  }

  const group = requireWorkItem(next, workItemId)
  const sequence = next.nextSequence
  const nodeId = `node-${sequence}`
  const node: GitHubIssueNode = {
    id: nodeId,
    projectId: next.project.id,
    groupId: workItemId,
    workItemId,
    kind: 'github-issue',
    title: issue.title,
    position: { x: group.position.x + 36, y: group.position.y + 76 },
    resourceRef: reference,
    issue
  }
  return {
    ledger: { ...next, nextSequence: sequence + 1, nodes: [...next.nodes, node] },
    affectedId: workItemId,
    nodeId
  }
}

export function reconcileGitHubPullRequest(
  ledger: PrototypeLedger,
  pullRequest: GitHubPullRequest,
  sourceNodeId: string
): GitHubPullRequestReconciliationResult {
  const source = requireCheckoutOrAgentNode(ledger, sourceNodeId)
  const reference = pullRequestReference(pullRequest)
  const existingNode = findResourceNode(ledger, reference)
  if (existingNode && existingNode.kind !== 'github-pull-request') {
    throw new Error('GitHub pull-request identity is already assigned to another node kind.')
  }

  let next = ledger
  let nodeId: string
  if (existingNode) {
    nodeId = existingNode.id
    next = {
      ...next,
      nodes: next.nodes.map((node) =>
        node.id === nodeId
          ? {
              ...existingNode,
              groupId: source.groupId ?? existingNode.groupId,
              workItemId: source.workItemId ?? existingNode.workItemId,
              title: pullRequest.title,
              resourceRef: reference,
              pullRequest
            }
          : node
      )
    }
  } else {
    const sequence = next.nextSequence
    nodeId = `node-${sequence}`
    const node: GitHubPullRequestNode = {
      id: nodeId,
      projectId: next.project.id,
      groupId: source.groupId,
      workItemId: source.workItemId,
      kind: 'github-pull-request',
      title: pullRequest.title,
      position: { x: source.position.x + 260, y: source.position.y },
      resourceRef: reference,
      pullRequest
    }
    next = { ...next, nextSequence: sequence + 1, nodes: [...next.nodes, node] }
  }

  const connected = applyPrototypeCommand(next, {
    type: 'connect-nodes',
    fromNodeId: source.id,
    toNodeId: nodeId,
    relation: 'derived'
  })
  return {
    ledger: connected.ledger,
    affectedId: nodeId,
    nodeId,
    edgeId: connected.affectedId
  }
}

function updateIssueWorkItem(
  workItem: WorkItem,
  issue: GitHubIssue,
  sourceRef: ExternalResourceReference
): WorkItem {
  return {
    ...workItem,
    name: issue.title,
    task: issue.body.trim() || issue.title,
    sourceRef,
    status: issue.state === 'CLOSED' ? 'done' : workItem.status === 'done' ? 'active' : workItem.status
  }
}

function issueReference(issue: GitHubIssue): ExternalResourceReference {
  return {
    provider: 'github',
    kind: 'issue',
    id: githubResourceId(issue.repository, issue.number),
    revision: issue.updatedAt
  }
}

function pullRequestReference(pullRequest: GitHubPullRequest): ExternalResourceReference {
  return {
    provider: 'github',
    kind: 'pull-request',
    id: githubResourceId(pullRequest.repository, pullRequest.number),
    revision: pullRequest.latestRevision
  }
}

function findResourceNode(
  ledger: PrototypeLedger,
  reference: ExternalResourceReference
): PrototypeNode | undefined {
  return ledger.nodes.find((node) => sameResourceIdentity(node.resourceRef, reference))
}

function findSourceWorkItem(
  ledger: PrototypeLedger,
  reference: ExternalResourceReference
): WorkItem | undefined {
  return ledger.groups.find(
    (group): group is WorkItem =>
      group.kind === 'work-item' &&
      group.sourceRef !== null &&
      sameResourceIdentity(group.sourceRef, reference)
  )
}

function requireWorkItem(ledger: PrototypeLedger, id: string): WorkItem {
  const group = ledger.groups.find((candidate) => candidate.id === id)
  if (!group || group.kind !== 'work-item') throw new Error(`No WorkItem has stable ID “${id}”.`)
  return group
}

function requireCheckoutOrAgentNode(ledger: PrototypeLedger, id: string): PrototypeNode {
  const node = ledger.nodes.find((candidate) => candidate.id === id)
  if (!node || (node.kind !== 'workspace' && node.kind !== 'agent')) {
    throw new Error(`No workspace or agent node has stable ID “${id}”.`)
  }
  return node
}
