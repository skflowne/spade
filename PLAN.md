# GADE Plan

_Last updated: 2026-08-15_

## 1. Product vision

GADE is a desktop, graph/canvas-based agent development environment built around a spatial representation of work.

The canvas is a **mind map of ongoing work**, not an executable dataflow engine. Nodes represent live resources and durable artifacts: agent conversations, terminals, workspaces, diffs, browsers, files, whiteboards, and later task boards. Directed connections record where work came from, what it references, and how it branched over time.

The central workflow is:

```text
GitHub issues browser
  -> spawn connected agent
  -> create/attach branch-backed worktree workspace
  -> agent works in that workspace
  -> diff, terminal, file, and browser nodes remain attached to it
  -> agent-created subagents appear as connected collapsed conversation nodes
  -> commit / open PR from the workspace diff surface
```

## 2. Core design pillars

1. **Spatial work representation**
   - Position and grouping communicate meaning.
   - Connections communicate provenance, references, delegation, and chronology.
   - Connections do not trigger execution.

2. **Everything useful can become a node**
   - Live resources and static artifacts use the same outer node behavior.
   - Any node can spawn a connected node or connect an existing node.

3. **Projects, logical work, and execution workspaces are separate concepts**
   - Current hypothesis: one project owns one canvas, selected from an expandable sidebar.
   - Issues and ad-hoc tasks become logical work items that are grouped automatically on that canvas.
   - A logical work item may contain many Paseo workspaces, branches, and agents created by implementation, review, and fix stages.
   - A workspace remains the concrete checkout/worktree/cwd execution fact; it is visible on nodes but is not the primary manual grouping unit.

4. **Paseo is the initial control plane**
   - GADE should use an unmodified Paseo daemon where possible.
   - GADE owns the canvas, entity registry, renderers, and spatial persistence.
   - Paseo remains the source of truth for agents, terminals, workspaces, Git state, and normalized conversation events.

5. **Rich rendering without rebuilding every tool**
   - Agent answers render as structured Markdown, Mermaid, full custom HTML/JavaScript, code, tool calls, file reads, and diffs.
   - Full IDE support initially means opening the current workspace/file in a configured external IDE.
   - Whiteboards remain a later entity if real workflows prove them useful.

6. **Prototype uncertain interaction boundaries before fixing the architecture**
   - Workspace creation and agent creation ordering.
   - Browser rendering inside transformed canvas nodes.
   - Heavy interactive child surfaces inside React Flow.
   - Paseo subagent identity and reconnect behavior.

## 3. Initial technology direction

| Layer | Initial direction |
| --- | --- |
| Desktop shell | Electron baseline; Tauri does not remove the native-webview positioning problem, so compare only if the Electron browser spike fails or footprint becomes decisive |
| Outer canvas | React Flow / xyflow |
| Whiteboard node | Deferred until the core workflow proves a real need; tldraw production use would require a commercial/hobby license key |
| Agent control plane | Unmodified Paseo daemon |
| Terminal | Paseo terminal protocol rendered with xterm.js |
| Agent conversation | Paseo normalized timeline rendered as native GADE HTML |
| Embedded editor | Monaco plus a small workspace LSP service |
| Full IDE | External open action; VS Code/Remote-WSL first, configurable commands later |
| Markdown | Markdown renderer with configurable conversation expansion |
| Diagrams | Mermaid blocks inside Markdown/rich responses |
| Rich HTML | Full agent-authored HTML/JavaScript blocks in an unsandboxed iframe/document runtime, with a GADE interaction bridge |
| Browser | Electron guest `<webview>` prototype; compare a bounds-synchronized native overlay only if required |
| Git/GitHub | Paseo workspace/forge/Git operations first; GitHub App only when webhook/organization automation is needed |
| Execution | Current host user environment; no Docker/container isolation in v1 |
| Persistence | GADE persists canvas/layout/entity references; resource owners persist their own state |

### Explicit deferrals

- No executable workflow/dataflow engine.
- No containerized repository setup or execution isolation.
- No embedded full IDE in v1.
- No X6 dependency in v1. Mermaid and rich HTML should first prove insufficient for architecture diagrams.
- No tldraw integration until the issue workflow and core entities are validated.
- No ACP or GADE-owned MCP integration in v1.
- No security hardening or sandbox restrictions for agent-authored HTML/JavaScript in the prototype; runtime isolation may still be used to prevent CSS/lifecycle collisions.
- No assumption that branch name is workspace identity.

## 4. Domain model

### 4.1 Canvas node

A canvas node is a durable GADE record pointing at content or a live resource owned elsewhere.

```ts
type CanvasNode = {
  id: string;
  entityType: string;
  entityVersion: number;
  title: string;
  shortDescription?: string;

  position: { x: number; y: number };
  size?: { width: number; height: number };
  collapsed: boolean;
  projectId: string;
  workItemId: string | null;
  workspaceId: string | null;

  config: unknown;              // versioned and validated by the entity definition
  resourceRef: ResourceRef | null;
  cachedPresentation?: {
    revision?: string;
    summary?: string;
    updatedAt: string;
  };

  createdAt: string;
  updatedAt: string;
};
```

A node does not copy a file, agent transcript, Git diff, PTY, or browser page into the canvas record as its source of truth. It stores a locator and may retain a bounded presentation cache.

### 4.2 Resource reference

