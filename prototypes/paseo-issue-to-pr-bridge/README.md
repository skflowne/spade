# P3 Paseo and native GitHub work shell

This directory is SPADE Prototype 3's isolated Electron shell. It keeps Group and WorkItem behavior workflow-agnostic while projecting exact Paseo agent, workspace, connection, capability, and normalized-conversation facts alongside native GitHub Issue/PullRequest entities and generic checkout actions. It is not part of the production `src/` Electron entry and does not redefine canonical product facts.

## Run

```bash
npm install
npm run prototype:p3
```

The executable creates one `SpadePaseoAdapter` and one public `@getpaseo/client` connection. The main process stores `p3-ledger.json` under Electron's user-data directory; automated checks use an isolated path.

Native GitHub reads require `gh` on `PATH`, an authenticated GitHub account, and repository access for the selected `owner/name` target. Authentication credentials remain owned by `gh` and never cross into preload or renderer state.

Configuration:

| Variable | Meaning | Default |
|---|---|---|
| `SPADE_P3_PASEO_URL` | Paseo daemon WebSocket URL | `ws://127.0.0.1:6767/ws` |
| `SPADE_P3_LEDGER_PATH` | Prototype ledger path | Electron user-data `p3-ledger.json` |
| `SPADE_P3_DISABLE_PASEO=1` | Deterministic test opt-out | unset |

The renderer exposes generic controls to select/open a checkout, create or attach a workspace, spawn or attach a root agent, and request an authoritative refresh. Provider, model, prompt, cwd, WorkItem, agent ID, and workspace ID are caller input. The bridge does not classify prompt content or infer workflow roles.

## Architecture and invariants

- `main/SpadePaseoAdapter.ts` is the only `@getpaseo/client` boundary. It owns one public SDK client and never constructs or imports an internal `DaemonClient`.
- `main/commandService.ts` serializes commands, persistence, adapter notifications, startup restoration, reconnect refetch, and publication. Refresh notifications are buffered/coalesced through initialization and reconnect; a reconnect snapshot completes before one pending post-authoritative refresh.
- A successful external spawn persists its exact opaque identity and root binding before the fallible authoritative fetch.
- One opaque root belongs to at most one WorkItem. Rebinding transfers ownership; persisted duplicate roots are rejected.
- `shared/paseoReconciliation.ts` owns recursive explicit-parent closure, actual-parent `delegated` edges, workspace dedupe, missing-resource preservation, managed/provider-native identity separation, and bounded timeline normalization.
- Main forwards one `PrototypeCommandService.subscribe()` stream per window. Command-specific sends do not exist, so command and adapter-originated snapshots have one publication authority and window cleanup.
- The sandboxed renderer still receives only typed snapshot, command, and snapshot-event operations through preload. No SDK, arbitrary IPC, filesystem, terminal, GitHub, MCP, or CLI surface crosses into the renderer.

External identity is always `provider + kind + opaque ID`. Titles, cwd segments, branches, prompt text, skill names, and creation order never determine identity or presentation type.

## Paseo 0.4.0 capability inventory

`package.json` pins `@getpaseo/client` to exactly `0.4.0`. The persisted inventory in `shared/model.ts` is the prototype authority.

| Capability | Prototype state | Public 0.4.0 API used |
|---|---|---|
| Agents | Available | `agents.list`, `agents.create`, `agents.ref().refresh`, `agents.ref().archive`, local `agents.subscribe` |
| Workspaces | Available | `workspaces.list`, `workspaces.open`, `workspaces.create`, `workspaces.ref().refresh`, local `workspaces.subscribe` |
| Providers | Available | `providers.waitForReady`, local `providers.subscribe` |
| Timeline fetch | Available | `agents.ref(id).timeline.refetch` with projected tail and limit 40 |
| Agent/workspace subscriptions | Available | Public local update listeners plus list subscription IDs; callbacks trigger serialized authoritative refreshes |
| Provider-native subagent discovery | Unavailable | Provider-subagent RPCs exist only on unsupported internal client exports |
| Live timeline activation | Unavailable | Public `timeline.subscribe` is a local listener, but the public facade cannot activate daemon timeline streaming |
| Server info/version | Unavailable | Public facade exposes no server-info/version RPC |

