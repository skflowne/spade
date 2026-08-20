# P3 generic work-item and group shell

This directory is the isolated shell for SPADE Prototype 3. It exercises workflow-agnostic Group, WorkItem, placeholder-resource, provenance, IPC, and persistence boundaries without calling Paseo, GitHub, or any external service. It is not part of the production `src/` Electron entry.

## Run

```bash
npm install
npm run prototype:p3
```

The main process stores `p3-ledger.json` under Electron's user-data directory. Automated checks set `SPADE_P3_LEDGER_PATH` to an isolated temporary file so relaunch behavior is deterministic.

Integrity checks:

```bash
npm run prototype:p3:typecheck
npm run prototype:p3:build
npx playwright test tests/e2e/p3-model.spec.ts tests/e2e/p3-ledger.spec.ts
xvfb-run -a npx playwright test tests/e2e/p3-shell.spec.ts
npm run typecheck
npm run lint
xvfb-run -a npm test
git diff --check
```

## What the shell proves

- Group and WorkItem records pass through the same `projectGroupHull` geometry projection and the same `GroupHull` renderer.
- WorkItem adds task/source metadata, lifecycle status, semantic membership, and activity-sidebar projection to the shared Group contract.
- Ordinary Group placement changes `groupId` only. WorkItem placement assigns `workItemId`; moving an existing WorkItem member into an ordinary Group preserves that semantic membership.
- Group lookup prefers an exact stable ID, otherwise accepts one case-insensitive name match. Ambiguous names produce a visible error, while each hull exposes its ID for recovery.
- Generic commands create Group and WorkItem records, spawn or attach agent/workspace placeholders, connect existing nodes with provenance-only edges, and update WorkItem status.
- External placeholders reconcile by exact provider/kind/opaque-ID identity. Repeating a placeholder or edge command does not duplicate its record.
- Main-process persistence writes a complete same-directory temporary file and atomically renames it over the ledger. Failed writes/replacements leave the prior ledger readable.
- Command execution serializes mutation, persistence, and snapshot publication so concurrent calls cannot reuse IDs or lose accepted changes.
- The sandboxed renderer has no `require`, Node `process`, filesystem, `gh`, Paseo client, or arbitrary IPC access. Preload exposes only typed snapshot, command, and snapshot-event methods.

## Handoff boundaries for #18

All contracts are prototype-local and exported for the next child:

| Boundary | Owner | Exported contract |
|---|---|---|
| Records and external identity | `shared/model.ts` | `PrototypeLedger`, `PrototypeGroup`, `WorkItem`, `PrototypeNode`, `PrototypeEdge`, `ExternalResourceReference`, exact runtime predicates |
| Generic mutations | `shared/commands.ts` | `PrototypeCommand`, `applyPrototypeCommand`, `resolveGroup`, `createInitialLedger` |
| Canvas and activity views | `shared/projection.ts` | `projectGroupHull`, `projectActivitySidebar`, hull/sidebar projections |
| Renderer bridge | `shared/ipc.ts` | `P3PrototypeBridge`, narrow channel constants, `isPrototypeCommand` |
| Durable replacement | `main/ledgerStore.ts` | `LedgerStore`, injectable file-operation contract |
| Sequenced application service | `main/commandService.ts` | `PrototypeCommandService`, ledger-store port |

A later adapter can submit generic commands and exact resource references through these seams. It must not infer workflow stages from titles, paths, branches, or creation order.

## Direct validation record

Environment: Electron 43 under Xvfb, exercised through Playwright's real Electron automation.

| Check | Observation | Result |
|---|---|---|
| Shared hull | WorkItem and ordinary Group render as `.group-hull` through one component; deterministic projection coverage compares identical geometry. | Pass |
| Sidebar/status distinction | WorkItems appear with semantic status; ordinary Groups do not. A blocked WorkItem renders a red `BLOCKED` label on hull and sidebar. | Pass |
| Focus/jump | Selecting a WorkItem changes the React Flow viewport transform and marks the focused hull. | Pass |
| Generic commands | UI created a WorkItem and duplicate-named Groups, spawned an agent, attached a workspace, and connected existing nodes. | Pass |
| Membership | WorkItem placeholders show `work-item-1`; the ordinary-Group seed workspace shows `None · visual containment only`. | Pass |
| Ambiguous lookup | Name targeting showed the required visible error; targeting the displayed stable ID then succeeded and cleared the error. | Pass |
| Runtime IPC guard | Commands with extra keys, array-valued status, or array-valued relation were rejected without ledger mutation. | Pass |
| Sandbox | Renderer reported `require` and `process` as unavailable and exposed only `execute`, `snapshot`, and `subscribe`. | Pass |
| Reload | Relaunching Electron against the same temporary ledger restored exact records, references, node/edge counts, and status. | Pass |
| Clean build prerequisite | After deleting prototype output, the complete `npm test` gate rebuilt main, preload, and renderer entries before running the full suite. | Pass |

Artifact: [`artifacts/p3-generic-shell.png`](artifacts/p3-generic-shell.png)

## Scope and residual limitations

- Resources are deterministic placeholders only. There are no Paseo calls, GitHub entities, checkout actions, workflow stages, MCP/CLI transports, files, terminals, or external-service requirements.
- Node dragging is presentation-only in this shell; no move command is persisted yet.
- The ledger format is prototype-only and intentionally small. It validates stable identities and references but does not claim production migration or crash-recovery guarantees beyond atomic local replacement.
- Edges communicate provenance and context only; they never execute or schedule work.
- Canonical product documentation is unchanged. This prototype validates proposed boundaries but does not redefine current production facts or select new product direction.