```ts
type ResourceRef = {
  provider: "paseo" | "filesystem" | "electron" | "gade" | string;
  kind: string;
  id: string;
  revision?: string;
};
```

Examples:

- Paseo agent ID
- Paseo terminal ID
- Paseo workspace ID
- Filesystem path plus workspace identity
- Electron browser instance ID
- GADE whiteboard document ID
- GADE board document ID

### 4.3 Workspace

A workspace is a durable GADE identity mapped to a concrete checkout.

```ts
type Workspace = {
  id: string;
  paseoWorkspaceId?: string;
  projectId: string;
  workItemId: string | null;

  cwd: string;
  worktreeRoot?: string | null;
  mainRepoRoot?: string | null;

  baseRef?: string | null;
  baseRevision?: string | null;
  branch?: string | null;

  name: string;
  role?: "integrator" | "review" | "fix" | "exploration" | string;
  createdAt: string;
};
```

#### Workspace identity rule

A branch is **not** workspace identity:

- Branches can be renamed or switched.
- Two worktrees can temporarily point at the same branch.
- A checkout can be detached.
- Paseo already uses opaque workspace IDs and stores branch as mutable metadata.

The workspace is the checkout/worktree instance. Its base reference determines the intended comparison lineage, while `branch` reports the current head branch.

#### Workspace membership rule

Membership is explicit through `node.workspaceId`; it is not inferred from an edge or branch name.

Typical membership:

- Agent, terminal, diff and edited-file nodes: workspace-bound and also assigned to a logical work item.
- GitHub issue browser: project-scoped; assigning it to a work item makes it the logical root.
- PR browser: normally assigned to the work item and optionally to the workspace that produced it.
- Whiteboard and board, if added: project-scoped or work-item-scoped, and only workspace-bound when that relationship is useful.

A work item may own several workspaces. Workspace badges/details communicate branch, cwd, role, lifecycle, and diff base without forcing the user to arrange separate workspace groups manually.

### 4.4 Project

A project represents the repository/product context independently of an individual checkout.

```ts
type Project = {
  id: string;
  paseoProjectId?: string;
  projectKey?: string;
  rootPath?: string;
  gitRemote?: string;
  name: string;
  canvasId: string;
};
```

This lets an issue browser be associated with a repository before any worktree exists.

#### Project navigation hypothesis

The leading design is an expandable global sidebar for switching projects, with one persisted canvas per project. This keeps repository navigation stable and lets the canvas organize logical work rather than repository boundaries.

The competing design—one global canvas with projects as colored groups—must remain a lightweight prototype view over the same records until the navigation test resolves it. Do not build separate persistence models for the two views.

### 4.5 Logical work item

A work item is the automatic organizational unit for an issue, request, investigation, or ad-hoc objective.

```ts
type WorkItem = {
  id: string;
  projectId: string;
  title: string;
  kind: "github_issue" | "task" | "investigation" | "ad_hoc";
  sourceUrl?: string;
  sourceIdentifier?: string;
  status: "active" | "blocked" | "review" | "done" | "archived";
  rootNodeId?: string;
  createdAt: string;
};
```

Membership is explicit through `node.workItemId`, but assignment is automatic:

- A node spawned from a work-item node inherits its `projectId` and `workItemId`.
- A newly created implementation/review/fix workspace is assigned to the same work item.
- Subagents inherit the parent agent's work item.
- A user may reassign membership, but normal workflows should not require manual grouping.

The canvas draws a background hull or auto-sized group around all visible nodes sharing a work item. Moving a node does not silently change membership. Completed operational stages may collapse automatically while remaining inspectable.

### 4.6 Connections

```ts
type CanvasEdge = {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  relation: "spawned" | "delegated" | "references" | "derived";
  label?: string;
  createdAt: string;
};
```

Relations:

- `spawned`: the source node initiated creation of the target.
- `delegated`: a parent agent created or owns a subagent.
- `references`: the target was given the source as relevant context.
- `derived`: the target artifact/result was produced from the source.

Edges are provenance and context. They do not schedule, trigger, or stream live data.

## 5. Entity architecture

### 5.1 Avoid a universal CRUD contract

The tentative `spawn / read / write / partial_read / render` contract is too generic:

- Writing to a terminal, file, conversation, browser, diff, and whiteboard has unrelated semantics and risk.
- `partial_read` is better represented as a projection, selection, range, or page on an inspect query.
- Rendering is a GADE UI responsibility, not a resource operation.
- Resource creation may be synchronous, asynchronous, or may attach to an existing resource.

Use a small generic lifecycle plus typed entity capabilities.

### 5.2 Entity definition

```ts
type EntityDefinition<Config, Resource, Snapshot, Context> = {
  type: string;
  version: number;
  displayName: string;
  icon: string;

  configSchema: Schema<Config>;

  create(input: {
    config: Config;
    workspace: Workspace | null;
    sourceNode?: CanvasNode;
  }): Promise<{ resourceRef: ResourceRef | null }>;

  inspect(input: {
    node: CanvasNode;
    resource: Resource | null;
    projection: "summary" | "context" | "detail";
    cursor?: string;
    selection?: unknown;
  }): Promise<Snapshot>;

  actions: Record<string, EntityAction>;

  toAgentContext(input: {
    node: CanvasNode;
    snapshot: Snapshot;
    budget: ContextBudget;
  }): Promise<Context>;

  Renderer: React.ComponentType<EntityRendererProps>;

  dispose?(resource: Resource): Promise<void>;
};
```

