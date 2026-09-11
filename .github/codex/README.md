# Codex Team SDLC

This is GitHub Actions automation for developing Ouroboros. It runs **OpenAI's
Codex CLI** on Blacksmith; it does not run the Ouroboros agent or change the
application's authentication, scheduling, or team implementation.

The pipeline is:

`issue/PRD → plan → approval → tickets → implementation waves → audit/fix → review/fix → verification → PR`

## One-time setup

Merge the workflow infrastructure to the repository's default branch before
enabling it. The existing Blacksmith organization integration must grant this
repository access to the 2-vCPU and 8-vCPU Ubuntu 24.04 runners.

1. In **Settings → Environments**, create `codex-sdlc`. Restrict its deployment
   branches to **Selected branches and tags → `main` (branch)**. If the default
   branch changes, update this rule. Do not configure an additional environment
   approval if you want unattended continuation; the issue command is the planning
   approval gate.
2. Add the three required **environment secrets**, listed below. Do not put
   `CODEX_AUTH_JSON` in repository-level secrets: those are captured when a run is
   queued, whereas environment secrets are read when its serialized job starts.
3. Allow Actions to create pull requests in the repository's Actions settings.
4. Create the `codex-team-sdlc` issue label. The workflow creates its internal
   `codex-sdlc-tracked` label when first used.

