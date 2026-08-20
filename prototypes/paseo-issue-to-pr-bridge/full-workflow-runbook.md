# P3 full fixture workflow runbook

This is the evidence protocol for issue #20. It prepares the real `skflowne/spade-fixture#1` run without implementing or bypassing the Paseo adapter owned by #18 or the GitHub and checkout surfaces owned by #19. Record a result only after observing it; use `Not run`, `Not observed`, or `Blocked` instead of predicting behavior.

## Ownership and safety

- `SpadePaseoAdapter` owns daemon access, agent ancestry, opaque workspaces, normalized timelines, and Paseo restart reconciliation. This run consumes the #18 handoff.
- `SpadeGitHubAdapter` owns authenticated issue and pull-request reads. The #19 handoff owns generic commit, push, and pull-request creation actions, including the small typed checkout methods it adds to `SpadePaseoAdapter`.
- The P3 ledger owns durable SPADE IDs and external resource references. Do not edit it to manufacture a successful reconciliation.
- Git and GitHub own fixture commits, refs, issue identity, and pull-request identity. Record exact values returned by those systems.
- The unchanged `paseo-issue-to-pr` skill owns fixture implementation behavior. Do not add SPADE commands, stage metadata, or title/path/prompt/ordering classifiers to it.
- Never retain tokens, daemon credentials, authorization headers, or the contents of `~/.config/gh/hosts.yml` in evidence.
- Before a daemon restart, confirm there are no unrelated running agents. If there are, stop and record the restart as blocked rather than interrupting them.
- Do not merge the fixture pull request. Do not clean up agents, workspaces, branches, the pull request, or the fixture checkout until all evidence is captured.

## Preparation observation

Observed before the #18 and #19 handoffs on 2026-08-20:

| Item | Observation | Source |
|---|---|---|
| SPADE base | `bb1ee5cf3326d62764bd20e9f66f2a5d52d2367f` | `git rev-parse HEAD origin/main` after fetch/reset |
| Fixture base | Empty `main` at `199bced07fd3a626d795135bb144b25cbd262ca3` | local clone plus GitHub repository API |
| Fixture issue | `skflowne/spade-fixture#1`, open | `gh issue view` |
| GitHub CLI authentication | Active account `skflowne`; `gh` prefers HTTPS Git operations; token configured with `gist`, `read:org`, `repo`, and `workflow` scopes | redacted `gh auth status` |
| Fixture Git transport | Effective remote is SSH, `git@github.com:skflowne/spade-fixture.git`; non-mutating remote read succeeded at the fixture base | `git remote get-url origin` and `git ls-remote origin refs/heads/main`; global Git configuration rewrites GitHub HTTPS URLs to SSH |
| Installed Node / npm / Git / `gh` | Node `v24.18.0`; npm `12.0.0`; Git `2.53.0`; `gh` `2.96.0` | executable version commands |
| Installed Paseo CLI / daemon | CLI `0.3.1`; reachable daemon `0.3.1`, started `2026-08-20T09:42:39.787Z` | `paseo --version` and `paseo status --json` |
| Paseo restart safety | 52 listed agents: 3 running, 45 idle, 4 closed | summarized `paseo ls --json`; identities intentionally omitted |
| Locked SPADE tool versions | Electron `43.4.0`; Playwright `1.62.1`; TypeScript `6.0.3`; Vite `7.3.6` | `package-lock.json` |
| Installed SPADE dependencies | Not installed in this worktree | `npm ls --depth=0` failed with missing packages |

The installed Paseo runtime is not the `0.4.0` runtime required by #18. Because unrelated agents are running and #18 owns the controlled upgrade, issue #20 must not upgrade or restart Paseo during preparation. Re-run the inventory after the dependencies merge; do not reuse these preparation values as full-run values.

The fixture checkout is prepared at `/home/skflowne/projects/spade-fixture`, with local `main` and `origin/main` both at the fixture base above and no working-tree changes.

## Evidence directory

Store full-run evidence under:

```text
prototypes/paseo-issue-to-pr-bridge/artifacts/p3-full-workflow/
├── 00-environment.txt
├── 01-fixture-issue.png
├── 02-canvas-before-restart.png
├── 03-canvas-after-spade-restart.png
├── 04-canvas-after-paseo-restart.png
├── 05-resulting-pull-request.png
├── identities-before-spade-restart.json
├── identities-after-spade-restart.json
├── identities-before-paseo-restart.json
├── identities-after-paseo-restart.json
└── run-record.md
```

Additional raw logs or screenshots must use the next numeric prefix and be listed in `run-record.md`. Repository `.gitignore` ignores `artifacts/`; add intentional evidence with `git add -f`, then verify every expected path with:

```bash
git ls-files prototypes/paseo-issue-to-pr-bridge/artifacts/p3-full-workflow/
```

Redact secrets before adding files. Preserve opaque resource IDs needed for identity comparison; they are evidence, not credentials.