### 5.3 Generic canvas commands

These operations apply to every entity:

1. `createNode(type, config, placement)`
2. `spawnConnectedNode(sourceNodeId, type, config, relation)`
3. `connectNodes(fromNodeId, toNodeId, relation)`
4. `moveNode(nodeId, position)`
5. `resizeNode(nodeId, size)`
6. `setNodeWorkspace(nodeId, workspaceId | null)`
7. `collapseNode(nodeId)` / `expandNode(nodeId)`
8. `archiveNode(nodeId)` / `removeNode(nodeId)`
9. `focusNode(nodeId)` / `fitNodes(nodeIds)`

Resource-specific operations remain typed actions exposed by the entity definition.

### 5.4 Examples of entity-specific actions

| Entity | Owner | Example actions | Context projection |
| --- | --- | --- | --- |
| Terminal | Paseo PTY | create, send input, resize, capture, stop | cwd, command, state, bounded output tail |
| Agent | Paseo session | prompt, interrupt, resume, archive | status, objective, selected messages, latest result |
| Diff | Workspace Git resource | refresh, stage/unstage if added, commit, push, open PR, open file | base/head, totals, selected changed files |
| Browser | Electron guest | navigate, back/forward, reload, open external, extract selected page data | URL, title, explicit page extract |
| File editor | Filesystem + LSP | read range, save, format, definition, references, open in IDE | path, revision, selected range/summary |
| Whiteboard | GADE/tldraw document | create shapes, update, export image/SVG, clear selection | document summary, selected text/shapes/export |
| Board, later | GADE board document | create/update/move cards, assign links | visible cards, selected card detail |

### 5.5 Extensibility boundary

Entity types are registered through an entity registry. The first implementation may be compile-time registration; do not design a third-party plugin loader before the built-in entity contracts stabilize.

Each entity owns:

- Config schema and schema migrations
- Resource adapter
- Supported actions
- Inspect projections
- Agent context projection
- Body renderer
- Resource lifecycle hooks

GADE owns:

- Node identity and persistence
- Generic node chrome
- Canvas position/size/collapse
- Workspace membership
- Connections
- Minimap representation
- Common menus and navigation
- Capability invocation and audit UI

## 6. Generic node container

Every node uses the same outer container.

### Container-owned behavior

- Title, icon and short description
- Logical work-item color and workspace identity/role badge
- Runtime status and reconnect/error state
- Dedicated drag handle
- Resize, collapse, focus and archive controls
- `Spawn connected…` menu
- `Connect existing…` mode
- Incoming/outgoing provenance controls
- Open externally where supported
- Minimap color, icon and label
- Context-sharing indicator

### Renderer-owned behavior

The entity renderer owns only the node body and entity-specific toolbar/actions.

### Interaction rule

Dragging starts only from node chrome. Editor selection, terminal input, browser interaction, scrolling, whiteboard gestures and links must not drag the node or pan the outer canvas.

Heavy interactive renderers should support:

- Inactive preview mode
- Explicit activation/focus
- Escape or chrome click to return control to the outer canvas
- Lazy mount near readable zoom or when focused
- Disposal/unmount without losing the durable resource

## 7. Required initial entities

### 7.1 Agent conversation

- Uses Paseo normalized events rather than scraping terminal ANSI.
- Renders Markdown, code, Mermaid, tool calls, file reads, edits, shell commands, permission prompts and results.
- Tool calls and file reads use expandable panes similar to Paseo.
- Supports prompts, interrupt/resume, model/mode display and attention state.
- Can spawn connected nodes from conversation content or generic node chrome.
- Can attach selected connected nodes as context.

#### Conversation expansion preferences

Conversation panels use configurable default expansion by event/content type, with global defaults and an optional per-conversation override.

```ts
type ConversationExpansionPreferences = {
  toolCall: boolean;
  diff: boolean;
  html: boolean;
  thinking: boolean;
  read: boolean;
};

const defaultConversationExpansion = {
  toolCall: true,
  diff: true,
  html: true,
  thinking: true,
  read: false,
};
```

The same preference controls initial expansion only; users can always toggle individual panels without changing the default.

#### Subagents

- Managed subagents appear as collapsed connected conversation nodes with `delegated` edges.
- Expanding follows or centers the linked node.
- The parent/subagent structure is a view over normal canvas nodes and edges, not a second graph model.
- Provider-native subagents that are not independently resumable may need a lighter virtual node. Prototype Paseo identity/event behavior before fixing this model.

### 7.2 Terminal

- Real xterm.js terminal attached to Paseo terminal streaming.
- Workspace-scoped by default.
- Supports create, attach/reconnect, input, resize, capture and stop.
- Exposes only a bounded terminal tail to agent context unless explicitly expanded.

### 7.3 Diff / Changes explorer

- Workspace-bound view over Git state; the node does not own the Git state.
- Folder/file tree with aggregated `+` and `-` counts.
- File diff preview and navigation into file editor nodes.
- Shows base reference, branch/head, dirty state, current PR and checks.
- Primary workspace actions: commit, push, open PR, open existing PR, merge when appropriate.
- Can spawn browser nodes for related issue/PR/check URLs.
- Multiple diff views may later point to the same workspace; start with one canonical diff node per workspace.

### 7.4 Browser

Browser sources:

