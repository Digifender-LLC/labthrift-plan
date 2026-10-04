## Subagent routing and orchestration

The primary agent acts as an orchestrator, coordinating work through context-scoped subagents rather than performing coding and edits directly. This division of labor optimizes reasoning effort and keeps the main conversation focused on coordination and decision-making.

When delegating to subagents, route work based on task complexity and requirements:

- **Haiku 4.5**: Fastest and cheapest. Use for simple, straightforward tasks (file reads, pattern matching, routine edits, small scripts, exploratory searches and quick lookups) and narrow, well-defined problems without complex cross-file dependencies.
- **Sonnet 5.5**: Balanced capability for general-purpose work (multi-file refactoring, feature implementation, moderate complexity analysis, code review). The default choice for most substantive tasks.
- **Opus 5.5**: Strong reasoning for complex, high-stakes work (architecture decisions, cross-system design, deep codebase analysis, security review, intricate bug diagnosis). Use when a task requires sustained reasoning across multiple domains or when Sonnet's output quality is insufficient.
- **Fable 5.1**: Most capable and most expensive. Reserve for the hardest reasoning and long-horizon agentic work, where Opus falls short.

**Orchestrator responsibilities**: Define the task scope, provide context and constraints, verify subagent work, and coordinate across multiple efforts. Route simple, independent subtasks to faster models to reduce latency and cost. Reserve Opus for genuinely complex problems requiring deep reasoning or when task failure would be costly, and Fable for problems Opus cannot handle.

**Subagent responsibilities**: Execute focused work within defined scope—code writes, edits, file operations, targeted analysis. Report results clearly so the orchestrator can verify and coordinate the next step.