## Full-run record

Copy the sections below into `artifacts/p3-full-workflow/run-record.md`. Use ISO-8601 timestamps with offsets. Preserve raw command output in `00-environment.txt` and summarize it in the tables.

### 1. Exact environment and authentication inventory

Record whether each value is an installed runtime observation, package installation result, lockfile value, or remote response.

| Component | Exact version or identity | Source command/API | Observed at |
|---|---|---|---|
| SPADE base/head | Not run | `git rev-parse origin/main HEAD` | Not run |
| SPADE Electron runtime | Not run | installed package and launched runtime | Not run |
| Node | Not run | `node --version` | Not run |
| npm | Not run | `npm --version` | Not run |
| Paseo CLI | Not run | `paseo --version` | Not run |
| Paseo daemon | Not run | `paseo status --json` | Not run |
| `@getpaseo/client` | Not run | installed package metadata | Not run |
| `gh` | Not run | `gh --version` | Not run |
| Git | Not run | `git --version` | Not run |
| Fixture base | Not run | local and remote ref comparison | Not run |

Authentication checklist:

- [ ] `gh auth status` identifies the intended account and sufficient scopes; only the account, protocol, and scope names are recorded.
- [ ] `gh repo view skflowne/spade-fixture` succeeds.
- [ ] `gh issue view 1 --repo skflowne/spade-fixture` succeeds.
- [ ] `git -C /home/skflowne/projects/spade-fixture remote get-url origin` records the effective Git transport.
- [ ] `git -C /home/skflowne/projects/spade-fixture ls-remote origin refs/heads/main` succeeds without mutation and returns the expected fixture base.
- [ ] Paseo reports the intended local daemon as reachable.
- [ ] No secret-bearing configuration or header appears in an artifact.

### 2. Preconditions

- [ ] #18 and #19 are merged into the SPADE base used for the run.
- [ ] The SPADE worktree is clean and dependencies are installed from the lockfile.
- [ ] Paseo CLI, daemon, and SDK satisfy the #18 handoff version.
- [ ] The fixture issue is open and the fixture has no pre-existing run branch or pull request that would collide.
- [ ] Local fixture `main` exactly matches `origin/main` before the workflow starts.
- [ ] The P3 ledger path and artifact directory are recorded.
- [ ] A provider/model capable of running the unchanged skill is selected and recorded.

If a precondition fails, stop before creating resources and record the exact command, output, time, and owner needed to unblock it.

### 3. Launch and native source evidence

1. Start P3 through its documented command and record the exact command and ledger path.
2. Open `/home/skflowne/projects/spade-fixture` as the project.
3. Select `skflowne/spade-fixture#1` through the native GitHub Issue surface.
4. Capture `01-fixture-issue.png` with repository, number, title, state, body, labels, URL, and update state visible.
5. Create one WorkItem from that issue and record the SPADE Project, WorkItem, and GitHub resource IDs.
6. Spawn one generic root agent into that WorkItem with exactly:

   ```text
   /skill:paseo-issue-to-pr https://github.com/skflowne/spade-fixture/issues/1
   ```

7. Record the provider, model, root Paseo agent ID, root workspace ID, and creation time. Do not infer a workflow stage from any name or prompt.

### 4. Identity and timeline checkpoints

At every checkpoint, export an authoritative SPADE snapshot and authoritative Paseo/GitHub responses close enough together to explain any race. One row represents one identity; do not collapse shared workspaces or duplicate one agent for multiple views.

SPADE identity table:

| SPADE node ID | Kind | WorkItem ID | Provider | External kind | Opaque external ID | Revision | Resource state |
|---|---|---|---|---|---|---|---|
| Not observed | Not observed | Not observed | Not observed | Not observed | Not observed | Not observed | Not observed |

Paseo agent table:

| Paseo agent ID | Identity type (`managed` / `provider-native`) | Explicit parent agent ID | Opaque workspace ID | Lifecycle state | First/last normalized event identity or range |
|---|---|---|---|---|---|
| Not observed | Not observed | Not observed | Not observed | Not observed | Not observed |

Paseo workspace table:

| Opaque workspace ID | Referencing agent IDs | Checkout path reported by Paseo | Git branch/status reported by checkout API | SPADE node ID |
|---|---|---|---|---|
| Not observed | Not observed | Not observed | Not observed | Not observed |

GitHub resource table:

| Repository | Kind | Number | URL | Head/base/revision | State/checks/review range | SPADE node ID |
|---|---|---|---|---|---|---|
| Not observed | Not observed | Not observed | Not observed | Not observed | Not observed | Not observed |

For each table, record:

- row count and uniqueness key;
- duplicate-key count;
- missing referenced parent/workspace/node count;
- collection start/end timestamps;
- whether the data came from a public SDK, isolated internal API, `gh`, Git, ledger snapshot, or visible UI.

### 5. Stable workflow and checkout evidence