1. Normal remote pages such as GitHub issues and PRs.
2. Local application/dev-server pages.
3. GADE/agent-generated artifacts.

Default behavior when created for a GitHub project:

- Open the repository Issues page.
- Diff/PR surfaces can open a connected browser at the relevant issue or PR.

Remote pages and generated artifacts are different trust/rendering modes and should not share the same privilege model.

#### Browser rendering architecture to prototype

- A normal iframe cannot render many GitHub/remote pages because of `X-Frame-Options` and CSP.
- Electron `WebContentsView` is a native window child with window-relative bounds and cannot naturally participate in arbitrary React Flow transforms, clipping and stacking.
- Paseo currently uses Electron guest `<webview>` elements. GADE should prototype a guest webview inside a transformed React Flow node before choosing it.
- Electron officially warns that `<webview>` has stability risks around rendering, navigation, and event routing and recommends alternatives where possible. Its use here is therefore a product-specific experiment, not a settled default.
- If guest webviews prove unreliable, fallback is a selected/expanded browser overlay or separate window synchronized to the chosen node—not one native view per arbitrary transformed node.

The browser prototype must test zoom, pan, clipping, stacking, keyboard focus, scrolling, navigation, popups, downloads, session/profile handling, node reparenting and resource disposal.

### 7.5 File editor

- Monaco editor with syntax highlighting.
- Workspace-relative filesystem identity.
- Save and revision/conflict handling.
- LSP go-to-definition and find-references through a workspace LSP service.
- Markdown preview mode with Mermaid.
- `Open in IDE` action including path, line and column.
- VS Code via `code -g path:line:column` is the first supported external IDE path; keep command templates configurable later.

### 7.6 Whiteboard, deferred

Do not include a whiteboard in the first issue-workflow prototype. If observed workflows demonstrate a need:

- Embed tldraw as an entity inside a React Flow node.
- Keep its camera and gestures local while active.
- Persist the tldraw document, not the live editor instance.
- Allow project or work-item scope; bind it to a workspace only when useful.
- Give agents a textual/shape summary or explicit export instead of automatically attaching the complete scene.
- Production deployment would require a tldraw production license key under its current source-available license.

### 7.7 Task board, later

A Trello-style board is a GADE-owned structured entity:

- Columns and cards
- Card descriptions/status
- Links to issue, agent, workspace, diff and PR nodes
- Agent-readable summary and selected card detail
- Typed actions for card creation/update/move

Do not implement it as arbitrary whiteboard shapes if agents need reliable structured reads/writes.

## 8. Workspace and Git workflow

### 8.1 Recommended creation flow

The reliable ordering is likely:

1. User selects a project from the global sidebar and opens its canvas.
2. User opens an issue in a project-scoped browser node, or creates an ad-hoc objective.
3. `Implement` creates a logical work item and assigns the source node as its root.
4. GADE asks for or infers base branch/ref and workspace mode.
5. GADE asks Paseo to create the first worktree/workspace deterministically.
6. GADE launches the integrator agent inside that workspace/cwd with issue context.
7. Agent and default diff nodes inherit the work item automatically.
8. Reviewers, fixers, and subagents created later inherit the same work item even when they use separate Paseo workspaces.
9. The canvas auto-sizes the logical work background and collapses retired stages; the user does not move nodes back into manual groups.

This is safer and easier to reconcile than asking an unconstrained agent shell to create a worktree and then trying to discover it afterward. The UI may still describe the operation naturally as “agent handles this issue in a new worktree.”

This remains a prototype hypothesis until Paseo's exact workspace/agent API behavior is exercised.

### 8.2 Paseo workflow skill behavior

The current `paseo-issue-to-pr` skill intentionally creates operationally isolated workspaces:

- One issue/integrator worktree
- A separate read-only review worktree for each review round
- One temporary fixer worktree per worthwhile independent resolution chunk

This behavior comes from the skill's safety/review workflow, not a requirement of Paseo itself. Eliminating those workspaces blindly would weaken isolation between the sole writer, reviewers, and fixers.

The ADE-oriented update should organize rather than merely suppress them:

- Propagate one GADE `workItemId` through the whole workflow.
- Record role metadata such as integrator, review round, and fix chunk.
- Link stage agents/workspaces through provenance edges.
- Collapse or hide retired review/fix stages by default.
- Archive temporary Paseo workspaces when the skill's lifecycle permits it.
- Expose branch, cwd, base, status, and diff facts on demand.

A later skill redesign may reduce workspace count where isolation has no value, but the first integration should preserve semantics and remove visual/manual organization cost.

### 8.3 Diff semantics

At creation, retain:

- Selected base ref
- Resolved base revision, if available
- Workspace checkout identity
- Current head branch/ref

The Changes node should clearly state what comparison it is showing. A prototype must decide whether the default comparison tracks the moving base branch, the creation-time base revision, or Git merge-base semantics. Do not hide this in the branch name.

### 8.4 Logical grouping and workspace presentation

The colored background should represent the **logical work item**, not each operational workspace. Work item presentation is derived from membership and should not require manual containment maintenance.

Prototype both:

- An auto-sized React Flow parent/group that grows around member nodes.
- A non-parent visual hull computed from member-node bounds.

Workspace identity remains visible through node badges, a workspace inspector, and optional nested accents. Selecting a workspace badge can highlight every node using that checkout and expose branch, cwd, base ref, dirty state, role, and lifecycle.

