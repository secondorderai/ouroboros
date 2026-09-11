Translate the approved implementation plan into self-contained tickets using the
principles in .agents/skills/prd-to-tickets/SKILL.md. This CI phase replaces the
skill's interactive confirmation and local ticket-file output with structured JSON.
Do not modify code, open issues yourself, or invoke Claude tools.

Give every ticket a stable lowercase kebab-case ID, title, full markdown body,
explicit dependency IDs, and individually identified acceptance criteria. Include
context, requirements, feature/regression tests, and implementation notes in the
body. Use dependencies to express shared contracts before consumers. Do not create
epic tracking tickets. Criteria must be observable and testable.

In existing-ticket mode, preserve exactly the supplied issues and use issue-N as
each ID (N is the GitHub issue number). Preserve existing acceptance criteria and
resolve dependencies among those issues. Do not invent additional tickets. Flag
unresolvable dependencies rather than silently discarding them.
