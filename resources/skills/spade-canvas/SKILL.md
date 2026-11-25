---
name: spade-canvas
description: Read the SPADE canvas (nodes, trees, references) with the `spade` CLI, and change it when the user asks. Use when running inside SPADE and you need to see how the work is mapped, or the user asked you to record, reorganize, or spawn something on the canvas.
---

# SPADE canvas

SPADE shows the work as a **mind map on a canvas**: nodes (agents, notes, images, web pages) arranged in
**trees** by parent-child edges, plus **references** edges between any two nodes. It is a map of the work,
not an execution engine: edges carry no data and trigger nothing.

Paseo manages agents; SPADE is a view on top. You are a Paseo agent, and SPADE knows you by
`PASEO_AGENT_ID`, which Paseo sets for you. You may have a node of your own on the canvas, or, if another
agent started you, be **collapsed** into your owner's node, which lists you with your status. Run the CLI
through the launcher path SPADE gave you (written `spade` below). Every change is **attributed to you**,
shown to the user, and reviewable. Graph commands only touch SPADE's records, **never files**: removing a
node never deletes project content.

## Read

```sh
spade whoami                      # your Paseo agent, its owner, your node (when expanded), project, children
spade tree                        # indented trees: id · type · title [flags] (+N below) ← you
spade tree --root <node> --depth 2
spade node <node>                 # state, parent, children, references, bounded excerpt, agent status
spade nodes --type note           # paged list
spade edges --node <node>
spade activity --limit 10         # who changed what, newest first
spade entities                    # node types and their config fields
spade providers                   # agent providers, models, modes
spade projects
```

Reads are bounded and paged: follow `--cursor <c>` from the "next page" hint. They never return full
transcripts, pages, or files; read those with your own tools. Reads default to your own project; pass
`--project <id|name>` for another.

## Change only when the user asks

**Do not create canvas nodes on your own.** Spawn a node only when the user asks for one, in your
instructions or in the conversation (for example by asking you to record findings on the canvas). Otherwise
answer in your conversation: SPADE renders it richly, and the user can turn paths, images, and links in it
into nodes themselves.

When the user asks for a node and names no target, it becomes **your child**, or, while you are collapsed,
a child of your **nearest expanded owner's** node; it is still attributed to you. You may name another
target: `--parent` any node, `--tree <node>` (child of that tree's root), or `--new-tree`.

```sh
spade spawn note --title "Findings" --body "Root cause: …"            # child of you
spade spawn note --parent <node> --title "Detail" --body "…"            # continue a branch
spade spawn webpage --url https://example.com/docs --title "API docs"
spade spawn image --path shots/before.png --caption "Before the fix"   # or --asset <id>
spade spawn note --new-tree --title "Open questions" --body "…"
spade spawn <type> --config '<json>'                                    # any registered type
spade reparent <node> <new-parent>        # moves the whole branch; cycles are rejected
spade reparent <node> --root              # make it a root
spade rename <node> New title
spade describe <node> One-line summary    # or --clear
spade edit <node> --body "New text"       # or --config '<json>'; replaces the config
spade connect <from> <to> --label "uses"  # references edge; never changes the tree
spade disconnect <edge>
spade move <node> <x> <y>
spade resize <node> <width> <height>
spade collapse <node> [--branch]          # --branch hides descendants
spade expand <node> [--branch]
spade archive <node> [--branch]
spade restore <node> [--branch]
spade remove <node> [--branch]            # without --branch, children move up to its parent
```

The viewport belongs to the user: there is no viewport or focus command.

## Agents

`spade spawn agent` starts a **Paseo agent owned by you**, exactly as Paseo's own tools do when you create
an agent with them: it is not a node. It appears, collapsed, in your list, where the user follows it and can
expand it. It prints the new agent's Paseo id. Start one only when the work needs a separate agent.

```sh
spade spawn agent --prompt "Review the diff in src/" --provider claude --title "Reviewer"
spade spawn agent --prompt "…" --provider codex --model gpt-5 --mode auto
```

Name the provider (and model, if it matters) yourself; `spade providers` lists them. Without `--provider`
the user's saved default provider and its model apply, and nothing else is filled in: an unset `--mode` is
left to Paseo. An agent takes no `--parent`, `--tree`, `--new-tree`, `--description`, or `--project`.

**Message other agents with Paseo's own tools**, not through SPADE; the agents you start are reachable there
by the id `spade spawn agent` printed.

**Pass arbitrary text through stdin.** Any free-text value (the text of `rename` and `describe`; `--body`,
`--prompt`, `--title`, `--description`, `--caption`, `--config`, `--label`) can be a single `-`, which reads
that value from stdin (one per command; a final line break is dropped). Shells, and above all `cmd.exe` on
Windows, re-read quotes, `&`, `|`, `>`, `$`, and `%VAR%` in arguments; stdin is passed as is:

```sh
spade spawn note --title "Findings" --body - <<'EOF'
Text with "quotes", & | > $HOME %PATH%, and several lines.
EOF
spade spawn note --title "Findings" --body - < findings.md
```

## Failure

A command naming a missing node or edge, an invalid config, or a cycle fails with a code and message on
stderr (`spade: unknown-node: Unknown node: …`) and a non-zero exit; nothing falls back silently. Exit 2
means wrong usage (`spade <command> --help`). If SPADE is not running, say so and continue without the
canvas. Add `--json` to any command for exact structured output.

You always act as yourself. If a command fails with `identity-required` (your agent identity is missing) or
`unknown-agent` (SPADE shows neither you nor an agent that owns you), stop using the canvas and tell the
user; do not try to work around it.

## Rich answers

Your messages render as Markdown in your conversation node. Beyond plain Markdown:

- **Paths, images, and links are actionable.** Write file and folder paths (absolute, or relative to the
  project root, optionally `path:line`) and http(s) URLs plainly or in backticks; the user can reveal them
  in Explorer, or open an image or page as a node in a tree. Put paths that contain spaces in backticks.
  `![alt](path-or-url)` shows an inline thumbnail.
- **Diagrams:** a fenced block with the info string `mermaid` renders as a diagram.
- **Live HTML answers:** a fenced block whose info string starts with `spade-html` (any following words
  become its title) is rendered as a live document, scripts included. Give a complete HTML document. Use
  it for forms, choices, and plans the user annotates, not for ordinary prose.

  ````
  ```spade-html Plan review
  <!doctype html>
  <button onclick="window.spade.submit({ message: 'Approved', data: { step: 2 } })">Approve</button>
  ```
  ````

  Inside it, `window.spade.submit({ message?, data? })` sends the user's input back to you as their next
  message, and `window.spade.annotate({ target?, text, data? })` attaches a comment that is sent with the
  next submit. Both return promises. SPADE's `--cr-*` CSS variables are available for styling.
- A plain `html` fence stays a code block the user can choose to render.
