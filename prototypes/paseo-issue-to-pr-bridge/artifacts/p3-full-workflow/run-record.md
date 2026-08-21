# SPADE P3 full fixture run record

Run window: 2026-08-21T02:23:25Z–2026-08-21T03:08:59Z. All timestamps use UTC unless an offset is shown. This record describes observations; recommendations belong in the prototype README and canonical documentation.

## Environment

| Component | Exact value | Evidence |
|---|---|---|
| SPADE base | `7fa22d8089f510117b31b93ebaa087a313c1bd47` | `00-environment.txt` |
| SPADE run head | `ffaf607aa90a1cb7456b76eb3b4ee2ddc6adb3a3` | `00-environment.txt` |
| SPADE Electron | `43.4.0` | installed package and launched runtime |
| Node / npm | `v24.18.0` / `12.0.0` | executable versions |
| Paseo CLI / daemon / client | `0.4.0` / `0.4.0` / `0.4.0` | isolated CLI, daemon logs, installed package |
| Pi / Codex provider CLIs | `0.84.2` / `0.144.6` | executable versions |
| `gh` / Git | `2.96.0` / `2.53.0` | executable versions |
| Isolated Paseo home | `/tmp/spade20-paseo-0.4-home` | retained after shutdown |
| Isolated Paseo endpoint | `ws://127.0.0.1:17680/ws` | daemon and SPADE records |
| SPADE ledger | `/tmp/spade20-p3-ledger.json` | retained after shutdown |
| Fixture base | `199bced07fd3a626d795135bb144b25cbd262ca3` | Git and GitHub |
| Fixture PR head | `32a9778e25e849ff5ff3d332ae86053b4ea6e3fb` | GitHub PR #7 |

`npm ci` installed 298 packages with zero vulnerabilities. npm 12 did not run Electron's downloader because of the repository script allowlist; the exact installed package's `install.js` was invoked directly, yielding Electron `v43.4.0`. Authentication was the existing `skflowne` GitHub account. The artifact records account, protocol, and scope names only; the masked `gho_************************************` authentication output was explicitly allowlisted as non-secret evidence, and usable token material is absent.

## Launch and native resources

The integrated P3 shell loaded `skflowne/spade-fixture#1` through `SpadeGitHubAdapter`, rendered it in the native Issue surface, and created WorkItem `work-item-6` under Project `project-p3`. The Issue is SPADE node `node-7` with exact external identity `github / issue / skflowne/spade-fixture#1`.

P3 opened `/home/skflowne/projects/spade-fixture` as Paseo project `prj_fb81b9fbfd71fd8d` and workspace `wks_dede527f1d2385de`. It spawned root agent `fe107baf-4b33-4442-9040-9183efa738da` into WorkItem `work-item-6` through the generic root-agent action with provider/model `pi/openai-codex/gpt-5.6-sol` and this unchanged prompt:

```text
/skill:paseo-issue-to-pr https://github.com/skflowne/spade-fixture/issues/1
```

The unchanged workflow reached its published handoff without a controller prompt or skill modification and created open, unmerged fixture PR <https://github.com/skflowne/spade-fixture/pull/7>. Its workflow/scope result is unresolved because a published review finding remains unfixed, as detailed under “Native GitHub evidence and fixture result.” P3 linked the PR through the generic selected-workspace PR-status action and rendered native PullRequest node `node-14`, exact identity `github / pull-request / skflowne/spade-fixture#7`, with `derived` edge `edge-15` from implementation workspace node `node-11`.

## Managed agents and opaque workspaces

The Paseo 0.4 CLI/public agent RPC exposed five unique managed agents with zero missing parent or workspace references. Four descendants all carried the explicit durable parent label for the root. No role or stage is assigned here.

| Agent ID | Explicit parent ID | Workspace ID | Stable pre-restart state | Bounded tail before restart |
|---|---|---|---|---|
| `fe107baf-4b33-4442-9040-9183efa738da` | — | `wks_dede527f1d2385de` | `idle` | epoch `621cad44-d8f4-4283-8ac2-c2dd9b7b3153`, seq `127`–`218`, 40 returned entries |
| `d5124f66-52d8-4714-90e2-9f0646271483` | root | `wks_bc966044af2bfedd` | `idle` | epoch `e4bb864c-b2d4-4bbb-a2ff-9a1a1f146bb1`, seq `1`–`249`, 34 entries |
| `838484d7-8180-4595-b071-ddc92b5743a7` | root | `wks_7055e4e4aa6c4080` | `idle` | epoch `a8e5073c-0a68-4fad-bec2-1a31de3eb859`, seq `99`–`222`, 40 entries |
| `aa1f78f1-c5a2-466f-b01f-26bfb10ae93b` | root | `wks_f27cf54214571eef` | `idle` | epoch `71c5936b-27fd-418f-bc59-372bb282195b`, seq `1`–`103`, 36 entries |
| `cc7f3107-330c-489b-a538-ca9257e5b768` | root | `wks_2f5fe20b3713f228` | `idle` | epoch `d2494686-3df5-49c5-b13a-c97070b199c6`, seq `4`–`110`, 41 returned entries |

