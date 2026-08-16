/* global document */

const themes = {
  graphite: {
    number: "01",
    name: "Graphite Control Room",
    short: "Control Room",
    tagline: "Calm, dense, operational",
  },
  atlas: {
    number: "02",
    name: "Technical Atlas",
    short: "Atlas",
    tagline: "A living map of engineering work",
  },
  studio: {
    number: "03",
    name: "Warm Spatial Studio",
    short: "Studio",
    tagline: "A thoughtful room for ongoing work",
  },
  editorial: {
    number: "04",
    name: "Editorial Workbench",
    short: "Editorial",
    tagline: "Content first, topology on demand",
  },
  instrument: {
    number: "05",
    name: "Instrument Panel",
    short: "Instrument",
    tagline: "Explicit, mechanical, unmistakable",
  },
};

const theme = document.body.dataset.theme || "graphite";
const current = themes[theme];
document.title = `${current.name} — SPADE`;

const themeLinks = Object.entries(themes)
  .map(([key, item]) => `
    <a class="direction-link ${key === theme ? "active" : ""}" href="./${key}.html">
      <span>${item.number}</span><b>${item.short}</b>
    </a>`)
  .join("");

const app = document.querySelector("#app");
app.innerHTML = `
  <div class="shell">
    <aside class="sidebar">
      <div class="brand-row">
        <div class="brand-mark">S</div>
        <div><strong>SPADE</strong><small>spatial agent dev env</small></div>
      </div>

      <div class="side-label">PROJECTS</div>
      <nav class="projects">
        <button class="project active"><i class="project-dot"></i><span><b>SPADE</b><small>12 active resources</small></span><em>⌄</em></button>
        <button class="project"><i></i><span><b>Paseo</b><small>4 active resources</small></span><em>›</em></button>
        <button class="project"><i></i><span><b>Relay</b><small>No active work</small></span><em>›</em></button>
      </nav>

      <div class="project-tree">
        <button class="tree-item active"><span class="tree-icon">⌁</span> Canvas <kbd>12</kbd></button>
        <button class="tree-item"><span class="tree-icon">◫</span> Work items <kbd>3</kbd></button>
        <button class="tree-item"><span class="tree-icon">◇</span> Workspaces <kbd>5</kbd></button>
        <button class="tree-item"><span class="tree-icon">✓</span> Archive</button>
      </div>

      <div class="side-label direction-title">DIRECTIONS</div>
      <nav class="directions">${themeLinks}</nav>

      <div class="profile">
        <div class="avatar">SF</div>
        <span><b>Workspace local</b><small>Paseo connected</small></span>
        <i class="online"></i>
      </div>
    </aside>

    <section class="workspace">
      <header class="topbar">
        <div class="crumbs"><span>SPADE</span><i>/</i><b>Core agent workflow</b><em>ACTIVE</em></div>
        <div class="top-actions">
          <button class="icon-button" aria-label="Search">⌕</button>
          <button class="quiet-button"><span>◎</span> Focus history</button>
          <button class="primary-button">＋ New node</button>
        </div>
      </header>

      <div class="canvas-toolbar">
        <div class="tool-cluster">
          <button class="tool active" title="Select">↖</button>
          <button class="tool" title="Pan">✥</button>
          <button class="tool" title="Connect">⌁</button>
        </div>
        <div class="tool-cluster zoom-cluster">
          <button class="tool" data-zoom="out">−</button>
          <span class="zoom-value">100%</span>
          <button class="tool" data-zoom="in">＋</button>
          <button class="tool fit" data-zoom="fit">⌗</button>
        </div>
      </div>

      <main class="canvas">
        <div class="canvas-surface">
          <div class="coordinates x">04 / IMPLEMENTATION</div>
          <div class="coordinates y">ACTIVE WORK</div>

          <svg class="contours" viewBox="0 0 1200 760" preserveAspectRatio="none" aria-hidden="true">
            <path d="M-40 670 C150 510, 170 760, 390 600 S690 570, 790 690 S1070 650, 1250 520" />
            <path d="M-80 710 C160 535, 220 805, 430 630 S720 610, 830 725 S1090 680, 1280 565" />
            <path d="M730 -20 C660 90, 810 140, 745 245 S690 405, 850 445 S1120 390, 1210 475" />
          </svg>

          <div class="work-hull">
            <div class="hull-label">
              <span class="work-index">WORK 04</span>
              <b>Issue #4 · Entity registry & core commands</b>
              <small>5 nodes · 2 workspaces</small>
            </div>
          </div>

          <svg class="edges" viewBox="0 0 1200 760" preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker>
            </defs>
            <path class="edge active" d="M278 257 C340 257, 340 285, 397 285" marker-end="url(#arrow)" />
            <path class="edge" d="M651 274 C718 249, 741 194, 815 192" marker-end="url(#arrow)" />
            <path class="edge active" d="M526 400 C526 438, 482 445, 482 482" marker-end="url(#arrow)" />
            <path class="edge" d="M654 357 C754 391, 785 502, 866 519" marker-end="url(#arrow)" />
            <g class="edge-label"><rect x="323" y="246" width="70" height="22" rx="5"/><text x="358" y="261">SPAWNED</text></g>
            <g class="edge-label"><rect x="691" y="213" width="81" height="22" rx="5"/><text x="731" y="228">DELEGATED</text></g>
            <g class="edge-label"><rect x="493" y="433" width="67" height="22" rx="5"/><text x="526" y="448">DERIVED</text></g>
          </svg>

          <article class="node issue-node" tabindex="0">
            <div class="node-header drag-handle">
              <div class="entity-icon issue-icon">◉</div>
              <div class="node-title"><small>GITHUB ISSUE</small><b>#4 Entity registry & core commands</b></div>
              <button class="node-menu">•••</button>
            </div>
            <div class="node-body issue-body">
              <div class="issue-meta"><span class="status-pill open">OPEN</span><span>skflowne/spade</span><span>4 comments</span></div>
              <p>Introduce the versioned entity registry and generic canvas command layer that all resources share.</p>
              <div class="labels"><span>foundation</span><span>architecture</span></div>
            </div>
            <div class="node-footer"><span>Updated 12m ago</span><button>Open issue ↗</button></div>
          </article>

          <article class="node agent-node selected" tabindex="0">
            <div class="node-header drag-handle">
              <div class="entity-icon agent-icon">✦</div>
              <div class="node-title"><small>INTEGRATOR AGENT</small><b>Implement entity registry</b></div>
              <span class="live-dot"></span>
              <button class="node-menu">•••</button>
            </div>
            <div class="node-context">
              <span class="workspace-badge">◇ integrator</span><span>issue/4-entity-registry</span><span class="model">Claude Sonnet 4</span>
            </div>
            <div class="conversation">
              <div class="message user-message"><span>YOU</span><p>Implement this issue following the repository conventions. Keep the registry typed and version-aware.</p></div>
              <div class="message agent-message"><span>AGENT</span><p>I’ll first map the current persistence and command boundaries, then add the smallest typed registry that fits them.</p></div>
              <div class="tool-call"><span class="chevron">⌄</span><b>Explored repository architecture</b><em>8 files</em></div>
              <div class="message agent-message latest"><span>AGENT</span><p>The registry and migrations are in place. I’m validating node creation and inherited work-item membership now.</p></div>
            </div>
            <div class="composer"><span>Message agent…</span><button>↑</button></div>
          </article>

          <article class="node subagent-node collapsed-node" tabindex="0">
            <div class="node-header drag-handle">
              <div class="entity-icon review-icon">⌁</div>
              <div class="node-title"><small>REVIEW SUBAGENT</small><b>Architecture review</b></div>
              <span class="status-pill done">DONE</span>
              <button class="node-menu">•••</button>
            </div>
            <div class="collapsed-summary"><div class="avatar mini">AR</div><p><b>2 findings</b><span>Registry version migration needs one boundary check.</span></p><button>Expand ↓</button></div>
          </article>

          <article class="node diff-node" tabindex="0">
            <div class="node-header drag-handle">
              <div class="entity-icon diff-icon">±</div>
              <div class="node-title"><small>CHANGES · INTEGRATOR</small><b>Working tree</b></div>
              <div class="diff-total"><ins>+214</ins><del>−18</del></div>
              <button class="node-menu">•••</button>
            </div>
            <div class="node-context"><span class="workspace-badge">◇ integrator</span><span>6 files changed</span></div>
            <div class="file-list">
              <div class="folder"><b>⌄ src</b><span><ins>+172</ins><del>−12</del></span></div>
              <div class="file active"><span>│&nbsp; registry.ts</span><span><ins>+88</ins><del>−3</del></span></div>
              <div class="file"><span>│&nbsp; commands.ts</span><span><ins>+61</ins><del>−7</del></span></div>
              <div class="file"><span>│&nbsp; migrations.ts</span><span><ins>+23</ins><del>−2</del></span></div>
              <div class="folder"><b>› tests</b><span><ins>+42</ins><del>−6</del></span></div>
            </div>
            <div class="diff-actions"><button>Review changes</button><button class="commit">Commit…</button></div>
          </article>

          <article class="node pr-node" tabindex="0">
            <div class="node-header drag-handle">
              <div class="entity-icon pr-icon">↗</div>
              <div class="node-title"><small>PULL REQUEST</small><b>#5 Core entity registry</b></div>
              <button class="node-menu">•••</button>
            </div>
            <div class="pr-state"><span class="status-pill draft">DRAFT</span><p><b>3 / 4 checks passing</b><small>Review workflow is still running</small></p></div>
            <div class="check-row"><span>Typecheck</span><b class="check">✓</b></div>
            <div class="check-row"><span>Unit tests</span><b class="check">✓</b></div>
            <div class="check-row"><span>Review council</span><b class="pending">◷</b></div>
          </article>

          <div class="minimap">
            <div class="mini-hull"></div>
            <i class="mn m1"></i><i class="mn m2 active"></i><i class="mn m3"></i><i class="mn m4"></i><i class="mn m5"></i>
            <div class="viewport-box"></div>
            <span>OVERVIEW</span>
          </div>

          <div class="canvas-status"><span class="pulse"></span> Paseo connected <i></i> 5 resources live <i></i> Saved just now</div>
        </div>
      </main>

      <div class="direction-caption">
        <span>${current.number}</span>
        <div><small>DESIGN DIRECTION</small><b>${current.name}</b><p>${current.tagline}</p></div>
      </div>
    </section>
  </div>
`;

let zoom = 100;
const surface = document.querySelector(".canvas-surface");
const zoomValue = document.querySelector(".zoom-value");

document.querySelectorAll("[data-zoom]").forEach((button) => {
  button.addEventListener("click", () => {
    const action = button.dataset.zoom;
    zoom = action === "fit" ? 100 : Math.max(70, Math.min(125, zoom + (action === "in" ? 10 : -10)));
    zoomValue.textContent = `${zoom}%`;
    surface.style.setProperty("--demo-zoom", zoom / 100);
  });
});

document.querySelectorAll(".node").forEach((node) => {
  node.addEventListener("click", () => {
    document.querySelectorAll(".node").forEach((item) => item.classList.remove("selected"));
    node.classList.add("selected");
  });
});
