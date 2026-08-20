# Electron browser and custom-answer composition prototype

This directory is an isolated P2 experiment. It is not part of SPADE's normal Electron entries or `npm run build`, and its build output stays under this prototype's ignored `out/` directory.

```bash
npm install
npm run prototype:p2
```

For deterministic integrity checks:

```bash
npm run prototype:p2:typecheck
npm run prototype:p2:build
```

The prototype treats generated HTML as trusted. Its unsandboxed same-origin `srcdoc` can access the parent document and any APIs exposed by the prototype preload. Message-source and runtime checks protect deterministic lifecycle handling; they are not a security boundary.

## Direct validation record

### M1 — rich-answer composition

Environment: Electron 43 under Xvfb, attached through Chrome DevTools for direct interaction.

| Check | Observation | Result |
|---|---|---|
| Dedicated entry | `npm run prototype:p2:build` selected the prototype config and emitted main, preload, and renderer entries under the prototype's own `out/`. Root `npm run build` remains unchanged. | Pass |
| Markdown | The Markdown source rendered as a heading, emphasized text, and a list. | Pass |
| Mermaid | The flowchart rendered one SVG (`.mermaid-output svg`). | Pass |
| `window.spade.submit` | Submitting “Use the guest webview for transformed nodes” appended one `SUBMIT` event from runtime 1 to the mock conversation. | Pass |
| `window.spade.annotate` | Annotating `browser-step` appended one `ANNOTATE` event with the target and text from runtime 1. | Pass |
| Reload lifecycle | Reload replaced runtime 1 with runtime 2 and updated the visible lifecycle status. | Pass |
| Dispose/mount lifecycle | Dispose removed the iframe and showed the disposed surface; Mount created one iframe again. | Pass |
| Malformed bridge input | Iframe-origin messages with annotation `input: {}` or an unknown outer key at the active runtime left the conversation at its empty state. | Pass |
| Stale bridge input | An iframe-origin valid submit tagged with runtime 1 after reload to runtime 2 left the conversation at its empty state. | Pass |
| Body drag boundary | Dragging `.markdown-output` left the rich node at `translate(100px, 80px)`. | Pass |
| Chrome drag boundary | Dragging `.prototype-node__chrome` moved the rich node to `translate(-217.692px, 690.909px)`. | Pass |

Artifact: [`artifacts/m1-rich-answer.png`](artifacts/m1-rich-answer.png)

### M2 — browser composition comparison

Environment: Electron 43 under Xvfb, with host, guest-webview, and native-view targets inspected directly through Chrome DevTools.

| Check | Observation | Result |
|---|---|---|
| GitHub guest | The persistent `<webview>` loaded issue 14 and emitted loading, navigation, DOM-ready, and focus events. | Pass |
| CSS zoom | React Flow changed from scale `0.569286` to `0.683143`; the same live guest remained attached and rendered. | Pass |
| CSS resize | The browser node changed from `600×620` to `1080×620`; the guest filled the resized clipped body. | Pass |
| CSS clipping and stacking | The guest stayed inside the rounded, overflow-hidden node body and the `DOM stacking probe` rendered above its content. | Pass |
| CSS pan/window clipping | Moving the browser chrome to `translate(-328.735px, 1257.71px)` kept the guest attached while the window clipped the transformed node. | Pass |
| Reparent | Reparenting changed the button to `Detach from group` and moved the browser to the group's absolute transform `translate(100px, 110px)`. Dragging beyond the previous boundary expanded the group instead of constraining the browser, while retaining one guest target and session. | Pass |
| Focus and keyboard | The host logged `guest focused`; after focus, a Tab key inside the guest focused GitHub's `Skip to content` link. | Pass |
| Wheel | Guest `scrollY` changed from `0` to `500` without panning the outer canvas. | Pass |
| Popup policy | `window.open` was intercepted in main, denied as a new window, and navigated the same guest from issue 14 to `electron/electron/issues`; only one guest target remained. | Pass |
| Navigation | Back returned the same guest to issue 14 and updated the address field. | Pass |
| Session/remount | The marker `spade-p2-session-marker-v1` survived replacement of guest 1 with guest 2. | Pass |
| Session/restart | The same marker was read after the Electron process and guest were fully restarted with the persistent partition. | Pass |
| Browser drag boundary | Dragging the address form left the node at `translate(40px, 820px)`; dragging chrome moved it to `translate(-328.735px, 1257.71px)`. | Pass |
| Native initial synchronization | The DOM surface reported `549, 603 · 340×296`, and a second GitHub target appeared for the WebContentsView. | Pass |
| Native zoom synchronization | One zoom changed synchronized bounds to `531, 623 · 409×355`. | Pass |
| Native pan synchronization | A deterministic pan changed x from `549` to `389`; rapid alternating pans settled at `709` without drift. | Pass |
| Native resize synchronization | Resizing the node to `320×260` changed the native content rectangle from `340×296` to `181×91`. | Pass |
| Native partial window clipping | At raw bounds `-91, 603 · 340×296`, the native target remained alive, but Electron reported `innerWidth: 249` (`340 - 91`). Even with raw synchronized bounds, the parent window reflows the native page to the visible intersection instead of DOM-style clipping. | Limitation confirmed |
| Native full window clipping | Panning to raw x `1509` fully clipped and disposed the native target; panning it back created one replacement target. | Pass |
| Native IPC guards | A stale sequence-1 hide left the active native target intact; a sequence-999 command with `NaN` bounds was rejected without advancing sequence, after which the normal dispose command still removed the target. | Pass |
| Native disposal | `Dispose native view` removed the native target while leaving the guest target alive. | Pass |
| Native focus and keyboard | The live native target reported `document.hasFocus(): true`; Tab focused GitHub's `Skip to content` link. | Pass |
| Native wheel | Wheel input changed the native document's `scrollY` from `0` to `400`. | Pass |
| Native visual limitations | The native rectangle moved above DOM controls and intercepted later clicks. Host CDP capture omitted native pixels and showed the underlying placeholder, proving it does not participate in DOM capture/stacking. | Limitation confirmed |

