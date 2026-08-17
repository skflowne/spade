# Repository rules

SPADE is the Spatial Agent Development Environment. [`docs/plan.html`](./docs/plan.html) owns product direction, [`docs/foundation.html`](./docs/foundation.html) owns current system invariants, [`docs/architecture.html`](./docs/architecture.html) owns architecture diagrams and system boundaries, [`docs/testing.html`](./docs/testing.html) owns automated-test policy, and [`docs/style/style-guide.html`](./docs/style/style-guide.html) owns visual design.

## Workflow

- Every PR has a primary issue and a dedicated branch. Never commit directly to `main`.
- Issue and PR titles begin `[SPADE-<issue-number>]`; PRs use their primary issue number.
- Make each change complete and cohesive. Keep unrelated corrections separate.
- Before handoff, determine whether the change affects facts presented under `docs/`. Update every affected canonical page and verify changed pages in the browser; work is incomplete while its documentation is stale.
- Apply rigor proportionally. Changes confined to documentation, mockups, prototypes, or other non-production artifacts do not require automated tests; verify the artifact directly.
- A prototype, as its name implies, is built to answer questions, it DOES NOT redefine docs

## Design

- Single responsibility defines what belongs together.
- A single source of truth defines who is authoritative.
- Domain organization defines where each responsibility lives.
- Process boundaries define where it must not leak.
- Product UI, mockups, and HTML documentation follow the visual style guide and consume its shared tokens.
- Comments explain only non-obvious invariants, constraints, or dependency behavior.

## Verification

Run and report:

```bash
npm run typecheck
npm run lint
npm test
git diff --check
```

On headless Linux, use `xvfb-run -a npm test`.