The prototype should prefer the visual hull if React Flow parenting makes membership changes or free placement feel like manual group maintenance.

## 9. Context passed to agents

Connections do not automatically inject unlimited content. GADE builds an explicit, bounded context projection.

```ts
type AgentContextReference = {
  node_type: string;
  node_id: string;
  node_name: string;
  short_description?: string;
  relation: "spawned" | "delegated" | "references" | "derived";
  workspace?: {
    id: string;
    cwd: string;
  };
  locator?: {
    kind: string;
    value: string;
  };
  revision?: string;
  excerpt?: string;
};
```

Initial behavior:

- On agent creation or prompt, GADE includes selected connected node references and bounded excerpts in the prompt/attachment payload.
- Full transcripts, complete web pages, entire whiteboards and large diffs are never silently included.
- The UI shows which nodes are being shared.

There is no ACP or GADE-owned MCP integration in v1. If on-demand node access later becomes necessary, it will be designed from observed context-projection limitations rather than prebuilt now.

## 10. ACP and MCP clarification

### ACP

ACP is the **Agent Client Protocol**, a JSON-RPC protocol between an agent client/editor and a coding agent. It standardizes sessions, streaming, modes, permissions and related coding-agent interactions.

For GADE v1, ACP is out of scope. Paseo may use it internally for compatible providers, while GADE consumes Paseo's normalized agent model.

### MCP

MCP is a tool/resource protocol between an agent host and external capability servers.

The harness/provider may support transporting MCP tools, and Paseo can inject MCP server configuration into supported providers. That does **not** automatically define how an agent reads GADE nodes.

MCP is out of scope for v1. Prompt/attachment context projection is sufficient. Revisit a GADE node tool service only after a prototype demonstrates that bounded prompt projections are inadequate.

## 11. Rich agent responses and generated HTML

V1 supports both standard rich blocks and full agent-authored HTML/JavaScript. Security hardening is explicitly deferred for the prototype.

### Standard rich blocks

- Markdown
- Syntax-highlighted code
- Mermaid
- Tables, callouts and structured lists
- File references
- Tool-call/read/edit/shell panes
- Diff blocks
- Links that can open or spawn browser/file nodes

### Custom HTML/JavaScript blocks

Agents may return complete custom HTML/JavaScript answer blocks. Render them in an **unsandboxed iframe or separate document runtime** so scripts execute and CSS/runtime lifecycle does not collide accidentally with the React application. The iframe boundary is for composition and resetability, not a v1 security boundary.

Direct `innerHTML` is insufficient because inserted script elements generally do not execute and unscoped CSS can damage the host UI. A document/iframe runtime also gives each answer a deterministic mount, reload, and disposal lifecycle.

Each artifact revision records:

- Originating agent/turn
- HTML, CSS, JavaScript and optional assets
- Current user interaction/annotation state
- Revision and creation timestamp

### Interactive answer bridge

Inject a small GADE API into each custom answer runtime:

```ts
window.gade = {
  submit(input: { message?: string; data?: unknown }): Promise<void>;
  annotate(input: {
    target?: string;
    text: string;
    data?: unknown;
  }): Promise<void>;
};
```

Initial use cases:

- Rich plans with inline comments and annotations
- Forms or choices whose values become the next user message
- Editable structured recommendations
- A `Submit feedback` action that sends the artifact revision, annotations, and entered data back to the originating agent

User submissions become explicit conversation events/follow-up prompts; custom scripts do not mutate the canonical conversation directly.

### Accepted prototype risk

An unsandboxed, same-origin Electron document is more privileged than opening a generated HTML file in a normal external browser because it may share application origin, state, or exposed preload APIs. Security is not a v1 constraint, but the implementation should record this accepted risk and keep the custom runtime replaceable so isolation can be added later without changing the artifact contract.

## 12. Canvas navigation and scale

Large-canvas navigation is a core feature, not polish.

### Required behavior

- Fit entire canvas
- Fit current workspace/group
- Center/focus a node
- Follow an edge to its source/target
- Back/forward focus history
- Search nodes by title/type/workspace/status
- Keyboard navigation between related nodes
- Breadcrumb or current-focus indicator
- Minimap overview with work-item colors, project context, and node-type icons

### Minimap and level of detail

React Flow's minimap is SVG-only and should show simplified node representations.

At overview zoom:

- Hide heavy node bodies.
- Show title, type, status, work-item color, and compact workspace role when relevant.
- Keep group boundaries and meaningful edges visible.
- Allow minimap click/drag to center quickly.

The exact zoom thresholds must be tuned in a prototype; do not hard-code product semantics around an arbitrary initial value.

### Performance strategy

- Lazy-mount Monaco, tldraw, xterm and browser renderers.
- Preserve external resources when a renderer unmounts.
- Use cheap preview shells when zoomed out.
- Avoid keeping every browser/editor/terminal active on a large canvas.
- Test 100 mixed nodes and a smaller number of simultaneously active heavy nodes.

## 13. Paseo integration boundary

Paseo's current architecture is a good technical fit:

- Node daemon with WebSocket protocol
- Published `@getpaseo/client`
- Agents, workspaces, providers and configuration in the public facade
- Normalized timelines, permissions and tool events
- Worktree, terminal, Git/forge, browser and filesystem operations in lower-level APIs
- Multiple existing clients prove the daemon is not tied to one UI

