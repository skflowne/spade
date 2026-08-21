import { SpadePaseoAdapter } from './SpadePaseoAdapter'
import {
  emitValidationResult,
  errorMessage,
  isDirectEntry,
  requiredEnvironment
} from './validationSupport'

const CLIENT_VERSION = '0.4.0'

type CheckoutValidationAdapter = Pick<
  SpadePaseoAdapter,
  | 'connect'
  | 'openProjectCheckout'
  | 'checkoutStatus'
  | 'checkoutCommit'
  | 'checkoutPush'
  | 'checkoutCreatePullRequest'
  | 'checkoutPullRequestStatus'
  | 'close'
>

type CheckoutValidationAdapterFactory = (url: string) => CheckoutValidationAdapter

export async function runCheckoutValidation(
  environment: NodeJS.ProcessEnv = process.env,
  createAdapter: CheckoutValidationAdapterFactory = (url) =>
    new SpadePaseoAdapter({ url, pollIntervalMs: 0 })
): Promise<Record<string, unknown>> {
  const url = requiredEnvironment(environment, 'SPADE_P3_PASEO_URL')
  const cwd = requiredEnvironment(environment, 'SPADE_P3_CHECKOUT_VALIDATION_CWD')
  const repository = requiredEnvironment(
    environment,
    'SPADE_P3_CHECKOUT_VALIDATION_REPOSITORY'
  ).toLowerCase()
  const commitMessage = requiredEnvironment(
    environment,
    'SPADE_P3_CHECKOUT_VALIDATION_COMMIT_MESSAGE'
  )
  const remote = requiredEnvironment(environment, 'SPADE_P3_CHECKOUT_VALIDATION_REMOTE')
  const title = requiredEnvironment(environment, 'SPADE_P3_CHECKOUT_VALIDATION_PR_TITLE')
  const body = requiredEnvironment(environment, 'SPADE_P3_CHECKOUT_VALIDATION_PR_BODY')
  const baseBranch = requiredEnvironment(
    environment,
    'SPADE_P3_CHECKOUT_VALIDATION_BASE_BRANCH'
  )
  const outputPath = environment.SPADE_P3_CHECKOUT_VALIDATION_OUTPUT
  const adapter = createAdapter(url)
  const failures: unknown[] = []
  let evidence: Record<string, unknown> | null = null

  try {
    await adapter.connect()
    const workspace = await adapter.openProjectCheckout(cwd)
    const beforeCommit = await adapter.checkoutStatus(workspace.id)
    if (beforeCommit.workspaceId !== workspace.id) {
      throw new Error('Checkout validation status changed the opaque workspace identity.')
    }
    if (!beforeCommit.branch) {
      throw new Error('Checkout validation status returned no branch.')
    }
    if (beforeCommit.changedFiles === 0) {
      throw new Error('Checkout validation requires at least one disposable file change.')
    }

    const commit = await adapter.checkoutCommit(workspace.id, commitMessage)
    const afterCommit = await adapter.checkoutStatus(workspace.id)
    if (afterCommit.headRevision !== commit.revision) {
      throw new Error('Checkout validation status did not return the committed HEAD revision.')
    }
    if (afterCommit.changedFiles !== 0) {
      throw new Error('Checkout validation commit left disposable file changes behind.')
    }

    const push = await adapter.checkoutPush(workspace.id)
    if (push.remote !== remote || push.branch !== afterCommit.branch) {
      throw new Error('Checkout validation push returned a different remote or branch.')
    }
    const pullRequest = await adapter.checkoutCreatePullRequest(workspace.id, {
      title,
      body,
      baseBranch
    })
    if (pullRequest.repository !== repository) {
      throw new Error('Checkout validation created a pull request for a different repository.')
    }
    const pullRequestStatus = await adapter.checkoutPullRequestStatus(workspace.id)
    if (
      pullRequestStatus.state !== 'OPEN' ||
      pullRequestStatus.pullRequest?.repository !== pullRequest.repository ||
      pullRequestStatus.pullRequest.number !== pullRequest.number
    ) {
      throw new Error('Checkout validation returned a different or non-open pull request.')
    }

    evidence = {
      clientVersion: CLIENT_VERSION,
      daemonUrl: url,
      repository,
      workspaceId: workspace.id,
      branch: afterCommit.branch,
      baseBranch,
      beforeCommit: {
        headRevision: beforeCommit.headRevision,
        changedFiles: beforeCommit.changedFiles,
        additions: beforeCommit.additions,
        deletions: beforeCommit.deletions
      },
      commitRevision: commit.revision,
      afterCommit: {
        headRevision: afterCommit.headRevision,
        changedFiles: afterCommit.changedFiles
      },
      push,
      pullRequest,
      pullRequestState: pullRequestStatus.state
    }
  } catch (error) {
    failures.push(error)
  } finally {
    try {
      await adapter.close()
    } catch (error) {
      failures.push(new Error(`Failed to close the Paseo checkout validation client: ${errorMessage(error)}`, {
        cause: error
      }))
    }
  }

  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Paseo checkout validation failed with multiple errors.')
  }
  if (!evidence) throw new Error('Paseo checkout validation completed without evidence.')

  await emitValidationResult(outputPath, evidence)
  return evidence
}

if (isDirectEntry(import.meta.url)) {
  void runCheckoutValidation().catch((error: unknown) => {
    process.stderr.write(`${errorMessage(error)}\n`)
    process.exitCode = 1
  })
}
