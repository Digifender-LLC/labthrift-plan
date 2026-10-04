## Subagent routing and orchestration

The primary agent acts as an orchestrator, coordinating work through context-scoped subagents rather than performing coding and edits directly. This division of labor optimizes reasoning effort and keeps the main conversation focused on coordination and decision-making.

When delegating to subagents, route work based on task complexity and requirements:

- **Haiku 4.5**: Fastest and cheapest. Use for simple, straightforward tasks (file reads, pattern matching, routine edits, small scripts, exploratory searches and quick lookups) and narrow, well-defined problems without complex cross-file dependencies.
- **Sonnet 5.5**: Balanced capability for general-purpose work (multi-file refactoring, feature implementation, moderate complexity analysis, code review). The default choice for most substantive tasks.
- **Opus 5.5**: Strong reasoning for complex, high-stakes work (architecture decisions, cross-system design, deep codebase analysis, security review, intricate bug diagnosis). Use when a task requires sustained reasoning across multiple domains or when Sonnet's output quality is insufficient.
- **Fable 5.1**: Most capable and most expensive. Reserve for the hardest reasoning and long-horizon agentic work, where Opus falls short.

**Orchestrator responsibilities**: Define the task scope, provide context and constraints, verify subagent work, and coordinate across multiple efforts. Route simple, independent subtasks to faster models to reduce latency and cost. Reserve Opus for genuinely complex problems requiring deep reasoning or when task failure would be costly, and Fable for problems Opus cannot handle.

**Subagent responsibilities**: Execute focused work within defined scope—code writes, edits, file operations, targeted analysis. Report results clearly so the orchestrator can verify and coordinate the next step.

## Deployment

Merging to `main` deploys this repository to Cloudflare automatically through Cloudflare Workers Builds (Worker `lab-plan`). Do not deploy by hand.

- To ship a change: open a PR, merge it to `main`. Cloudflare then runs the build command `npm run test:api` and, only if it passes, `npx wrangler d1 migrations apply lab-plan --remote && npx wrangler deploy`. A failing build deploys nothing.
- Never run `wrangler deploy`, `wrangler versions deploy`, `opennextjs-cloudflare deploy`, `wrangler d1 migrations apply --remote`, or any other command that changes production. You do not need a Cloudflare API token and should not look for one.
- Check the result on the commit's Workers Builds check in GitHub. If the build failed, fix it with another PR; do not deploy around it.
- The build only has this repository. Files outside the repo, gitignored files and local secrets are not available to it.
- Migrations in `migrations/` are applied automatically before the new code goes live, so each migration must be safe while the previous version of the Worker is still serving.
- The browser tests (`npm run test:browser`) are not part of the deploy gate; run them before merging UI changes.