### Adapter rule

All Paseo access goes through one `GadePaseoAdapter`.

```text
GADE entity adapters
  -> GadePaseoAdapter
       -> public @getpaseo/client where available
       -> isolated low-level protocol/internal client usage where unavoidable
  -> unmodified Paseo daemon
```

Do not spread direct protocol calls through entity renderers.

### Known technical risk

The public Paseo SDK v0.4 facade currently covers agents, workspaces, providers and config. Terminal, Git/forge, browser and filesystem features require lower-level/internal APIs. GADE should isolate these and preferably upstream the missing stable SDK methods.

### Plugin boundary

Paseo's plugin system may be useful for daemon-side GADE RPCs later, but a complete React Flow shell does not fit naturally as a Paseo sidebar plugin. GADE remains a separate frontend.

## 14. GitHub scope

### Initial GitHub functionality

Use Paseo's existing local Git/forge behavior and the user's `gh` authentication for:

- Repository/workspace setup
- Branch/worktree operations
- Changes and diff status
- Commit and push
- PR creation/status/checks/merge operations
- Related issue/PR URLs

This does not initially require a dedicated GADE GitHub App.

### Later GitHub App functionality

Add a GitHub App when GADE needs:

- Organization/repository installation
- Webhooks and background reactions
- Checks API annotations
- Server-side issue/PR automation
- Multi-user hosted authorization

Use Octokit rather than hand-written REST/GraphQL clients.

## 15. Full IDE

Do not embed a full IDE initially.

Provide a generic `Open in IDE` action for:

- Workspace root
- File
- File at line/column

Initial implementation target:

- VS Code desktop with Remote-WSL-compatible paths.

Later configuration can register command templates for Cursor, Zed, WebStorm, OpenVSCode Server, or other editors.

## 16. Desktop shell and browser rendering

### Why `WebContentsView` does not behave like a React Flow node

React Flow pans and zooms its renderer DOM with a CSS transform matrix. Electron `WebContentsView` is not a DOM child: it is a native/main-process child view attached to the application window and controlled through rectangular window-relative `{ x, y, width, height }` bounds.

It can be synchronized approximately by recalculating screen bounds on every pan, zoom, resize, scroll, and node move, but it does not naturally inherit:

- CSS scale/transforms or arbitrary clipping
- Rounded node clipping and DOM masks
- DOM stacking between edges, node chrome, menus, and overlapping nodes
- React layout and unmount order
- Pointer routing from DOM elements drawn above it

A collection of live native child views can therefore occlude canvas UI or drift during transforms unless GADE builds a dedicated overlay compositor.

### Does Tauri solve this?

No. Tauri 2 supports multiple webviews, but they are also window-attached native views with explicit logical `x`, `y`, `width`, and `height`, manipulated using `setPosition` and `setSize`. They do not become arbitrary transformed DOM descendants of React Flow nodes.

Tauri trade-offs:

- Smaller application and Rust capability model
- Uses platform webviews rather than one bundled engine
- Cross-platform differences between WebView2, WKWebView, and WebKitGTK
- Requires the same bounds-synchronization/compositor work for canvas browser nodes
- Adds Rust/native integration work without directly improving Paseo's Node/TypeScript ecosystem fit

Electron trade-offs:

- Larger package/runtime footprint
- Bundled Chromium gives consistent rendering
- Direct Node/native-module fit for Paseo, node-pty, Monaco, and the existing TypeScript stack
- Provides the DOM-like `<webview>` guest element, implemented using an out-of-process iframe, which is much closer to React Flow composition
- Electron officially warns that `<webview>` has stability risks in rendering, navigation, and event routing

### Current recommendation

Keep Electron as the baseline and prototype `<webview>` inside one transformed React Flow node. Tauri does not solve the defining problem, so do not switch shells before this result. If `<webview>` fails, compare bounds-synchronized selected-node overlays in Electron and Tauri only if Tauri's footprint/system-webview trade-off is otherwise valuable.

The exact browser-node implementation remains blocked on this prototype.

## 17. Licensing

### Paseo AGPL-3.0

Paseo is licensed AGPL-3.0. AGPL does not prohibit charging for software or hosting, but it affects source obligations.

Practical models:

1. **Open-source/AGPL-compatible GADE**
   - The simplest licensing alignment when importing Paseo client/protocol code.
   - Paid hosting, support and distribution remain possible.

2. **Paid desktop bundle with Paseo component**
   - Shipping an AGPL-covered daemon requires preserving notices/license and providing corresponding source as required.
   - Whether a proprietary frontend remains legally separate is implementation- and jurisdiction-dependent.

3. **Hosted service using an unmodified separate Paseo daemon**
   - Cleaner than modifying or embedding Paseo.
   - If the daemon is modified and remote users interact with it, AGPL section 13 requires a prominent source offer for the deployed corresponding source.

4. **Proprietary GADE importing `@getpaseo/client` or protocol code**
   - High legal uncertainty and conservative copyleft risk because the frontend bundles/links AGPL-covered code.
   - A process or WebSocket boundary is not automatically a guaranteed legal separation.

### Licensing gate

Before importing Paseo packages into a product intended to remain proprietary, bundling Paseo, or operating a modified hosted daemon:

- Ask Paseo whether a commercial license/exception is available.
- Verify the exact package/version licenses.
- Obtain qualified legal advice on combined-work and source scope.

