---
name: tk-worker
description: Worker skill for implementing tk tickets. Follows the tk-worker extension workflow.
---

# TK Worker

Execution mode for the `tk` ticket system. Work one epic at a time using the `tk-worker` extension.

## TK Conventions

- Run `tk help` when command syntax is unclear.
- List open/in-progress epics with: `tk ready -T epic`.
- Read an epic/ticket with: `tk show <id>`.

## Starting an Epic

When explicitly asked to start an epic:

1. Select the matching epic; ask if ambiguous.
2. Mark the epic `in_progress` with `by_worker` tag (the `/tk-worker` command handles this).
3. The extension creates a branch and hands off to you.

## Worker Modes

The `tk-worker` extension sets one persistent mode tag on the epic:

- `yolo` — work the whole epic at once. New epics created by `/tk-worker` are yolo by default.
- `focused` — work one ready child ticket at a time from `tk ready -T epic-<epic-id>`. The same epic branch stays open until all child tickets are closed.

Mode tags are never removed, even after the epic is closed.

## Workflow

The `tk-worker` extension manages the pair-program workflow:

1. **Agent work phase** — You implement the assigned scope. In focused mode, work only the selected child ticket. Edit source files, run tests, etc.
2. When done, call `tk_worker_agent_done` with a concise summary.
3. The extension commits your work and hands off to human review.
4. **Human review phase** — The human reviews, edits code, and runs `/tk-worker`.
5. If updates are needed, the extension commits human changes and hands back to you.
6. If approved, the extension asks you to generate a final commit message and call `tk_worker_finalize`.
7. In yolo mode, the extension squashes commits, merges to main, and closes the epic.
8. In focused mode, finalization closes the active child ticket. If more child tickets remain, the epic branch stays open and `/tk-worker` selects the next ready child. When all children are closed, the extension closes the epic, squashes, and merges to main.

## Implementation

Follow the epic ticket, project instructions, and concrete worker skills:

- UI work → `tk-worker-web-ui`
- Other task-specific skills may be added later

## Finalizing

Only after explicit final approval:

1. Call `tk_worker_finalize` with a good commit message.
2. The extension handles squash, merge, and closing the epic.