The 40 value is the requested projected-tail limit, not proof of a complete conversation. One RPC returned 41 projected entries for a requested limit of 40; this record preserves the response rather than normalizing it away.

| Workspace ID | Exact referencing agent | Checkout branch | SPADE node |
|---|---|---|---|
| `wks_dede527f1d2385de` | root | `main` | `node-8` |
| `wks_bc966044af2bfedd` | `d5124f66…` | `paseo/issue-1-discovery-a557b80a` | `node-10` |
| `wks_7055e4e4aa6c4080` | `838484d7…` | `feature/issue-1-vue-scaffold` | `node-11` |
| `wks_f27cf54214571eef` | `aa1f78f1…` | `feature/issue-1-vue-scaffold-1` | `node-12` |
| `wks_2f5fe20b3713f228` | `cc7f3107…` | `feature/issue-1-vue-scaffold-2` | `node-13` |

The ledger preserves all five opaque workspace identities without an implementation/review/fix type or lane. The final canvas presentation has a gap: workspace `node-13` and PullRequest `node-14` both occupy `{x: 156, y: 976}`, so the PR visually covers the fifth workspace in `02-canvas-before-restart.png`. This collision does not remove or duplicate the underlying workspace identity.

## Provider-native capability gap

The integrated P3 capability record explicitly reports `provider-subagents: unavailable`, and `SpadePaseoAdapter` supplies no provider-native rows. No provider-native query was added for this run. Therefore provider-native descendants and complete-tree coverage are **unresolved**. Empty provider-native rows are not evidence that no such children existed.

The unchanged managed workflow's own Pi agents used internal Pi subagents during Portolan and drift reviews, visible in managed-agent timelines but not available as authoritative durable provider-native identities through P3. No SPADE node was manufactured from those transcript mentions.

## Integrated reconciliation failure

Immediately after root creation, P3 persisted root node `node-9` and its binding, then authoritative refresh failed with:

```text
Agent not found: fe107baf-4b33-4442-9040-9183efa738da
```

The failure reproduced on manual refresh, SPADE restart, and Paseo reconnect. At the same times, Paseo CLI 0.4 `ls`, `inspect`, `logs`, workspace RPCs, and a read-only CLI-client diagnostic returned all five managed agents, explicit parents, workspaces, and timeline tails. The root cause remains unresolved: installed `@getpaseo/client` 0.4.0 supports and normalizes both the string and object `fetchAgent` call shapes, so call shape does not explain the discrepancy. No adapter change or alternate reconciliation path was added in issue #20.

Because recursive refresh aborted at exact-root fetch, P3 retained the root and did not create the four managed descendant agent nodes or delegated edges. To exercise factual workspace and native PR presentation, the operator used P3's existing generic `Attach Paseo workspace` action for each of the four exact descendant workspace IDs from durable Paseo parent/workspace records. This was a recorded manual intervention, not stage inference. Complete managed-descendant presentation remains unresolved.

## SPADE restart reconciliation

SPADE stopped gracefully at `2026-08-21T05:01:32+02:00` (PID `673583`) and relaunched at `2026-08-21T05:01:33+02:00` (PID `822392`) against the same ledger.

Before and after:

- SPADE node IDs and external identity keys were equal;
- edge keys were equal;
- managed agent IDs, parent/workspace mappings, workspace IDs, and GitHub identities were equal in authoritative external evidence;
- counts remained 10 SPADE nodes, 2 SPADE edges, 5 managed agents, and 5 Paseo workspaces;
- duplicate resource, edge, agent, and workspace counts remained zero;
- P3 retained every node but changed attached Paseo resources to `error` after the same exact-agent refetch failure;
- no descendant agent nodes appeared.

See `identities-before-spade-restart.json`, `identities-after-spade-restart.json`, and screenshots `02`/`03`.

