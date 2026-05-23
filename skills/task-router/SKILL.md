---
name: task-router
description: Use at the start of a coding-agent request to classify the starting prompt as Architect or Worker, then load the matching role skill. Architect planning uses tk-architect; ticket execution uses tk-worker.
---

# Task Router

This skill only selects the agent role from the user's starting prompt. Do not plan or implement from this skill.

# Ticket System

All planning happens through the `tk` CLI. Run `tk help` when command syntax is unclear.

## TK Conventions

- When creating tickets, set the assignee to the model that created them, e.g. `-a opencode/deepseek-v4-flash-free`.
- Create epics with: `tk create "<title>" --type epic --tags epic`.
- Create child tickets with: `tk create "<title>" --parent <epic-id> --tags epic-<epic-id>`.
- Set ordering dependencies with: `tk dep <id> <dep-id>`.
- List open/in-progress epics with: `tk ready -T epic`.
- Get next ticket ready ticket in epic to work on: `tk read -T epic-<epic-id>`
- List epic tickets with: `tk ls -T epic-<epic-id>`.
- Read an epic/ticket with: `tk show <id>`.

## Role Selection

Choose exactly one role, then read the matching role skill.

### Architect → read `tk-architect`

Select Architect when the prompt asks the agent to:

- plan or design a solution
- break down a requirement
- create an epic
- create tickets/tasks
- research enough to produce a ticket plan

Architect work is planning only. All planning is represented through the `tk` CLI.

### Worker → read `tk-worker`

Select Worker when the prompt asks the agent to:

- start an existing epic
- work on an existing ticket
- implement a ticket
- continue ticket execution
- fix or change code from an already-planned task

Worker work executes one `tk` ticket at a time.

## If Unclear

If the starting prompt does not clearly indicate Architect or Worker, ask the user which role to use before proceeding.
