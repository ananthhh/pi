---
name: tk-worker
description: Use after task-router selects Worker mode. Executes one tk ticket at a time: reads epic/ticket context, starts epics, chooses the next ready ticket, loads the concrete worker skill, verifies, pauses for approval, then closes and commits only after approval.
---

# TK Worker

Use this skill when the user asks to start an epic, work on a ticket, implement planned work, or continue ticket execution.

## Base Rule

Worker mode executes one `tk` ticket at a time. Run `tk help` when command syntax is unclear.

Do not start unrelated tickets. Do not close tickets or commit until the project/user approval gate allows it.

## Starting an Epic

When the user asks to start an epic:

1. List ready/open epics
2. Select the epic matching the user's request; ask if ambiguous.
3. Mark the epic `in_progress`.
4. Create a branch named `epic/<epic-id>-<epic-title>`.
5. Commit the epic-start bookkeeping.

## Working a Ticket

For each ticket:

1. **Get Active Epic** - `tk ready -T epic` and look for epic with 'in_progress' status. Note down the epic-id.
2. **Pick work** — choose the next ready ticket for the current epic `tk ready -T epic-<epic-id>`.
2. **Context** — read the epic and ticket with `tk show` as appropriate.
3. **Identify task type** — choose the most specific concrete worker skill:
   - Task that includes UI work: read `web-ui-worker`
   - More task types will be added in future as the need arises
4. **Implement** — follow the ticket, epic context, project instructions, and concrete worker skill.
5. **Notes** — if discoveries affect future tickets, add note to the epic `tk add-note <epic-id> <note>`. Ask user before doing it
6. **Verify** — run the project-required verification plus any concrete worker checks.
7. **Pause** — Don't commit changes. present verification output and summary for user review.

## After Approval

Only after the user explicitly approves:

1. Close the ticket with `tk status <ticket-id> closed`.
2. Show epic progress with `tk ls -T epic-<epic-id>`.
3. Commit using the project's commit-message convention.
4. Next ticket will be started in new agent thread. Your work is done.

## Reporting Before Approval

Report:

- ticket worked
- concrete worker skill used
- files changed
- verification commands and results
- whether approval is needed before close/commit