Direct internal imports: **none**. The unavailable states are rendered explicitly; the bridge does not claim provider-native discovery, activated live timelines, or server version inspection. Authoritative bounded timeline fetches replace unsupported live delivery. Provider-native fixture records only prove that their identity/lifecycle type cannot collide with managed agents.

## Deterministic coverage

Automated fixtures cover:

- recursive descendants across paginated agent/workspace lists;
- exact parent edges, shared/distinct workspaces, and repeated reconciliation;
- managed/provider-native identity separation;
- missing resources without deleting durable mappings;
- sequenced, unsequenced, shuffled, duplicate, mixed, and bounded timeline events;
- v1-to-v2 migration and malformed/duplicate ledger rejection;
- startup/reconnect buffering and post-authoritative refresh ordering;
- successful-spawn durability before failed refresh;
- global root-binding transfer and caller/resource failure classification;
- one concrete adapter composition and one disposable, exactly-once snapshot publication path;
- live renderer states, capability failures, exact resource facts, conversations, expansion defaults/user changes, IPC guards, sandboxing, and relaunch persistence.

Run focused checks:

```bash
npm run prototype:p3:typecheck
npm run prototype:p3:build
xvfb-run -a npx playwright test \
  tests/e2e/p3-model.spec.ts \
  tests/e2e/p3-ledger.spec.ts \
  tests/e2e/p3-reconciliation.spec.ts \
  tests/e2e/p3-paseo-adapter.spec.ts \
  tests/e2e/p3-shell.spec.ts
```

## Isolated real Paseo 0.4.0 validation

The validation entry is bundled with the prototype and exercises `SpadePaseoAdapter` itself:

```bash
SPADE_P3_PASEO_URL=ws://127.0.0.1:17677/ws \
SPADE_P3_VALIDATION_CWD="$PWD" \
SPADE_P3_VALIDATION_PROVIDER=codex \
SPADE_P3_VALIDATION_MODEL=gpt-5.6-luna \
SPADE_P3_VALIDATION_ROOT_PROMPT='Reply exactly SPADE_ROOT_OK. Do not use tools or modify files.' \
SPADE_P3_VALIDATION_CHILD_PROMPT='Reply exactly SPADE_CHILD_OK. Do not use tools or modify files.' \
SPADE_P3_VALIDATION_OUTPUT=/tmp/spade18-paseo-validation.json \
npm run prototype:p3:validate:paseo
```

Validation record from 2026-08-21:

| Fact | Evidence |
|---|---|
| Client | `@getpaseo/client` 0.4.0 |
| CLI and daemon | `@getpaseo/cli` 0.4.0 and isolated daemon 0.4.0 |
| Isolation | Home `/tmp/spade-paseo-0.4.0-Tn5Skk`, `127.0.0.1:17677`, relay/MCP/web UI disabled |
| Existing sessions | Active home `/home/skflowne/.paseo` remained running at `127.0.0.1:6768` on CLI/daemon 0.3.1 with PID 1349 |
| Provider/model | Caller selected `codex/gpt-5.6-luna`; both validation agents completed `idle` |
| Workspace | `wks_8bcc691d2259c589` shared exactly by root and child |
| Root | `c1df22ff-bcfc-4b41-b79b-d262901b172a` |
| Child | `f1f1f5b6-14a8-4f8d-b514-af98d0b69053` with exact parent `c1df22ff-bcfc-4b41-b79b-d262901b172a` |
| Timelines | Two projected events for each agent, both below the 40-event bound |
| Repeated refetch | Stable root, agent, workspace, and timeline-agent identities |
| Cleanup | Child archived at `2026-08-21T00:33:54.655Z`; root archived at `2026-08-21T00:33:54.891Z`; isolated daemon stopped gracefully |

`SPADE_P3_VALIDATION_ROOT_PROMPT` and `SPADE_P3_VALIDATION_CHILD_PROMPT` are required caller inputs and are passed unchanged to their respective agents. The recorded prompts requested exact short replies and prohibited tools/file changes. The adapter opened the existing checkout, created root and explicit child through public SDK calls, fetched two authoritative snapshots, verified exact parent/workspace identities and bounds, archived both agents, and closed its single client. Validation exits with failure if any agent cannot be archived or if the client cannot close; every reverse-order archive and client close is still attempted. No current Paseo process was stopped or upgraded.