| Environment secret              | Purpose                                                                                                                                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CODEX_AUTH_JSON`               | A dedicated Codex ChatGPT login's complete managed `auth.json`.                                                                                                                                    |
| `CODEX_AUTH_WRITE_TOKEN`        | A fine-grained GitHub PAT limited to this repository, with **Environments: read/write**, used only to persist refreshed authentication. Its owner must be able to manage the environment.          |
| `CODEX_SDLC_STATE_KEY`          | A base64-encoded random 32-byte key for authenticated checkpoint encryption. Keep it unchanged while saved pipelines exist.                                                                        |
| `CODEX_GITHUB_TOKEN` (optional) | A repository member's GitHub token with **Contents: read**, **Issues: read/write**, and **Pull requests: read/write**, used to publish PRs without the default token's PR CI approval requirement. |

Create a dedicated subscription login on a trusted computer. Do not copy a login
that another computer or the desktop app is actively using: concurrent token
refreshes can invalidate it. With a current Codex CLI and GitHub CLI installed:

```bash
SDLC_LOGIN_DIR=$(mktemp -d)
env CODEX_HOME="$SDLC_LOGIN_DIR" codex -c 'cli_auth_credentials_store="file"' login
gh secret set CODEX_AUTH_JSON --env codex-sdlc --repo secondorderai/ouroboros < "$SDLC_LOGIN_DIR/auth.json"
openssl rand -base64 32 | gh secret set CODEX_SDLC_STATE_KEY --env codex-sdlc --repo secondorderai/ouroboros
gh secret set CODEX_AUTH_WRITE_TOKEN --env codex-sdlc --repo secondorderai/ouroboros
rm -rf "$SDLC_LOGIN_DIR"
gh label create codex-team-sdlc --repo secondorderai/ouroboros --color 3567b8 --description 'Request a Codex SDLC plan'
```

The PAT command prompts for the token; do not paste it into an issue, chat, or shell
argument. Never upload `auth.json` as an artifact. The controller writes the
refreshed file back after each Codex phase and during cleanup. A write-back failure
blocks continuation rather than restoring a known-stale seed on the next runner.

This subscription setup follows the requested Actions Secrets design in a public
repository. OpenAI documents account-auth CI as an advanced **trusted private
automation** pattern and advises against using it in public/open-source repositories.
The maintainer-only command gate and default-branch environment restriction are
therefore essential, but do not turn it into OpenAI's recommended public CI setup.
See [OpenAI's account-auth guide](https://learn.chatgpt.com/docs/auth/ci-cd-auth),
[GitHub secret timing](https://docs.github.com/en/enterprise-cloud@latest/actions/reference/security/secrets),
and [environment secret permissions](https://docs.github.com/en/rest/actions/secrets#create-or-update-an-environment-secret).

## Commands

All commands must be the entire comment, with optional surrounding whitespace.
Only repository users with write, maintain, or admin permission can operate the
pipeline. PR comments and commands embedded in prose are ignored.

| Trigger                     | Behavior                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Add `codex-team-sdlc` label | Generate a plan, post it on the issue, then wait for approval.                                                                       |
| `/approve-team-sdlc`        | Approve the saved plan; without a waiting plan, approve the issue body as the PRD.                                                   |
| `/codex-team-implement-now` | Normalize existing sub-issues and implement them; requires sub-issues.                                                               |
| `/codex-team-review-now`    | Audit/review/fix/test the existing SDLC branch without implementing a new ticket wave. Requires changes ahead of the default branch. |
| `/codex-team-resume`        | Resume a blocked or cancelled checkpoint with a newly authorized five-day window.                                                    |
| `/codex-team-cancel`        | Stop the pipeline and cancel its current Actions run.                                                                                |

The Actions **Run workflow** form provides equivalent operations with an issue
number. `continue` and `pipeline_id` are for the companion scheduler, not a way to
bypass approval. Start a new plan by removing and reapplying the label if necessary.

The issue's bot-owned status comment is the queue entry. It records a pipeline ID,
stage, deadline, and pointer to an immutable encrypted artifact. Keep this comment
and the tracking label: deleting them prevents automatic recovery. Sub-issues stay
open until the final PR merges, using closing references in its body.

## Execution and continuation

Code lands on `codex/sdlc-issue-N`. Sam, Tim, and Jack run as native subagents within
one Codex process. Each has an assigned worktree and dependency-ready ticket. The
controller waits for complete reports, commits every worker's edits, and merges
the wave. Only the controller performs GitHub and Git mutations. GitHub credentials
and artifact service credentials are stripped from Codex and build subprocesses.
Worker reports must identify their actual native session IDs and match completion
events from the pinned CLI; unfinished workers cannot pass the integration gate.
The event format is checked against the [Codex CLI source](https://github.com/openai/codex/blob/rust-v0.149.0/codex-rs/exec/src/exec_events.rs).

The controller and prompts are loaded from the workflow's default-branch commit in
a separate checkout, never from the generated branch. Planning, ticket conversion,
audit, and review use read-only Codex sandboxes. Implementation/fixes use the
workspace-write sandbox with network access and noninteractive approval denial.

Repository variables:

| Variable                    | Default                                                           |
| --------------------------- | ----------------------------------------------------------------- |
| `CODEX_MODEL`               | `gpt-6-astra`                                                     |
| `CODEX_EFFORT`              | `xhigh`                                                           |
| `CODEX_SDLC_WINDOW_MINUTES` | `300`; an integer from 1 to 300, useful for testing interruption. |

Codex is pinned to `0.149.0`. Model availability errors stop the pipeline; there is
no silent downgrade or API-key fallback. Update the CLI version in both `model.ts`
and the execution workflow together, and run the controller tests.

An HTTP 400 model rejection can mean the CI login lacks access even when the model
appears in your desktop account. Check the model picker using the dedicated CI
login. Restore its access and reseed `CODEX_AUTH_JSON`, or explicitly set
`CODEX_MODEL` to a model that login can use (and `CODEX_EFFORT` to a supported
effort). Then use `/codex-team-resume` or the manual `resume` operation. The
controller reports fixed error categories publicly and keeps raw errors encrypted.

Each job reserves 30 minutes beyond the normal five-hour execution window for
shutdown, credential write-back, and checkpoint upload. It can yield earlier to
stay within the artifact-count budget. The companion workflow runs after pipeline
completion and every 15 minutes. It resumes eligible work without retaining a
Blacksmith VM while waiting. GitHub scheduling may be delayed; it is not an exact
wakeup timer.

On quota exhaustion, a structured reset timestamp is used when available; otherwise
the next check is an hour later. Automatic continuation preserves the original
five-day deadline, measured from implementation approval. Waiting for human plan
approval does not consume that window. Explicit resume grants a new window.
Quota waits pause other queued issues that share this subscription.

GitHub concurrency can replace a pending job when several issues are queued. Queue
entries remain on their issues, so the scheduler redispatches displaced work. A
cancelled **active** run stays cancelled until a maintainer resumes it.

The final PR is ready only when every criterion passes its audit, no critical or
warning review findings remain, and verification passes for the exact same commit.
Fixes invalidate previous audit/review/test results. Each fix category permits three
attempts before requiring maintainer intervention. Incomplete integrated work is
published as a draft PR; work that has not reached the integration branch remains
in the encrypted checkpoint. Nothing is automatically merged or deployed.
Promotion checks the live PR's branch and SHA against the verified commit. The
ordinary build workflow also handles `ready_for_review`, so the optional publication
token can start CI when an existing draft is promoted. With `GITHUB_TOKEN`, approve
the PR's workflow runs as required by [GitHub's automation event rules](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).

## Checkpoints and recovery

To investigate a blocked Codex call without revealing session contents, run the
main workflow manually with the issue number and operation `diagnose`. Its read-only
job decrypts the checkpoint on Blacksmith and prints only fixed, allowlisted error
categories. It does not launch Codex, load the subscription login, or change pipeline
state. Raw transcripts remain encrypted.

Checkpoints contain requirements, the plan, ticket manifests and GitHub mappings,
stage reports, native session files, worktree commits (including unfinished work),
and the original deadline. They use AES-256-GCM, bound to repository, issue, and
pipeline identity. The controller checks artifact/run/default-branch provenance
and the ciphertext digest before restoring. Authentication, configuration, hooks,
and plugins are excluded from session restoration.
If the saved native session file is missing, Codex reconstructs the unfinished
phase from its requirements, reports, and worktrees. It records whether each phase
resumed a session or reconstructed it.

Artifacts expire after 14 days (or the repository's shorter retention policy).
Do not rotate `CODEX_SDLC_STATE_KEY` while you still need them. Hard runner loss or
forced cancellation can lose work since the latest completed checkpoint; automatic
recovery does not imply a checkpoint was saved during a kill.

To inspect a downloaded `checkpoint.enc`, obtain the issue number and pipeline ID
from the status comment and provide the state key through a private environment:

```bash
bun .github/codex/inspect-checkpoint.ts checkpoint.enc secondorderai/ouroboros 123 PIPELINE_UUID /tmp/sdlc-inspection
```

This writes decrypted records to the chosen directory. Treat them as private and
remove them after inspection. The tool never needs subscription auth.

For expired/revoked authentication or failed write-back, create a fresh dedicated
login and replace the environment's `CODEX_AUTH_JSON`, repair the writer PAT if
needed, then post `/codex-team-resume`. Changing the issue body invalidates an old
requirements checkpoint: request and approve a new plan instead. For work manually
changed on the SDLC branch, use review-only rather than silently rebasing saved
worker state onto it. Merge conflicts preserve worker commits in the checkpoint
and require maintainer resolution.

## Verification and smoke test

From the repository root:

```bash
npm ci --prefix .github/codex --ignore-scripts
npm --prefix .github/codex run check
npm --prefix .github/codex test
actionlint -ignore 'label "blacksmith-' .github/workflows/codex-team-sdlc.yml .github/workflows/codex-team-sdlc-continue.yml .github/workflows/build.yml
bun run verify
```

Ordinary CI runs controller tests and workflow validation without subscription
secrets. The development workflow runs a narrow CLI binary build, then
`xvfb-run --auto-servernum bun run verify`. Benchmark-only changes run the touched
benchmark's package test script plus root lint, type checks, and CLI tests. A
benchmark without a test script stops with an explicit verification requirement.
Live LLM tests are not part of these checks.

After setup, use a small real issue to validate:

1. The label produces a plan and leaves the branch without implementation changes.
2. An unauthorized command has no effect; an authorized approval creates linked
   tickets and starts implementation.
3. Temporarily set `CODEX_SDLC_WINDOW_MINUTES=1`, confirm encrypted checkpoint
   creation and continuation on a new runner, then remove the variable.
4. Confirm the subscription secret's update timestamp changes after a Codex phase,
   and no auth file or plaintext session artifact is uploaded.
5. Cancel an active run; confirm it stays stopped, then explicitly resume it.
6. Confirm the final PR references the tested commit, closes its linked issues on
   merge, and remains a draft while any criterion or required check is incomplete.

Local tests do not establish that subscription refresh, native subagents, or
artifact upload work on a live Blacksmith runner; that smoke test requires the
configured environment secrets.
