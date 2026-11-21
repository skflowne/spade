---
name: spade-canvas
description: Read and change the SPADE canvas (nodes, trees, references) with the `spade` CLI. Use when running inside SPADE and the work calls for recording findings, spawning notes, pages, images, or agents, or reorganizing the map of the work.
---

# SPADE canvas

SPADE shows the work as a **mind map on a canvas**: nodes (agents, notes, images, web pages) arranged in
**trees** by parent-child edges, plus **references** edges between any two nodes. It is a map of the work,
not an execution engine: edges carry no data and trigger nothing.

You appear on the canvas as your own node. Run the CLI through the launcher path SPADE gave you (written
`spade` below). Every change is **attributed to you**, shown to the user, and reviewable. Graph commands only
touch SPADE's records, **never files**: removing a node never deletes project content.

## Read before you change

```sh
spade whoami                      # your node, project, parent, children
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

## Tree continuation

When you name no target, a spawned node becomes **your child**. Continue your own tree: spawn under yourself
to start a new branch, or under a node below you (`--parent <node>`) to continue an existing branch. You
may name any other target when the work calls for it: `--parent` any node, `--tree <node>` (child of that
tree's root), or `--new-tree`.

## Change

```sh
spade spawn note --title "Findings" --body "Root cause: …"            # child of you
spade spawn note --parent <node> --title "Detail" --body "…"            # continue a branch
spade spawn webpage --url https://example.com/docs --title "API docs"
spade spawn image --path shots/before.png --caption "Before the fix"   # or --asset <id>
spade spawn agent --prompt "Review the diff in src/" --title "Reviewer" # provider/model/mode follow yours
spade spawn agent --prompt "…" --provider claude --model opus --mode default
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
spade prompt <agent-node> Please summarize your result
```

Spawning an agent starts a real Paseo agent in the project root as your sub-agent; do it only when the work
needs a separate agent. The viewport belongs to the user: there is no viewport or focus command.

## Failure

A command naming a missing node or edge, an invalid config, or a cycle fails with a code and message on
stderr (`spade: unknown-node: Unknown node: …`) and a non-zero exit; nothing falls back silently. Exit 2
means wrong usage (`spade <command> --help`). If SPADE is not running, say so and continue without the
canvas. Add `--json` to any command for exact structured output.

## Rich answers

(Placeholder: rich answer conventions are added here.)