Raw local evidence was captured at `/tmp/spade18-paseo-validation.log`, `/tmp/spade18-paseo-validation.json`, and `/tmp/spade18-daemon-evidence.log` during the run.

## Direct UI evidence

Electron 43 was exercised under Xvfb through Playwright's real Electron automation. The live fixture rendered connected managed-agent, provider-subagent, and workspace records; explicit unavailable capabilities; normalized conversation details; retained user expansion; and generic Paseo controls. The renderer sandbox exposed only `execute`, `snapshot`, and `subscribe`.

Artifact: [`artifacts/p3-paseo-live.png`](artifacts/p3-paseo-live.png)

## Repository gate

```bash
npm run prototype:p3:typecheck
npm run prototype:p3:build
npm run typecheck
npm run lint
xvfb-run -a npm test
git diff --check
```

## Native GitHub boundary

`SpadeGitHubAdapter` is the only owner of `gh` invocation. It uses argument arrays and structured JSON output, validates repository/resource identity, limits output, applies a timeout, and classifies authentication, repository, not-found, network, malformed-response, and command failures. PR detail combines `gh pr view` with paginated/slurped inline review comments while keeping reviews, conversation comments, and inline comments distinct.

The renderer can request only validated operations through `P3PrototypeBridge.integrate`. Main-process `P3IntegrationService` fetches provider state, applies serialized ledger mutations, and returns typed success, failure, or partial-success results. `Open on GitHub` constructs a canonical GitHub URL in main rather than accepting an arbitrary renderer URL.

Native entities retain exact references:

- Issue: `github / issue / <lowercase-owner/repository>#<number>` with the issue update timestamp as revision.
- Pull request: `github / pull-request / <lowercase-owner/repository>#<number>` with the head revision as revision.

Refreshing either resource updates its existing node. Creating a WorkItem from an Issue records the Issue as its source and adds one native Issue node. A checkout-returned PR adds or refreshes one native PullRequest node and one idempotent `derived` edge from the selected workspace/agent surface.

## GitHub reads versus checkout mutations

Responsibilities intentionally remain separate:

| Responsibility | Owner |
|---|---|
| Issue and PR reads, checks, reviews/comments, canonical GitHub URLs | `SpadeGitHubAdapter` using authenticated `gh` |
| Serialized SPADE ledger mutation and publication | `PrototypeCommandService` |
| GitHub-to-SPADE identity and node/edge reconciliation | `shared/githubReconciliation.ts` |
| Selected-workspace checkout status, commit, push, PR creation/status contract | `SpadePaseoCheckoutAdapter` port in `main/spadePaseoCheckout.ts` |
| Concrete daemon connection and checkout implementation | the single `SpadePaseoAdapter` owned by issue #18 |
| Renderer capability surface | validated integration IPC plus sandboxed preload |

The checkout port accepts only an opaque Paseo workspace ID. It does not accept a renderer-supplied cwd or infer a checkout from branch names. Returned checkout status must match the requested workspace identity, and the renderer keys status to the current workspace selection so stale responses cannot appear under another checkout.

This branch deliberately injects no concrete checkout adapter because issue #18 has not merged. The UI therefore reports checkout actions as unavailable on this standalone branch. After integration, #18's existing single adapter must implement these methods; #19 must not create a second daemon connection or copy #18 reconciliation logic.

## Workflow-agnostic shell invariants

- WorkItem and ordinary Group records use the same hull projection and `GroupHull` renderer.
- WorkItem adds source/task/status, semantic membership, and activity-sidebar projection without duplicating Group geometry.
- Ordinary Group placement changes visual `groupId` only; WorkItem placement assigns semantic `workItemId`.
- Names are lookup conveniences. Exact stable IDs and provider/kind/opaque-ID references own identity.
- Native Issue, PullRequest, agent, and workspace nodes share `NodeFrame` chrome and Control Room tokens.
- Edges communicate provenance only. `derived` records the PR's origin; it does not execute a workflow.
- There are no workflow-stage types or title/path/branch/prompt/order classification rules.
- The sandboxed renderer has no Node process, filesystem, `gh`, Paseo client, credentials, or arbitrary IPC access.

