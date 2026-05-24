---
name: tk-architect
description: TK architect is automated by the tk-architect extension. Use slash commands instead of this skill.
---

# TK Architect

Use deterministic extension commands:

```text
/tk-architect-start <epic title>
/tk-architect-review
/tk-architect-child <child ticket title>
/tk-architect-dep <ticket-id> <depends-on-id>
/tk-architect-review-deps
/tk-architect-finalize
/tk-architect-status
```

The extension edits real `tk` ticket files directly under `.tickets/`.

Flow:

1. `/tk-architect-start <epic title>` creates the epic ticket and hands that ticket file to the agent.
2. Agent edits only the active `.tickets/*.md` file and calls `tk_architect_agent_done`.
3. `/tk-architect-review` opens the active ticket for human review. After the editor closes, choose:
   - move on / approve this ticket
   - stay on this ticket / send back to agent
   - just save and decide later
4. Repeat with `/tk-architect-child <title>` for each child ticket.
5. Add dependencies with `/tk-architect-dep <ticket-id> <depends-on-id>`.
6. Review dependencies with `/tk-architect-review-deps`, then `/tk-architect-finalize`.

Workflow state is stored in `.git/pi-tk-architect-state.json`.