## Paseo restart reconciliation

Restart safety found five isolated workflow agents, all idle, and no unrelated agent. Paseo stopped gracefully on the first daemon/supervisor and restarted at `2026-08-21T05:03:39+02:00` with launcher PID `830514`, supervisor `830584`, daemon `830621`, the same home, and port `17680`.

Observed transition: P3 changed from `error` to `stale` with transport close code 1005, automatically reconnected, then returned to the same `Agent not found` error. Exact SPADE node/resource/edge IDs remained unchanged and duplicate counts stayed zero.

Paseo preserved all five agent IDs, all five workspace IDs, and every parent/workspace mapping. Initial post-restart agent state was `closed`; subsequent timeline reads rehydrated the CLI-visible state to `idle`. This lifecycle transition is ambiguous in P3 because authoritative refresh failed.

Timeline identity did not survive. Every managed agent received a new epoch and replay-time timestamps; bounded ranges were resequenced. Content remained readable through CLI timeline fetch, but exact pre-restart epoch/range equality was false. The comparison concerns bounded projected tails only, not unbounded history.

See `identities-before-paseo-restart.json`, `identities-after-paseo-restart.json`, screenshots `04`/`07`, and the numbered timelines.

## Native GitHub evidence and fixture result

Native Issue and PR surfaces exposed the source body/state/URL, PR open state, base/head/revision, no configured checks, two review records, one workflow result comment, and `Open on GitHub`.

PR #7 at exact head `32a9778…` contains the requested runnable application evidence:

- the diff contains a Vue 3 TypeScript Vite scaffold and committed npm lockfile;
- `src/App.vue` renders `SPADE workflow fixture` and `This repository exercises an agent issue-to-PR workflow.`;
- README documents development and production-build commands;
- the unchanged skill timeline records clean-equivalent `npm install`, `npm run build`, and native production-preview rendering;
- independent clean clone validation repeated `npm install` (48 packages, zero vulnerabilities), `npm run build` (Vite 8.2.2, 12 modules), `git diff --check`, and native browser rendering with no console/page errors;
- PR #7 is open and unmerged.

Workflow/scope acceptance is nevertheless **unresolved**. Published review round 1 required removal of `.codegraph-evals/20260821T023509Z-issue-1-vue-scaffold.md` as unrelated agent-internal evidence. The file remains in the unchanged PR head, while round 2 and the workflow result subsequently reported no findings and a clear handoff without resolving it. This record therefore does not classify PR #7 as satisfying fixture issue #1 or the workflow as clear.

Evidence: `10-implementation-timeline.txt`, `11-review-round-1-timeline.txt`, `12-review-round-2-timeline.txt`, `13-fixture-pr.json`, `14-fixture-diff.patch`, `15-fixture-validation.txt`, `16-fixture-render.png`, and `17-fixture-browser-qa.json`.

## API inventory

| Operation exercised | Surface used | Result | Stable SDK gap evidenced |
|---|---|---|---|
| connect/reconnect/close | exported internal `DaemonClient` behind `SpadePaseoAdapter` | connected; reconnect observed | public facade must expose one reusable connection/driver |
| providers/server readiness | internal driver provider snapshot/server-info | root spawn readiness passed | stable readiness API |
| open project/workspace reads | internal driver; generic P3 commands | five exact workspaces | public project/workspace facade with IDs and subscriptions |
| create root agent | internal driver through P3 | root created and ran unchanged prompt | public create API must preserve explicit caller/parent identity |
| list/exact agent, parent, workspace, timeline | internal driver in P3; CLI public RPC diagnostic | CLI facts available; integrated exact fetch failed for an unresolved reason | stable exact-agent reconciliation contract and cross-client diagnostics |
| provider-native discovery | no integrated operation | unavailable/unresolved | stable provider-native child identity and lifecycle API |
| timeline tail | CLI public RPC diagnostic; integrated internal driver intended | bounded tails available externally; integrated reconciliation aborted | stable normalized tail and identity semantics across restart |
| subscriptions | internal driver | transport stale/reconnect notifications observed | stable agent/workspace/reconnect subscription contract |
| checkout status/diff/commits | internal checkout RPCs on selected workspace | clean exact PR workspace read | public selected-workspace checkout status API |
| checkout commit/push/PR create | unchanged workflow used Paseo CLI/GitHub; P3 did not repeat mutations | PR #7 created once | public generic mutation API remains needed for P3 |
| checkout PR status | internal checkout RPC plus `SpadeGitHubAdapter` | PR #7 linked and reconciled natively | public typed PR identity/status API |
| GitHub Issue/PR detail | authenticated `gh` through `SpadeGitHubAdapter` | native nodes refreshed | not a Paseo API |