This document records license facts and risks, not legal advice.

### tldraw

The current tldraw SDK is source-available rather than permissively open source:

- Internal development/testing is allowed.
- Production use is prohibited without a trial, hobby, or commercial license key.
- The license includes technical enforcement and license-compliance usage reporting provisions.
- Current commercial pricing is value-based and requires contacting tldraw; startup discounts and a hobby path are advertised.

Using tldraw in prototypes is permitted, but shipping it is a product-cost and licensing decision. Pin and re-check the exact package license before release.

## 18. Paseo versus Emdash

Current public evidence does **not** establish that Paseo is based on or forked from Emdash.

- GitHub records both canonical repositories as `fork: false` under different organizations.
- Emdash predates Paseo's public repository, but that alone is not provenance evidence.
- No explicit fork/credit acknowledgement was found in the reviewed primary materials.
- Their architectures differ materially.

| Area | Paseo | Emdash |
| --- | --- | --- |
| Core topology | Node daemon + WebSocket protocol + multiple clients | Electron main/preload/React renderer with typed local IPC |
| Clients | Expo mobile/web, Electron desktop, CLI | Desktop-focused Electron app |
| Agent model | Provider adapters, normalized timeline, ACP/native integrations | CLI detection plus provider hooks/runtime integrations |
| Remote | Direct/relay cross-device daemon access | SSH/SFTP remote projects |
| Persistence | Daemon JSON records plus client caches | Local SQLite |
| Extensibility | Published client SDK, protocol, MCP and local plugins | Product architecture and integrations; no equivalent public multi-client SDK established |
| License | AGPL-3.0 | Apache-2.0 |

They are adjacent products solving parallel-agent/worktree UX. Calling Paseo a derivative would require root-history and source-similarity analysis; feature similarity is insufficient.

## 19. Prototypes

### P1 — Project navigation and minimal complete issue workflow

Build the smallest React Flow desktop prototype that exercises organization rather than real agent execution. Use deterministic mock adapters and one shared data model.

Provide two switchable project presentations over the same records:

1. Expandable sidebar: selecting a project opens its dedicated canvas.
2. Global canvas: projects appear as top-level colored groups.

Inside either view, run this complete mocked issue workflow:

1. Open a GitHub issue browser node.
2. Select `Implement` to create a logical work item.
3. Spawn an integrator agent and workspace.
4. Simulate two review-round workspaces and two fixer workspaces, matching the current `paseo-issue-to-pr` shape.
5. Spawn collapsed delegated subagent nodes.
6. Update one diff node with folder/file `+`/`-` statistics.
7. Transition the work item through active → review → done.
8. Create a PR browser node and collapse retired operational stages.

Validate:

- Generic node container and dedicated drag handles
- Automatic `projectId`/`workItemId` inheritance
- Work-item hull/group maintenance with zero routine manual regrouping
- Workspace role/branch/cwd badges without workspace-colored clutter
- Save/reload of layout, edges, focus, and membership
- Minimap, project jump, work-item jump, and focus history
- Configurable conversation expansion defaults

Pass criteria:

- Completing the workflow requires no manual movement into groups.
- All five simulated operational workspaces remain discoverable under one logical issue.
- Switching projects takes one sidebar action and restores project viewport/focus.
- The same records can render in both project-navigation variants.
- A short usability comparison selects sidebar-per-project or global-project-groups before persistence architecture is fixed.
- Any node can spawn a connected node and inherited membership is predictable.

### P2 — Electron browser and custom-answer composition

Embed in React Flow:

- One Electron `<webview>` showing GitHub
- One bounds-synchronized `WebContentsView` overlay as a comparison, only if inexpensive
- Markdown + Mermaid
- One unsandboxed HTML/JavaScript answer with form input and plan annotations

Validate:

- CSS pan/zoom/resize/clipping/stacking for `<webview>`
- Native overlay synchronization and known visual limitations
- Focus, keyboard, wheel, popup, navigation, session, and node-reparent behavior
- Custom answer mount/reload/dispose lifecycle
- `window.gade.submit` and `window.gade.annotate` round-trip into a mock conversation
- Drag only from node chrome

Pass criteria:

- Select the browser composition model or prove that browsers must expand into an overlay/window.
- Determine whether Electron `<webview>` is stable enough despite its official warning.
- Do not build a Tauri version unless Electron fails or application footprint becomes a controlling product requirement; Tauri's native webview has the same bounds model.
- Rich HTML can collect user feedback and create a deterministic follow-up message.

### P3 — Real Paseo issue-to-PR bridge

On one local Git repository:

1. Select the project from the sidebar and open Issues in a browser node.
2. Create one work item from an issue.
3. Create/attach the integrator Paseo worktree and agent.
4. Show normalized conversation events and configured panel expansion.
5. Reconcile additional review/fix workspaces into the same work item, using either a reduced test workflow or one bounded real workflow run.
6. Create one subagent and reconcile it into a collapsed delegated node.
7. Update diff stats and open a file editor from a changed file.
8. Commit/open PR from the diff node.
9. Open the resulting PR in a connected browser node.
10. Restart GADE/Paseo and verify identity reconciliation.

Pass criteria:

