# GADE core foundation

## Invariants

1. **Record schema versioning:** every `CanvasNode`, `CanvasEdge`, `Project`, `WorkItem`, and `Workspace` carries the shared literal record version. Owner: `src/shared/domain.ts` through `DOMAIN_RECORD_VERSION` and each record's `version` field.
2. **Stable workspace identity and explicit membership:** `Workspace.id` is the opaque identity, branch data remains nullable metadata, and canvas membership is expressed only by `CanvasNode.workItemId` and `CanvasNode.workspaceId`. Owner: the record shapes in `src/shared/domain.ts`.
3. **Edges are descriptive only:** canvas edges can express only provenance/context relations and contain no execution, scheduling, or streaming contract. Owner: `CanvasEdge` and `CanvasEdgeRelation` in `src/shared/domain.ts`.
4. **One cross-process domain contract:** renderer and Electron-side code import the same definitions rather than declaring local variants. Owner: the single TypeScript module boundary formed by `src/shared/domain.ts` exports and direct imports at both consumer sites; M1 validation inspects those imports and checks that no consumer redeclares the five records.
5. **The shell has no workflow behavior:** startup creates one secure renderer window and the renderer displays a React Flow canvas without persistence or integrations. Owners: `src/main/index.ts` for the window lifecycle and `src/renderer/src/App.tsx` for the canvas surface.

## Milestones

### M1 — Shared domain and build foundation

Create the package/tool configuration and the single shared domain module, then consume that module from both main and renderer compilation paths without local record declarations. Add a compile-time contract fixture for the five exports. Validate install reproducibility, the consumer imports and absence of duplicate declarations, type checking, linting, and production builds. This milestone owns invariants 1–4 and has a correctness review gate because it establishes the shared API.

### M2 — Runnable Electron React Flow shell

Add the Electron lifecycle, secure BrowserWindow configuration, React entry point, minimal React Flow canvas, focused Electron startup/canvas end-to-end spec, and concise developer commands. Validate the focused spec plus all repository checks. This milestone owns invariant 5 and has a correctness review gate because it establishes startup and visible behavior.

## Material tooling decisions

Registry metadata was checked before implementation.

- **Package manager — npm selected.** npm needs no additional bootstrap and is sufficient for this single-package repository. pnpm is maintained and has stronger store/isolation behavior but adds a package-manager prerequisite whose monorepo benefits are unused here. Yarn is also viable but adds setup without a repository convention; its classic line is older, while Berry would add configuration. Bun is fast and maintained, but adopting another runtime/toolchain is unnecessary for an Electron shell.
- **Electron/Vite integration — `electron-vite` selected.** It directly builds the main, preload, and renderer targets with one small configuration. Electron Forge plus its Vite plugin is the official packaging-oriented option, but packaging/makers are outside this issue and its plugin requires more Forge configuration. `vite-plugin-electron` is viable for Vite-first apps but requires more manual lifecycle/configuration ownership. Plain Vite/esbuild would duplicate target orchestration. `electron-vite@5` supports Vite through v7, so Vite is pinned to the current v7 line rather than incompatible Vite v8.
- **UI dependencies — current stable Electron 43, React 19, and `@xyflow/react` 12 lines.** The shell uses the maintained React Flow package name and no component framework.
- **Type/lint toolchain — TypeScript 6 and ESLint 10 with `typescript-eslint`.** TypeScript stays below 6.1 because that is the current parser peer range; selecting TypeScript 7 would violate it.
- **Test runner — Playwright selected for the behavior-bearing test.** Its Electron driver launches the real installed Electron executable and can assert the first BrowserWindow's rendered canvas. Vitest or Testing Library would be smaller for isolated renderer logic but cannot prove Electron startup; adding both would duplicate test infrastructure. Node's built-in runner does not provide the required DOM/Electron path. Shared record exports and shapes are covered proportionally by the compile-time contract plus `tsc`, because the records are static TypeScript contracts rather than runtime behavior.

## Developer commands

- `npm install` — install from the lockfile (use `npm ci` for clean validation).
- `npm run dev` — start Electron with Vite development servers.
- `npm run build` — build main, preload, and renderer bundles.
- `npm run typecheck` — verify application and contract types.
- `npm run lint` — lint source, tests, and configuration.
- `npm test` — build, launch Electron, and verify the React Flow canvas. On headless Linux run `xvfb-run -a npm test`.
