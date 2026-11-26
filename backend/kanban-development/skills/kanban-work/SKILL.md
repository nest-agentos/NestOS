---
name: kanban-work
description: Work with Kanban decisions, planning, execution, and delivery using the session's frozen scope and formal receipts.
---

# Kanban work

Read the current task, identity and admitted stage from `session_context`. Those values, the frozen permissions and explicit user instructions govern this work. This Skill is guidance, not task data or permission to change a decision.

- For decision and planning work, read [planning](references/planning.md).
- For implementation and delivery, read [execution](references/execution.md).
- For management operations, use the admitted phase and its session guidance; do not infer integration, build or deployment authority from a source task.

Use the existing session request and report protocol for durable exchanges. Distinguish acceptance of a message from completion of the operation it describes. Preserve stable operation identities and report unknown outcomes rather than replaying them.