Allow the unchanged skill to run normally. Record every discoverable managed descendant and provider-native child, explicit parent, exact workspace ID, normalized timeline range, failure, reconnect, and manual intervention. Never classify implementation, review, or fix stages from names, paths, branches, prompts, skill names, or creation order.

When the workflow requests repository mutations, use the generic selected-workspace actions supplied by #19 in the order the workflow actually needs:

- refresh checkout status;
- commit;
- push;
- create/link pull request;
- refresh pull-request state, checks, and review/comment activity.

Record raw success, partial, or failure state for each action. Capture `05-resulting-pull-request.png`. Leave the fixture pull request open.

### 6. SPADE restart checkpoint

1. Wait for a stable completed or handoff state and record why the state is considered stable.
2. Capture `02-canvas-before-restart.png` and `identities-before-spade-restart.json`.
3. Close SPADE without deleting its ledger or external resources.
4. Relaunch SPADE with the same ledger path.
5. Wait for reconciliation to report a stable connected, stale, missing, or error state.
6. Capture `03-canvas-after-spade-restart.png` and `identities-after-spade-restart.json`.
7. Compare exact SPADE node IDs, Paseo agent IDs, workspace IDs, GitHub identities, parent edges, timeline ranges, and counts.
8. Record every added, removed, changed, duplicated, stale, or ambiguous row. A clean result requires zero duplicate identity keys and zero duplicate parent/resource edges; do not rewrite the ledger to obtain it.

### 7. Paseo restart checkpoint

1. Capture `identities-before-paseo-restart.json`.
2. Re-run the active-agent summary. If any unrelated agent is running, record the count and owners available from non-secret metadata, mark this checkpoint `Blocked`, and do not restart.
3. If the restart is safe, record the exact command and time, restart the same Paseo runtime, and wait for SPADE to reconnect/refetch.
4. Capture `04-canvas-after-paseo-restart.png` and `identities-after-paseo-restart.json`.
5. Apply the same exact-ID, parent-edge, workspace-reference, timeline-range, and duplicate comparisons as the SPADE restart.
6. Record disconnected, reconnecting, stale, missing, and error transitions in timestamp order.

### 8. API inventory

List every Paseo operation actually exercised. Do not mark an operation public merely because a public API was expected.

| Operation | Public SDK symbol/path used | Internal symbol/path used | Why internal access was required | Observed result | Stable SDK request |
|---|---|---|---|---|---|
| Not observed | Not observed | Not observed | Not observed | Not observed | Not observed |

Record GitHub reads separately from Paseo checkout mutations so their ownership remains clear.

### 9. Failures, interventions, and cleanup ledger

| Time | Resource/action | Failure or intervention | Raw evidence path | Effect on result | Manual owner/follow-up |
|---|---|---|---|---|---|
| Not observed | Not observed | Not observed | Not observed | Not observed | Not observed |

Cleanup responsibility table:

| Resource | Exact ID/path/URL | Created by | Evidence captured | Cleanup owner | Required final disposition | Disposition performed |
|---|---|---|---|---|---|---|
| Root/descendant agents | Not observed | Not observed | No | Issue #20 run operator after evidence handoff | archive/delete only after handoff | No |
| Paseo workspaces | Not observed | Not observed | No | Issue #20 run operator after evidence handoff | archive/remove only after handoff | No |
| Fixture checkout | `/home/skflowne/projects/spade-fixture` | #20 preparation | Baseline only | Issue #20 run operator after evidence handoff | retain through review | No |
| Fixture branch | Not observed | Not observed | No | Issue #20 run operator after evidence handoff | retain while the PR is open | No |
| Fixture pull request | Not observed | Not observed | No | Fixture repository owner after #20 review | leave open; never merge in this run | No |
| SPADE ledger | Not observed | SPADE P3 | No | Issue #20 run operator after evidence handoff | retain through review | No |

### 10. Findings and documentation gate

After all obtainable checkpoints:

- summarize observed facts in the P3 README;
- answer each issue #20 question from recorded evidence, using `Unresolved` where evidence is insufficient;
- distinguish public SDK support, isolated internal dependencies, observed gaps, and recommendations;
- update canonical docs only for product direction selected from the run, never for runbook assumptions;
- verify every changed HTML documentation page in a browser;
- link every claim to a table, raw log, screenshot, ledger snapshot, GitHub URL, or exact command result.

## Final verification

Run and retain raw output for:

```bash
npm run prototype:p3:typecheck
npm run prototype:p3:build
npm run typecheck
npm run lint
xvfb-run -a npm test
git diff --check
```

Also verify:

- every required artifact is present, redacted, and returned by `git ls-files`;
- the fixture pull request remains open and unmerged;
- the SPADE branch contains no #18/#19 implementation recreated outside their owners;
- before/after identity comparisons report their actual differences rather than only a pass/fail summary;
- unresolved external blockers include reproducible commands, raw output, timestamps, and the responsible dependency.