Artifacts:

- [`artifacts/m2-webview-composition.png`](artifacts/m2-webview-composition.png) — transformed/reparented guest with DOM stacking probe.
- [`artifacts/m2-native-overlay-host-capture.png`](artifacts/m2-native-overlay-host-capture.png) — host capture while the native view was live; native pixels are absent by design.

## Reproduction checklist

1. Run `npm run prototype:p2` and use React Flow controls plus **Pan left/right** to transform the canvas.
2. Resize both browser nodes from their border handles. Confirm the guest scales/clips with its node and the native status reports changing window bounds.
3. Reparent the guest, drag it beyond the group's previous boundary, and confirm the group expands without detaching or constraining it. Drag browser bodies and chrome, focus each browser, press Tab, and scroll each page.
4. Use **Request popup**, Back, the address field, and Reload. Confirm popup navigation remains in the same guest.
5. Write the session marker, Remount, and read it. Restart Electron and read it again.
6. Show the native view, pan it over DOM controls and across a window edge, then dispose it.
7. Submit and annotate inside the custom answer; reload, dispose, and remount its runtime while observing the mock conversation.

## Conclusion and recommendation

Use Electron `<webview>` for browser content that must behave as an arbitrary React Flow node. In this prototype it remained live through CSS pan, zoom, resize, window clipping, DOM stacking, node reparenting, focus, keyboard, wheel, navigation, popup interception, remount, and process-persistent session checks. This is sufficient to select the guest composition model for the next vertical slice, while retaining Electron's official rendering/navigation/event-routing warning as a reliability risk to monitor.

Do not use one `WebContentsView` per canvas node. Bounds synchronization itself was inexpensive and responsive, but the native child cannot inherit rounded clipping or DOM stacking, can intercept controls drawn above it, disappears from host capture, and reflows at partial window clipping. If guest stability later fails, use one selected/expanded native overlay or a separate window where those limitations are explicit rather than pretending it is a transformed node.

The trusted custom-answer document completed deterministic mount/reload/dispose behavior. Both `window.spade.submit` and `window.spade.annotate` produced validated explicit mock-conversation events; malformed and stale messages were rejected.

## Final validation

| Command | Result |
|---|---|
| `npm run prototype:p2:typecheck` | Pass |
| `npm run prototype:p2:build` | Pass |
| `npm run typecheck` | Pass |
| `npm run lint` | Pass |
| `git diff --check` | Pass |
| `xvfb-run -a npm test` | 6 passed; `docs-compare.spec.ts` failed because this prototype intentionally leaves `docs/plan.html` identical to `origin/main`, while that spec requires both added and removed documentation blocks. |

The docs-comparison failure is unrelated to the prototype runtime: all domain, command, canvas-state, and Electron startup checks passed. Adding artificial canonical-doc changes or weakening the existing assertion would violate this issue's prototype-only scope.

## Residual risks and scope outcome

- Electron still officially warns against `<webview>` stability. This bounded prototype did not run long-duration, crash-recovery, download, authentication-provider, or multi-guest stress tests.
- Generated HTML is intentionally unsandboxed and same-origin. It can reach its parent and prototype preload APIs; message validation is lifecycle correctness, not security isolation.
- `WebContentsView` synchronization uses continuous animation-frame bounds observation only for this comparison and is not a general overlay compositor.
- The prototype uses a persistent local Electron partition. Clear its application data manually when a clean-session run is required.
- No production domain contracts or normal Electron entries changed, no automated coverage was added, and canonical documentation remains unchanged because this prototype records evidence rather than redefining system invariants.
