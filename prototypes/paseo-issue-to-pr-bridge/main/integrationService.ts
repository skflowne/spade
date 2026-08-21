import type { PrototypeCommandService } from './commandService'
import {
  CheckoutAdapterError,
  type SpadePaseoCheckoutAdapter
} from './spadePaseoCheckout'
import {
  GitHubAdapterError,
  type SpadeGitHubAdapter
} from './spadeGitHubAdapter'
import type { CheckoutPullRequestIdentity } from '../shared/checkout'
import type {
  P3IntegrationError,
  P3IntegrationErrorKind,
  P3IntegrationRequest,
  P3IntegrationResult
} from '../shared/integration'
import {
  reconcileGitHubIssue,
  reconcileGitHubPullRequest,
  refreshGitHubPullRequest
} from '../shared/githubReconciliation'

export type GitHubReader = Pick<SpadeGitHubAdapter, 'getIssue' | 'getPullRequest'>
export type ExternalResourceOpener = (url: string) => Promise<void>

export class P3IntegrationService {
  constructor(
    private readonly commands: PrototypeCommandService,
    private readonly github: GitHubReader,
    private readonly checkout: SpadePaseoCheckoutAdapter | null,
    private readonly openExternal: ExternalResourceOpener
  ) {}

  async execute(request: P3IntegrationRequest): Promise<P3IntegrationResult> {
    try {
      switch (request.type) {
        case 'github-issue-detail': {
          const issue = await this.github.getIssue(request.repository, request.number)
          return { ok: true, value: { type: request.type, issue } }
        }
        case 'github-issue-create-work-item': {
          const issue = await this.github.getIssue(request.repository, request.number)
          const ledger = await this.commands.mutate((current) =>
            reconcileGitHubIssue(current, issue).ledger
          )
          return { ok: true, value: { type: request.type, ledger } }
        }
        case 'github-pull-request-refresh': {
          const node = this.commands.snapshot().nodes.find(({ id }) => id === request.nodeId)
          if (!node || node.kind !== 'github-pull-request') {
            throw new CheckoutAdapterError('check', 'Selected node is not a native GitHub pull request.')
          }
          const detail = await this.github.getPullRequest(
            node.pullRequest.repository,
            node.pullRequest.number
          )
          const ledger = await this.commands.mutate((current) =>
            refreshGitHubPullRequest(current, detail).ledger
          )
          return { ok: true, value: { type: request.type, ledger } }
        }
        case 'checkout-status': {
          const workspaceId = this.workspaceId(request.workspaceNodeId)
          const status = await this.requireCheckout().checkoutStatus(workspaceId)
          if (status.workspaceId !== workspaceId) {
            throw new CheckoutAdapterError(
              'check',
              'Paseo returned checkout status for a different workspace.'
            )
          }
          return { ok: true, value: { type: request.type, status } }
        }
        case 'checkout-commit': {
          const result = await this.requireCheckout().checkoutCommit(
            this.workspaceId(request.workspaceNodeId),
            request.message.trim()
          )
          return { ok: true, value: { type: request.type, result } }
        }
        case 'checkout-push': {
          const result = await this.requireCheckout().checkoutPush(
            this.workspaceId(request.workspaceNodeId)
          )
          return { ok: true, value: { type: request.type, result } }
        }
        case 'checkout-create-pull-request': {
          const pullRequest = validatePullRequestIdentity(
            await this.requireCheckout().checkoutCreatePullRequest(
              this.workspaceId(request.workspaceNodeId),
              request.input
            )
          )
          const reconciled = await this.reconcileCheckoutPullRequest(
            pullRequest,
            request.workspaceNodeId
          )
          return {
            ok: true,
            value: {
              type: request.type,
              pullRequest,
              ledger: reconciled.ledger,
              warning: reconciled.warning
            }
          }
        }
        case 'checkout-pull-request-status': {
          const status = await this.requireCheckout().checkoutPullRequestStatus(
            this.workspaceId(request.workspaceNodeId)
          )
          if (!status.pullRequest) {
            return {
              ok: true,
              value: {
                type: request.type,
                status,
                ledger: this.commands.snapshot(),
                warning: null
              }
            }
          }
          const pullRequest = validatePullRequestIdentity(status.pullRequest)
          const reconciled = await this.reconcileCheckoutPullRequest(
            pullRequest,
            request.workspaceNodeId
          )
          return {
            ok: true,
            value: {
              type: request.type,
              status: { ...status, pullRequest },
              ledger: reconciled.ledger,
              warning: reconciled.warning
            }
          }
        }
        case 'open-github-resource': {
          const repository = request.repository.trim().toLowerCase()
          await this.openExternal(
            `https://github.com/${repository}/${request.resource}/${request.number}`
          )
          return { ok: true, value: { type: request.type } }
        }
      }
    } catch (error) {
      return { ok: false, error: integrationError(error, fallbackKind(request.type)) }
    }
  }

  private requireCheckout(): SpadePaseoCheckoutAdapter {
    if (!this.checkout) {
      throw new CheckoutAdapterError(
        'unavailable',
        'Paseo checkout actions are unavailable until the SPADE Paseo adapter is connected.'
      )
    }
    return this.checkout
  }

  private workspaceId(nodeId: string): string {
    const node = this.commands.snapshot().nodes.find(({ id }) => id === nodeId)
    if (
      !node ||
      node.kind !== 'workspace' ||
      node.resourceRef.provider !== 'paseo' ||
      node.resourceRef.kind !== 'workspace'
    ) {
      throw new CheckoutAdapterError(
        'missing-workspace',
        'Selected node is not a Paseo workspace checkout.'
      )
    }
    return node.resourceRef.id
  }

  private async reconcileCheckoutPullRequest(
    identity: CheckoutPullRequestIdentity,
    sourceNodeId: string
  ): Promise<{ ledger: ReturnType<PrototypeCommandService['snapshot']>; warning: P3IntegrationError | null }> {
    try {
      const detail = await this.github.getPullRequest(identity.repository, identity.number)
      const ledger = await this.commands.mutate((current) =>
        reconcileGitHubPullRequest(current, detail, sourceNodeId).ledger
      )
      return { ledger, warning: null }
    } catch (error) {
      return {
        ledger: this.commands.snapshot(),
        warning: integrationError(error, 'invalid-response')
      }
    }
  }
}

function validatePullRequestIdentity(value: CheckoutPullRequestIdentity): CheckoutPullRequestIdentity {
  const repository = value.repository.trim().toLowerCase()
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository) ||
    !Number.isSafeInteger(value.number) ||
    value.number < 1
  ) {
    throw new CheckoutAdapterError('mutation', 'Paseo returned an invalid pull-request identity.')
  }
  const expectedUrl = `https://github.com/${repository}/pull/${value.number}`
  if (value.url.toLowerCase() !== expectedUrl) {
    throw new CheckoutAdapterError('mutation', 'Paseo returned a mismatched pull-request URL.')
  }
  return { repository, number: value.number, url: expectedUrl }
}

function integrationError(
  error: unknown,
  fallback: P3IntegrationErrorKind
): P3IntegrationError {
  if (error instanceof GitHubAdapterError || error instanceof CheckoutAdapterError) {
    return { kind: error.kind, message: error.message }
  }
  return {
    kind: fallback,
    message: error instanceof Error ? error.message : 'Integration operation failed.'
  }
}

function fallbackKind(type: P3IntegrationRequest['type']): P3IntegrationErrorKind {
  if (type === 'checkout-status' || type === 'checkout-pull-request-status') return 'check'
  if (type.startsWith('checkout-')) return 'mutation'
  return 'invalid-request'
}
