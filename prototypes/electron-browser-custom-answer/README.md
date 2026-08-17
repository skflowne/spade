# Electron browser and custom-answer composition prototype

This directory is an isolated P2 experiment. It is not part of SPADE's normal Electron entries or `npm run build`.

```bash
npm run prototype:p2
```

The prototype treats generated HTML as trusted. Its unsandboxed same-origin `srcdoc` can access the parent document and any APIs exposed by the prototype preload. Message-source and runtime checks protect deterministic lifecycle handling; they are not a security boundary.

## Direct validation record

### M1 — rich-answer composition

Environment: Electron 43 under Xvfb, attached through Chrome DevTools for direct interaction.

| Check | Observation | Result |
|---|---|---|
| Dedicated entry | `npm run prototype:p2:build` selected the prototype config and emitted its own main, preload, and renderer entries. Root `npm run build` remains unchanged. | Pass |
| Markdown | The Markdown source rendered as a heading, emphasized text, and a list. | Pass |
| Mermaid | The flowchart rendered one SVG (`.mermaid-output svg`). | Pass |
| `window.spade.submit` | Submitting “Use the guest webview for transformed nodes” appended one `SUBMIT` event from runtime 1 to the mock conversation. | Pass |
| `window.spade.annotate` | Annotating `browser-step` appended one `ANNOTATE` event with the target and text from runtime 1. | Pass |
| Reload lifecycle | Reload replaced runtime 1 with runtime 2 and updated the visible lifecycle status. | Pass |
| Dispose/mount lifecycle | Dispose removed the iframe and showed the disposed surface; Mount created one iframe again. | Pass |
| Body drag boundary | Dragging `.markdown-output` left the rich node at `translate(100px, 80px)`. | Pass |
| Chrome drag boundary | Dragging `.prototype-node__chrome` moved the rich node to `translate(-217.692px, 690.909px)`. | Pass |

Artifact: [`artifacts/m1-rich-answer.png`](artifacts/m1-rich-answer.png)

Browser-composition checks are pending M2.