- Every GADE workspace maps to the correct Paseo workspace/cwd and role.
- Many workspaces remain one understandable logical work item.
- Diff state comes from each checkout, not inferred branch naming.
- Reconnect preserves opaque workspace/agent identities.
- Subagents appear once with the correct parent relation.
- All direct Paseo protocol usage remains inside the adapter.
- Findings are recorded for an ADE-aware update to `paseo-issue-to-pr`; do not modify the skill before the observed mapping is understood.

### P4 — Editor/LSP and external IDE handoff

Validate two initial languages in a real worktree:

- Monaco open/save
- Go to definition
- Find references
- Opening result in another file node
- Markdown preview with Mermaid
- External VS Code open at file/line/column
- WSL path handling

## 20. Proposed implementation sequence

1. P1 project-navigation and minimal complete issue-workflow prototype.
2. Select sidebar-per-project versus global project groups, and work-item hull versus parent group.
3. P2 Electron browser/custom-answer composition prototype.
4. Decide browser implementation; consider Tauri only if Electron fails or footprint becomes decisive.
5. P3 real Paseo integration prototype with multiple operational workspaces under one work item.
6. Finalize entity registry and ADE-aware workflow metadata contracts from observed requirements.
7. P4 editor/LSP prototype.
8. Build the first cohesive real issue-to-PR vertical slice.
9. Add task board after node context/action semantics stabilize.
10. Reconsider tldraw only when real workflows demonstrate a whiteboard need.
11. Revisit hosted deployment, GitHub App and execution isolation later.

## 21. Open decisions

1. Must GADE remain proprietary-compatible, or is AGPL-compatible open source acceptable?
2. Can Paseo provide a commercial license for its client/protocol packages?
3. Does P1 confirm sidebar-per-project with one canvas each, or a global canvas with project groups?
4. Does a work-item hull or React Flow parent group avoid manual membership maintenance better?
5. Does Electron `<webview>` survive transformed-node interaction tests, or must browser content use a selected overlay/window?
6. Is a base diff pinned to creation revision or tracked through merge-base with a moving base branch?
7. Does spawning an issue agent always create a new worktree, or offer existing checkout/new worktree choices?
8. Which connected nodes are included automatically as agent context versus requiring explicit selection?
9. How should non-resumable provider-native subagents be represented?
10. What is the acceptable active-node budget for terminal/editor/browser renderers?
11. After P3, which `paseo-issue-to-pr` workspaces remain semantically necessary and what metadata must the skill emit?
12. If whiteboards become useful, is a tldraw production license and its value-based commercial pricing acceptable?

## 22. Principal risks

| Risk | Level | Mitigation |
| --- | --- | --- |
| Paseo AGPL conflicts with proprietary product model | Blocker before product distribution | Commercial license or legal review; keep daemon unmodified and boundary isolated meanwhile |
| Browser cannot behave like a normal transformed React Flow node | High | P2 before architecture commitment; guest webview vs selected overlay |
| Project/workspace/work-item concepts produce manual grouping work | High | P1 compares navigation models and requires automatic inheritance/hulls |
| Branch treated as workspace identity | High | Persist opaque workspace identity, checkout path and base/head metadata separately |
| Paseo internal protocol churn | High | Single adapter; upstream public SDK additions |
| Heavy renderers overwhelm large canvas | High | Activation, LOD, lazy mount, bounded active resources |
| Unsandboxed HTML/JavaScript can mutate app state, interfere with UI, or access exposed desktop capabilities | Accepted for prototype | Keep artifact runtime replaceable and resettable; add isolation only when product hardening begins |
| Resource leaks after node removal/restart | High | Explicit attach/dispose/reconcile lifecycle per entity |
| Context connections silently overload prompts | Medium | Explicit bounded projections and visible context selection |
| Generic entity abstraction hides real semantics | Medium | Typed actions and projections; stabilize through prototypes |
| tldraw production license cost/terms or nested interaction limitations | Deferred | Do not integrate until workflow evidence justifies it |

## 23. Primary references

- Paseo repository: https://github.com/getpaseo/paseo
- Paseo architecture: https://github.com/getpaseo/paseo/blob/main/docs/architecture.md
- Paseo data model: https://github.com/getpaseo/paseo/blob/main/docs/data-model.md
- Paseo plugins: https://github.com/getpaseo/paseo/blob/main/docs/plugins.md
- Paseo license: https://github.com/getpaseo/paseo/blob/main/LICENSE
- Emdash repository: https://github.com/generalaction/emdash
- React Flow sub-flows/groups: https://reactflow.dev/learn/layouting/sub-flows
- React Flow instance/navigation: https://reactflow.dev/api-reference/types/react-flow-instance
- React Flow minimap: https://reactflow.dev/api-reference/components/minimap
- tldraw editor: https://tldraw.dev/docs/editor
- Monaco: https://github.com/microsoft/monaco-editor
- Mermaid configuration: https://mermaid.js.org/config/setup/mermaid/interfaces/MermaidConfig.html
- Electron WebContentsView: https://www.electronjs.org/docs/latest/api/web-contents-view
- Tauri Webview API: https://v2.tauri.app/reference/javascript/api/namespacewebview/
- Electron webview tag warning: https://www.electronjs.org/docs/latest/api/webview-tag
- tldraw license: https://github.com/tldraw/tldraw/blob/main/LICENSE.md
- tldraw pricing: https://tldraw.dev/pricing
- GNU AGPLv3: https://www.gnu.org/licenses/agpl-3.0.en.html
- GNU GPL FAQ: https://www.gnu.org/licenses/gpl-faq.html