Direct internal imports remained one and confined to `main/SpadePaseoAdapter.ts`. The evidence-only CLI diagnostic was not fed into SPADE reconciliation.

## Interventions and failures

| Time/order | Intervention or failure | Effect |
|---|---|---|
| Prelaunch | npm 12 skipped Electron binary download under repository script allowlist; exact package installer run directly | P3 Electron became launchable; version unchanged |
| UI harness | Served built renderer at local HTTP because browser automation rejects content inspection of local `file:` pages | Enabled browser evidence only; production P3 code unchanged |
| Root spawn | immediate and repeated exact-agent refetch returned `Agent not found` | blocked descendant/timeline P3 reconciliation |
| Post-workflow | manually attached four exact workspaces through existing generic P3 action | rendered workspace facts; did not fabricate descendant agents |
| Post-workflow | selected exact PR checkout and ran generic refresh/status | created native PR node; did not create a second PR |
| Paseo restart | agents initially `closed`, then CLI timeline reads exposed them `idle`; epochs/ranges changed | lifecycle and timeline restart ambiguity recorded |
| Cleanup | npm preview parent exited but exact child PID `841214` remained | exact child terminated; final listener scan clean |

The root workflow required no user decision, prompt rewrite, stage metadata, or manual repository mutation.

## Cleanup disposition

| Resource | Exact identity | Final disposition | Owner |
|---|---|---|---|
| Root and four managed descendants | IDs above | provider processes exited; persisted records retained in isolated home | issue #20 operator through PR review |
| Five Paseo workspaces | IDs above | clean worktrees retained in isolated home | issue #20 operator through PR review |
| Isolated daemon | final launcher/supervisor/daemon `830514/830584/830621`, port `17680` | stopped gracefully; listener absent | issue #20 operator |
| Isolated Paseo home | `/tmp/spade20-paseo-0.4-home` | retained as restart evidence | issue #20 operator through PR review |
| SPADE Electron / renderer server | PID `822392` / `673564` | stopped; ports `17700`/`41730` absent | issue #20 operator |
| SPADE ledger | `/tmp/spade20-p3-ledger.json` | retained, SHA-256 `e09156a7f25cf2b1b328a873153e1a45b22b1e8f73dd5c68867aa63a955886ec` | issue #20 operator through PR review |
| Fixture source checkout | `/home/skflowne/projects/spade-fixture` | retained clean on `main` | issue #20 operator |
| Fixture branch | `feature/issue-1-vue-scaffold` at `32a9778…` | local worktree and remote branch retained while PR open | fixture repository owner |
| Fixture PR | <https://github.com/skflowne/spade-fixture/pull/7> | retained open and unmerged | fixture repository owner |
| Temporary validation checkout/server | `/tmp/spade20-fixture-validation`, port `41731` | removed/stopped; final listener scan clean | issue #20 operator |
| Isolated 0.4 CLI install | `/tmp/spade20-paseo-cli` | retained through SPADE #20 review | issue #20 operator |

Full teardown evidence is `18-cleanup.txt`.

## Artifact inventory

- `00-environment.txt`: exact refs, versions, auth summary, isolated process identities, lockfile install.
- `01-fixture-issue.png`: native Issue surface.
- `02-canvas-before-restart.png`: Project/WorkItem and factual resources before restart.
- `03-canvas-after-spade-restart.png`: retained identities and exact-agent error.
- `04-canvas-after-paseo-restart.png`: reconnect followed by exact-agent error.
- `05-resulting-pull-request.png`: native PR activity surface.
- `06-paseo-authoritative-diagnostic.json`: pre-restart agent/workspace/tail facts.
- `07-paseo-disconnected.png`: stale transport transition.
- `08`–`12`: root, discovery, implementation, and review timelines.
- `13-fixture-pr.json`, `14-fixture-diff.patch`: GitHub PR evidence.
- `15-fixture-validation.txt`, `16-fixture-render.png`, `17-fixture-browser-qa.json`: independent acceptance proof.
- `18-cleanup.txt`: process, workspace, branch, PR, home, ledger, and listener disposition.
- Four `identities-*.json` files: exact before/after checkpoint tables and integrity counts.
