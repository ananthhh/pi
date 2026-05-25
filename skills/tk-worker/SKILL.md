---
name: tk-worker
description: worker skill. Use only when explicitly invoked using skill command.
---

# TK Worker

Execution mode for the `tk` ticket system. Work one ticket at a time.
If pair-programming is active, use the generic `pair-program` checkpoint/review workflow at each planned checkpoint.

## TK Conventions

- Run `tk help` when command syntax is unclear.
- List open/in-progress epics with: `tk ready -T epic`.
- Get the next ready ticket in an epic with: `tk ready -T epic-<epic-id>`.
- List epic tickets with: `tk ls -T epic-<epic-id>`.
- Read an epic/ticket with: `tk show <id>`.
- Mark epic/ticket state with the project's `tk status` convention.

## Starting an Epic

When explicitly asked to start an epic:

1. Select the matching epic; ask if ambiguous.
2. Mark the epic `in_progress`.
3. Get the next ready ticket and start it

## Starting a Ticket

For each ticket:

1. Read epic and ticket context with `tk show`.
2. Mark the ticket `in_progress`.
3. Identify the concrete worker skill:
   - UI work → `tk-worker-web-ui`
   - Other task-specific skills may be added later

## Implementation

Follow the ticket, epic context, project instructions, and concrete worker skill. The concrete worker skill defines what to build and how to verify it.

## Checkpoints When Pair-Programming

The ticket's `## Planned Checkpoints` section defines where to pause. If none exist, create lightweight ones:

- After the first vertical slice
- After tests pass
- Before finalization

At each checkpoint, return to the active `pair-program` workflow.

## After Final Approval

Only after explicit final approval:

1. Close the ticket: `tk status <ticket-id> closed`.
2. Show epic progress: `tk ls -T epic-<epic-id>`.
3. Continue `Finalize Work` step in pair-program skill if it's active

