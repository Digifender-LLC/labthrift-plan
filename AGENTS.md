## Subagent routing and orchestration

The primary agent acts as an orchestrator, coordinating work through context-scoped subagents rather than performing coding and edits directly. This division of labor optimizes reasoning effort and keeps the main conversation focused on coordination and decision-making.

When delegating to subagents, route work based on task complexity and requirements:

- **Fable 5.1**: Fast, cost-efficient agent for simple, straightforward tasks (file reads, pattern matching, routine edits, small scripts). Ideal for exploratory searches and quick lookups.
- **Haiku 4.5**: Lightweight reasoning for focused tasks (targeted code analysis, small refactors, single-file changes, fast feedback loops). Best for narrow, well-defined problems without complex cross-file dependencies.
- **Sonnet 5.5**: Balanced capability for general-purpose work (multi-file refactoring, feature implementation, moderate complexity analysis, code review). The default choice for most substantive tasks.
- **Opus 5.5**: Most capable reasoning for complex, high-stakes work (architecture decisions, cross-system design, deep codebase analysis, security review, intricate bug diagnosis). Use when a task requires sustained reasoning across multiple domains or when Sonnet's output quality is insufficient.

**Orchestrator responsibilities**: Define the task scope, provide context and constraints, verify subagent work, and coordinate across multiple efforts. Route simple, independent subtasks to faster models to reduce latency and cost. Reserve Opus for genuinely complex problems requiring deep reasoning or when task failure would be costly.

**Subagent responsibilities**: Execute focused work within defined scope—code writes, edits, file operations, targeted analysis. Report results clearly so the orchestrator can verify and coordinate the next step.
