# P3 Paseo issue-to-PR bridge

This directory is the isolated SPADE Prototype 3 shell and Paseo bridge. It keeps Group and WorkItem behavior workflow-agnostic while projecting exact Paseo agent, workspace, connection, capability, and normalized-conversation facts. It is not part of the production `src/` Electron entry.

## Run

```bash
npm install
npm run prototype:p3
```

The executable creates one `SpadePaseoAdapter` and one public `@getpaseo/client` connection. Configuration:

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
| Providers | Available | `providers.waitForReady`, local `providers.subscribe`; validation discovery used public `listAvailable` and `listModels` |
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
| Provider/model | Public discovery reported `codex/gpt-5.6-luna`; both validation agents completed `idle` |
| Workspace | `wks_8bcc691d2259c589` shared exactly by root and child |
| Root | `c1df22ff-bcfc-4b41-b79b-d262901b172a` |
| Child | `f1f1f5b6-14a8-4f8d-b514-af98d0b69053` with exact parent `c1df22ff-bcfc-4b41-b79b-d262901b172a` |
| Timelines | Two projected events for each agent, both below the 40-event bound |
| Repeated refetch | Stable root, agent, workspace, and timeline-agent identities |
| Cleanup | Child archived at `2026-08-21T00:33:54.655Z`; root archived at `2026-08-21T00:33:54.891Z`; isolated daemon stopped gracefully |

The validation prompts only requested exact short replies and prohibited tools/file changes. The adapter opened the existing checkout, created root and explicit child through public SDK calls, fetched two authoritative snapshots, verified exact parent/workspace identities and bounds, archived both agents, and closed its single client. No current Paseo process was stopped or upgraded.

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

## Scope and residual limitations

- This remains a prototype; it does not redefine canonical product direction or production architecture.
- Provider-native live discovery and activated timeline streaming remain unavailable through the public 0.4.0 facade.
- Server/feature version facts are validation evidence from the CLI status command, not runtime facts claimed by the adapter.
- Node dragging remains presentation-only; no move command is persisted.
- Edges communicate provenance and context only; they do not execute or schedule work.
- Canonical docs are unchanged because this prototype validates proposed boundaries rather than selecting new product facts.
