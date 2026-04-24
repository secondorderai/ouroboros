# Examples

## Should Trigger

- "Compare whether we should migrate this service now or wait a quarter. Include tradeoffs, risks, and what information could change the decision."
- "Create a rollout plan for moving our chat backend from a single agent to a planner-plus-critic workflow."
- "This deployment is timing out intermittently in production. I have partial logs and no repro. Help me troubleshoot without overcommitting to one cause."
- "Review this architecture proposal and call out the weak assumptions, likely failure modes, and what we still need to verify."
- "I need an answer I can trust. Please surface confidence, limitations, and what context is still missing."

## Should Not Trigger

- "What is the capital of Japan?"
- "Rename this variable to `resourceId`."
- "Convert this JSON object to YAML."
- "Summarize this paragraph in one sentence."
- "What command shows the current git branch?"

## Borderline

- "Draft a short plan for tomorrow's meeting."
  - Use direct mode unless the meeting planning has meaningful constraints or tradeoffs.
- "Explain meta-cognition in AI."
  - Do not use this skill unless the user wants the method applied to a task rather than explained as a concept.
