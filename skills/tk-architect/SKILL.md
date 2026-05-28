---
name: tk-architect
description: Architect skill for planning tk epics. Uses the tk-architect extension for the planning workflow.
---

# TK Architect

Planning mode for the `tk` ticket system. Build architecture in one session using the `tk-architect` extension.

## TK Conventions

- Run `tk help` when command syntax is unclear.
- List epics with: `tk ls --status=in_progress -T by_architect`.
- Read an epic/ticket with: `tk show <id>`.

## Guarded Command Rules

During `agent_work`, bash is intentionally restricted. Allowed bash commands are:

- Any command starting with `tk `
- Read-only git: `git status`, `git log`, `git show`, `git diff`, `git ls-files`
- Read-only exploration: `pwd`, `ls`, `rg`, `grep`, `find`

Important: the guard blocks shell metacharacters anywhere in the command string, even inside quotes: `;`, `&`, `|`, backticks, `$`, `<`, `>`.

Examples that will be blocked:

- `tk query '.[] | select(.parent=="epic-id")'` — blocked because of `|` inside the quoted query
- `find . -name '*.test.ts' -print | head -80` — blocked because of the pipe and because `head` is not allowed

Avoid pipes and command substitutions. Run a single allowed command directly, then inspect the returned output.

## Starting an Architecture Session

When explicitly asked to plan an epic:

1. Run `/tk-architect <title>` to create the epic.
2. The extension creates the epic ticket (`in_progress`, `by_architect`, `agent_work`, `architect_planning`), creates a branch, and hands off to you.

## Workflow

The `tk-architect` extension manages the pair-program workflow:

1. **Agent work phase** — You plan the architecture. You may:
   - Edit any `.tickets/*.md` file
   - Run `tk` commands: `tk create`, `tk dep`, `tk status`, `tk show`, etc.
   - Do NOT edit implementation source files outside `.tickets/`
2. When the architecture is complete, call `tk_architect_agent_done` with a summary.
3. The extension commits your work and hands off to human review.
4. **Human review phase** — The human reviews the tickets and runs `/tk-architect`.
5. If updates are needed, the extension commits changes and hands back to you.
6. If approved, the extension asks you to generate a final commit message and call `tk_architect_finalize`.
7. The extension squashes commits, merges to main, sets the epic `open`, and removes planning tags. The epic is now available for workers.

## What to Plan

In one session, you should:

1. Fill out the epic markdown file with: Problem/Goal, Scope, Non-Goals, Child Ticket Plan, Dependency Plan, Open Questions
2. Create child tickets using `tk create <title> --parent <epic-id> --tags epic-<epic-id>`
3. Add dependencies between tickets using `tk dep <id> <depends-on-id>`
4. Fill out child ticket markdowns with: Research, Design, Acceptance Criteria, Notes/Risks

## Finalizing

Only after explicit final approval:

1. Call `tk_architect_finalize` with a good commit message.
2. The extension handles squash, merge, and opening the epic for workers.
