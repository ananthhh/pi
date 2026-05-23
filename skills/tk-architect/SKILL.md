---
name: tk-architect
description: Use after task-router selects Architect mode. Plans requirements using the tk CLI by exploring the codebase, creating an epic, creating independently verifiable child tickets, and setting dependencies.
---

# TK Architect

Use this skill when the user asks to plan/design work or create an epic/tickets. Architect mode plans only; do not implement unless explicitly asked.

## Design Principles

Each child ticket must be independently verifiable before the next is started:

1. It passes the project's typecheck command.
2. It introduces zero regressions; All e2e and unit tests should pass.
3. Old code paths remain intact until an explicit removal ticket.
4. It is self-contained and can be verified without future tickets.

## Workflow

1. **Explore** — understand the current codebase relevant to the requirement.
2. **Design** — draft the solution plan using the design principles above.
3. **Create epic** — create a `tk` epic for the requirement.
4. **Create child tickets** — each ticket must include:
   - `## Research` — codebase exploration findings so workers skip re-exploring
   - `## Design` — the solution plan for this ticket
   - `## Acceptance Criteria` — verifiable completion criteria
5. **Propagate context** — include relevant epic-level context in each child ticket's design.
6. **Set dependencies** — use `tk` dependencies so tickets are worked in the intended order.

## Reporting

Report the epic, child tickets, dependency order, and any assumptions or open questions.
