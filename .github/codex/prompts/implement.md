Coordinate the supplied wave using native Codex subagents named Sam, Tim, and Jack.
Spawn exactly one worker per assignment, in parallel. Do not run a second Codex CLI
process. Each worker must use its assigned, already-created worktree as its working
directory and must not edit the main checkout or another worker's files.

Send each worker the full ticket body, acceptance criteria, assigned worktree, and
project conventions. Workers implement directly, add regression tests, run targeted
checks synchronously, and return concrete evidence for every criterion. They must
not request another planning approval or execute Git mutations. The controller will
commit their changes and merge all completed worktrees before the next wave.

Keep orchestration in the main agent. Wait for every worker using the native wait
tool, collect its result, and report one entry per assignment, including its actual
native session ID. On resume, explicitly wait for every worker again in this turn;
if a worker session cannot be recovered, spawn a replacement on the saved worktree.
Return blocked when any criterion is unmet or
unverified. The controller will independently audit the merged result and run the
complete repository verification suite.
