# TK Workflow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              TK ARCHITECT FLOW                                │
│                        (Planning → Open for Workers)                          │
└─────────────────────────────────────────────────────────────────────────────┘

  User runs: /tk-architect "Build auth system"
         │
         ▼
  ┌─────────────────────────────┐
  │ Create epic ticket          │
  │ status: in_progress         │
  │ tags: by_architect,         │
  │       agent_work,           │
  │       architect_planning    │
  └─────────────────────────────┘
         │
         ▼
  Create branch: epic/<id>-build-auth-system
         │
         ▼
  Commit: "PI: Init"
         │
         ▼
  ┌─────────────────────────────┐     ┌─────────────────────────────┐
  │ AGENT WORK PHASE            │◄────│ Human sends back with       │
  │ • Edit .tickets/*.md        │     │ REVIEW: comments or edits   │
  │ • tk create child tickets   │     │ Commit: "human: review      │
  │ • tk dep <id> <dep>         │     │ changes"                    │
  │ • Call:                     │     │ Tag: agent_work             │
  │   tk_architect_agent_done   │     └─────────────────────────────┘
  └─────────────────────────────┘
         │
         ▼
  Commit: "agent: <summary>"
  Tag: human_review
  Terminate
         │
         ▼
  ┌─────────────────────────────┐
  │ HUMAN REVIEW PHASE          │
  │ User runs: /tk-architect    │
  │ "Need updates?"             │
  │                             │
  │  YES ──► Send back to agent │
  │  NO  ──► Tag: final_approved  │
  └─────────────────────────────┘
         │
         ▼
  ┌─────────────────────────────┐
  │ Agent calls:                  │
  │ tk_architect_finalize       │
  │ "feat: auth system design"  │
  └─────────────────────────────┘
         │
         ▼
  Squash commits, merge to main
         │
         ▼
  ┌─────────────────────────────┐
  │ Epic becomes:                 │
  │ status: open                  │
  │ tags: (none)                  │
  │                               │
  │ ► Ready for workers! ◄        │
  └─────────────────────────────┘


┌─────────────────────────────────────────────────────────────────────────────┐
│                              TK WORKER FLOW                                 │
│                        (Implementation → Close)                             │
└─────────────────────────────────────────────────────────────────────────────┘

  User runs: /tk-worker
         │
         ▼
  ┌─────────────────────────────┐
  │ 1. Find active in_progress  │
  │    + by_worker epic?       │
  │                             │
  │ 2. No? Check branch name   │
  │    epic/<id>-slug → match  │
  │                             │
  │ 3. No? Show available:     │
  │    [open]   Epic from arch  │◄──┐
  │    [open]   Another epic    │   │
  │    [in_progress] Some epic  │   │
  │    ─────────────────────    │   │
  │    Start a new epic         │   │
  └─────────────────────────────┘   │
         │                          │
    Select open epic ───────────────┘
         │
         ▼
  ┌─────────────────────────────┐
  │ Start the epic:             │
  │ status: in_progress         │
  │ tags: by_worker, agent_work   │
  │ Create branch, "PI: Init"   │
  └─────────────────────────────┘
         │
         ▼
  ┌─────────────────────────────┐     ┌─────────────────────────────┐
  │ AGENT WORK PHASE            │◄────│ Human sends back with       │
  │ • Edit source files         │     │ REVIEW: comments or edits   │
  │ • Run tests                 │     │ Commit: "human: review      │
  │ • Call:                     │     │ changes"                    │
  │   tk_worker_agent_done      │     │ Tag: agent_work             │
  └─────────────────────────────┘     └─────────────────────────────┘
         │
         ▼
  Commit: "agent: <summary>"
  Tag: human_review
  Terminate
         │
         ▼
  ┌─────────────────────────────┐
  │ HUMAN REVIEW PHASE          │
  │ User runs: /tk-worker       │
  │ "Need updates?"             │
  │                             │
  │  YES ──► Send back to agent │
  │  NO  ──► Tag: final_approved│
  └─────────────────────────────┘
         │
         ▼
  ┌─────────────────────────────┐
  │ Agent calls:                │
  │ tk_worker_finalize          │
  │ "feat: implement auth"       │
  └─────────────────────────────┘
         │
         ▼
  Squash commits, merge to main
         │
         ▼
  ┌─────────────────────────────┐
  │ Epic becomes:               │
  │ status: closed              │
  │ tags: (none)                │
  │ Branch deleted (optional)   │
  └─────────────────────────────┘


┌─────────────────────────────────────────────────────────────────────────────┐
│                           STATE REFERENCE                                   │
└─────────────────────────────────────────────────────────────────────────────┘

  EPIC STATUS:        open → in_progress → closed

  ARCHITECT TAGS:
    Creating:        by_architect + architect_planning + agent_work
    Human review:      by_architect + architect_planning + human_review
    Final approved:    by_architect + architect_planning + final_approved
    After finalize:    (none)  ← status: open

  WORKER TAGS:
    Creating:          by_worker + agent_work
    Human review:      by_worker + human_review
    Final approved:    by_worker + final_approved
    After finalize:    (none)  ← status: closed

  ARCHITECT GUARD:
    • Blocks: edit/write outside .tickets/
    • Blocks: bash except tk, read-only git, read-only exploration
    • Blocks: all tools during human_review and final_approved

  WORKER GUARD:
    • Blocks: destructive git commands during agent_work
    • Blocks: all tools during human_review and final_approved
    • Allows: everything else during agent_work

  BRANCH NAMING:
    epic/<epic-id>-slugified-title

  COMMIT PATTERN:
    PI: Init          → created by extension (not agent, not human)
    agent: <summary>  → agent handoff
    human: review changes → human handoff
```