## Typed owners

| Boundary | Owner | Exported contract |
|---|---|---|
| Records and exact external identity | `shared/model.ts`, `shared/github.ts` | ledger/node records, GitHub DTOs, runtime predicates, canonical resource identity |
| Generic Group/WorkItem mutations | `shared/commands.ts` | `PrototypeCommand`, `applyPrototypeCommand`, `resolveGroup` |
| GitHub reconciliation | `shared/githubReconciliation.ts` | Issue/PR create-refresh and `derived` provenance |
| Canvas/activity geometry | `shared/projection.ts` | shared hull and node-size projections |
| Checkout action DTOs and selection binding | `shared/checkout.ts` | status/diff totals, mutation results, PR identity/status, stale-response guard |
| Renderer bridge | `shared/ipc.ts`, `shared/integration.ts` | narrow channels, requests/results, runtime validation |
| GitHub provider adapter | `main/spadeGitHubAdapter.ts` | structured `gh` reads and classified errors |
| Checkout provider port | `main/spadePaseoCheckout.ts` | five small opaque-workspace methods for #18's adapter |
| Integration orchestration | `main/integrationService.ts` | provider calls, partial PR state, durable reconciliation |
| Persistence | `main/ledgerStore.ts`, `main/commandService.ts` | validated atomic replacement and serialized publication |

## Direct validation record

Environment: Electron 43 under Xvfb, Node 24.18.0, `gh` 2.96.0 authenticated as the current host user.

| Check | Observation | Result |
|---|---|---|
| Live fixture Issue | `SpadeGitHubAdapter.getIssue('skflowne/spade-fixture', 1)` returned repository, number, title, OPEN state, body, URL, and update timestamp. | Pass |
| Disposable fixture PR | Created `spade-fixture#2` on a disposable branch, read it through `SpadeGitHubAdapter.getPullRequest`, and observed exact base/head/revision plus empty checks/activity arrays. The PR was closed and its branch deleted immediately afterward. | Pass |
| Native presentation | Electron rendered one Issue and one PR with shared chrome, WorkItem membership, `derived` provenance, labels/body, branches/revision, checks, review/comment activity, and GitHub escape hatches. | Pass |
| Narrow IPC/sandbox | Runtime rejected malformed integration requests and renderer-supplied cwd/extra fields; renderer exposed only snapshot, generic command, integration, and subscription methods. | Pass |
| Partial PR safety | Deterministic integration coverage retained checkout-returned PR identity when subsequent GitHub detail/reconciliation failed. | Pass |
| Selected checkout | Deterministic coverage rejected mismatched adapter workspace status and dropped status from changed or superseded selections. | Pass |
| Persistence/reconnect | Existing version-1 placeholder ledgers remain valid; repeated Issue/PR reconciliation creates no duplicate nodes or edges. | Pass |
| Real Paseo mutations | No concrete `SpadePaseoAdapter` exists on this branch because #18 is unmerged. Real status/commit/push/create-PR/status execution remains an explicit integration prerequisite. | Blocked on #18 |

Artifact: [`artifacts/p3-native-github-shell.png`](artifacts/p3-native-github-shell.png)

## Scope and residual limitations

- No embedded GitHub webview is used as the primary Issue/PR experience.
- There is no GitHub App, OAuth flow, webhook listener, hosted authorization, merge action, issue mutation, or generic comment composer.
- There is no file list/diff viewer, file node, editor, preview, or terminal.
- Checkout actions are generic selected-workspace operations and contain no `paseo-issue-to-pr` stage names.
- Concrete real checkout mutation validation must occur after #18's adapter is merged/rebased; this branch does not bypass Paseo with renderer or direct Git commands.
- Provider-native live discovery and activated timeline streaming remain unavailable through the public 0.4.0 facade.
- Server/feature version facts are validation evidence from the CLI status command, not runtime facts claimed by the adapter.
- Node dragging remains presentation-only; no move command is persisted.
- Edges communicate provenance and context only; they do not execute or schedule work.
- Canonical pages under `docs/` remain unchanged because this isolated prototype does not redefine current production facts.
