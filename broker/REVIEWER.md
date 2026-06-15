# Channel reviewer — backgrounded live Claude (no `claude -p`)

Lets a **Codex host** (or any host) use **Claude** as a peer reviewer **without spawning
`claude -p`** — so the Claude reviews stay on the **subscription pool**, not the 2026-06-15
programmatic credit pool.

```
host (Codex/…) ──peer review──▶ code-assistant-peers MCP
                                   │  peer = claude-live  (prompt_transport: "channel")
                                   ▼
                              broker (localhost) ──GET /next──▶ 🟦 reviewer worker (broker/reviewer.ts)
                                   ◀── POST /jobs/:id/result ──   │  tmux send-keys / capture-pane
                                   ▼                              ▼
                           runReviewCommand returns it     backgrounded interactive `claude`
                           (command = ["<broker>", …])     (read-only, subscription pool)
```

## Why this stays on the subscription pool (researched, high confidence)

Anthropic bills by **mode of use**: the **interactive** Claude Code TUI draws from the Pro/Max
**subscription**; `claude -p` / the Agent SDK / `stream-json` draw from the separate programmatic
credit pool (split off on **2026-06-15**). The reviewer worker drives the **interactive** TUI via
tmux, so it stays interactive — and therefore on the subscription.

> Caveat: "a tmux-driven interactive session is billed as interactive" is a strong inference from
> Anthropic's interactive-vs-headless boundary, **not** a vendor-confirmed ruling. Verify with the
> checklist below before relying on it for cost.

**`ANTHROPIC_API_KEY` overrides everything** → if it is set, Claude Code bills the API key
regardless of mode. It MUST be unset for the reviewer session, and `claude` must be logged in via
claude.ai (OAuth). The worker prints a warning if it sees `ANTHROPIC_API_KEY`.

## Status

| piece | state |
|---|---|
| `claude-live` adapter (`prompt_transport: "channel"`) | ✅ implemented |
| channel transport client (`shared/broker-client.ts`) | ✅ implemented + tested |
| `runReviewCommand` channel branch **+ fallback to `claude -p`** | ✅ implemented + tested |
| broker daemon (`broker/server.ts`) | ✅ implemented (generic relay) |
| **reviewer worker → live CLI TUIs via tmux** (`broker/reviewer.ts`) | ✅ implemented, generic over claude/gemini/codex; loop + extraction unit-tested |
| **auto-start backend on first live review** (`ensureChannelBackend`) | ✅ implemented + tested; verified end-to-end live |
| live tmux round-trip: `claude-live` | ✅ verified (review returned, `command = ["<broker>","claude-live"]`, repo unchanged) |
| live tmux round-trip: `codex-live` | ✅ verified (real Codex TUI driven via tmux, review returned) |
| live tmux round-trip: `gemini-live` | ✅ verified (real Gemini CLI driven via tmux, review returned) |
| **host-side passes via live session** (`CODE_ASSISTANT_PEERS_LIVE_HOST_REVIEWS=1`) | ✅ implemented + tested (self-review, aggregate, collaborative host pass) |
| **billing actually = subscription** | ⬜ **confirm on the Anthropic usage dashboard** (strongly inferred: interactive TUI + no API key) |

The worker loop, broker round-trip (with an `--echo` stand-in), and tmux verbs are tested. The one
piece that can only be verified with a logged-in `claude` is the live TUI round-trip and that the
usage actually lands on the subscription.

## Setup — just pick `claude-live` (auto-start)

The backend (broker + reviewer worker + the tmux `claude` session) **starts itself automatically**
on the first `claude-live` review and is **reused** for every later review. So the only setup is:

```bash
PEER_ASSISTANTS=claude-live          # or codex,claude-live for multi-peer
```
…and make sure `ANTHROPIC_API_KEY` is **unset** and `claude` is logged in (`claude` → `/login`,
claude.ai). That's it — review from Codex or Claude as usual and the backgrounded Claude session
appears on demand. The MCP server logs one line to stderr when it auto-starts the backend.

- Sessions are per CLI kind + repo, named `peer-reviewer-<kind>-<repo>-<hash>` (kind =
  claude/gemini/codex) — list them with `tmux ls`.
- Watch a live reviewer think: `tmux attach -t <session name>` (Ctrl-b d to detach).
- Auto-start logs (broker + worker stdout/stderr): `$TMPDIR/code-assistant-peers-backend.log`.
- Stop the backend: `tmux kill-session -t <session name>` per session and kill the broker on its port.
- Disable auto-start (run the daemons yourself): `CODE_ASSISTANT_PEERS_NO_AUTOSTART=1`.

## Other live reviewers: `gemini-live`, `codex-live`

The worker is generic over the reviewer CLI:

**`gemini-live`** drives an interactive Gemini CLI session with:
- `--skip-trust --approval-mode auto_edit` — auto-approves file-edit tools (write_file, replace)
  without showing approval dialogs.
- `--admin-policy <.peer-review/reviewer-policy.toml>` — the policy provides a hard shell+write
  boundary: DENY `run_shell_command` (priority 5.600, blocks prompt-injection via shell),
  ALLOW `write_file` to `.peer-review/` (priority 5.500), DENY `write_file` elsewhere (priority
  5.100). Admin tier (5.x) overrides auto_edit tier (1.x), so the net result is: writes to
  .peer-review/ are auto-approved; writes elsewhere are hard-denied; shell is hard-denied.
- `--admin-policy <.peer-review/reviewer-policy.toml>` — a per-session policy written before launch.
  Admin-policy tier (5.x) overrides the built-in autoEdit tier (1.x) so:
  - DENY rule (priority 5.100) blocks `write_file`/`replace` to paths outside `.peer-review/`
  - ALLOW rule (priority 5.500) permits writes inside `.peer-review/` for output files.
  This gives a hard write boundary equivalent to claude's `--disallowedTools`.
- Reset with `/clear` between reviews.

**`codex-live`** drives an interactive Codex TUI with:
- `--sandbox workspace-write -a never` — allows writes to the workspace. Note: `--sandbox read-only
  --add-dir .peer-review/` does NOT work (codex ignores `--add-dir` in read-only mode), so
  workspace-write is the only option that enables file output. The write-safety boundary for codex
  is the injected `-c instructions=...` (advisory, not a hard sandbox).
- Reset with `/new` between reviews.

Unlike Claude there is **no known headless-vs-interactive billing split** for these — the benefit
is a persistent per-repo session whose conversation memory can be kept across reviews
(`CODE_ASSISTANT_PEERS_REVIEWER_CLEAR=never`). Both fall back to their headless CLI if the
broker/session is unavailable. Both are live-verified.

Both `gemini-live` and `codex-live` use **file-based review output**: the reviewer writes the
review to `.peer-review/<jobId>-output.md` and the worker polls that file (falling back to
`capture-pane` if the file is absent). Prompt files and output files are both in `.peer-review/`
inside the repo cwd (gitignored), which each CLI can read and write under their respective
permission models.

Gemini must be authenticated once interactively (`gemini` → login, or set `GEMINI_API_KEY`);
the cached creds then work in the detached session.

## Host-side passes on the live session

Self-review, the multi-peer **aggregate pass**, and the **collaborative host comparison** run as
the HOST — for a claude host that normally spawns `claude -p` (credit pool). Set:

```bash
CODE_ASSISTANT_PEERS_LIVE_HOST_REVIEWS=1
```

and those passes route through `<host>-live` instead (when that adapter exists), keeping them on
the persistent session — and, for claude hosts, on the subscription pool.

**Who runs self-review** is controlled by `CODE_ASSISTANT_PEERS_SELF_REVIEW`:

| value | effect |
|---|---|
| unset (default) | `codex` host only (backwards compatible) |
| `all` / `*` | every host self-reviews |
| `none` / `off` | self-review disabled |
| comma list | those hosts, e.g. `claude,codex` |

Self-review never runs in `gate` or `collaborative` modes. Combine with `LIVE_HOST_REVIEWS=1` so
the self-review runs on the host's live tmux session (subscription pool for claude).

### Manual / advanced (optional)

Run the daemons yourself (e.g. on a different host/port, or to share one reviewer across repos):

```bash
# terminal A — broker
CODE_ASSISTANT_PEERS_BROKER_PORT=7899 bun broker/server.ts
# terminal B — reviewer worker (creates the read-only interactive tmux `claude`, processes jobs)
CODE_ASSISTANT_PEERS_REVIEWER_CWD="$PWD" bun broker/reviewer.ts
#   --once : process a single job then exit (verification)
#   --echo : fake reviewer (no claude) for plumbing tests
```

### Tuning (env)

| var | default | meaning |
|---|---|---|
| `CODE_ASSISTANT_PEERS_TMUX_SESSION` | `peer-reviewer` | tmux session BASE name (sessions are `<base>-<kind>-<repo>-<hash>`, one per CLI kind + repo) |
| `CODE_ASSISTANT_PEERS_REVIEWER_CWD` | cwd | repo dir the reviewer runs in |
| `CODE_ASSISTANT_PEERS_REVIEWER_CLAUDE_ARGS` | read-only flags | override `claude` args (JSON array or space-separated) |
| `CODE_ASSISTANT_PEERS_REVIEWER_GEMINI_ARGS` | `--skip-trust --approval-mode auto_edit --admin-policy <.peer-review/reviewer-policy.toml>` | override `gemini` args (JSON array or space-separated); disables the auto-written policy file |
| `CODE_ASSISTANT_PEERS_REVIEWER_CODEX_ARGS` | `--sandbox workspace-write -a never` (+ `-c instructions=...`) | override `codex` args; set to `--sandbox read-only` to disable file output (reverts to capture-pane extraction) |
| `CODE_ASSISTANT_PEERS_REVIEWER_PROMPT_DIR` | per-kind | override where the per-job prompt/output files are written (claude: repo-hash subdir of TMPDIR; gemini/codex: `<cwd>/.peer-review`) |
| `CODE_ASSISTANT_PEERS_REVIEWER_CLEAR` | *(keep history)* | Default: keep conversation memory across reviews so the reviewer accumulates repo knowledge. Set `always` to reset before each review (old behavior). Session is per-REPO, so history from other tasks in the same repo accumulates too; long-lived contexts will eventually auto-compact. |
| `CODE_ASSISTANT_PEERS_REVIEWER_STARTUP_MS` | `30000` | how long to wait for the TUI to boot |
| `CODE_ASSISTANT_PEERS_REVIEW_TIMEOUT_MS` | `600000` | per-review deliver timeout |
| `CODE_ASSISTANT_PEERS_REVIEWER_POLL_MS` | `1000` | pane poll interval |
| `CODE_ASSISTANT_PEERS_DEV_LOG` | unset | set to `1`, `true`, or `yes` to write developer-only JSONL events for broker jobs, model choices, tmux session creation/resume, and marker extraction |
| `CODE_ASSISTANT_PEERS_DEV_LOG_PATH` | `<cwd>/.code-assistant-peers-dev/<scope>.jsonl` | optional explicit JSONL path for developer logging |

Developer logging is intentionally opt-in. It is useful when repeatedly validating live model
switching, tmux resume/session-id behavior, and marker extraction, but production/default runs do
not write these files. The default log directory is ignored by git. If `CODE_ASSISTANT_PEERS_DEV_LOG_PATH`
is set, broker and reviewer processes write to that same JSONL file so their events can be read in
one timeline. Model-related events include `requestedModel` and `usedModel`; when no explicit model
was requested, `usedModel` is recorded as `cli-default` because the worker cannot know the CLI's
provider-side default model name.

## Read-only safety

The reviewer session launches with `--permission-mode plan` and `Edit/Write/MultiEdit/NotebookEdit`
disallowed → it **cannot modify project files**, even if a reviewed diff contains injected
instructions. tmux does not isolate anything; the read-only permission mode is the safeguard (same
model the existing `claude -p` reviewer uses). It runs in the project dir so it can read the working
state needed to review uncommitted changes.

## How delivery / capture works (and its limits)

For **claude-live**, **gemini-live**, and **codex-live** (file-output mode):
- The prompt is written to a temp file. The reviewer is instructed to **write the review to a
  per-job output file** using its Write tool AND **also print the review to the terminal** with
  BEGIN/DONE markers. Two extraction paths run in parallel each poll cycle:
  1. **File polling** (primary): `extractReviewFromFile` reads `<promptDir>/<jobId>-output.md`.
     Preferred because it contains no TUI chrome.
  2. **capture-pane** (fallback): if the file is absent or incomplete, the terminal capture is
     tried. This ensures completion is detected even if the file write fails (policy mismatch,
     tool refusal, unexpected model behavior).

For **claude-live** only, `capture-pane` extraction is also the exclusive path when the user
overrides `CODE_ASSISTANT_PEERS_REVIEWER_CLAUDE_ARGS` (disabling file output).

For sessions without file-output mode:
- The worker sends a SHORT instruction ("read this file, review it, print `PEER-REVIEW-BEGIN-<jobId>`,
  the review, then `PEER-REVIEW-DONE-<jobId>-END`"). The instruction is echoed in the pane, so
  each marker must appear **at least twice** (echo + emitted) for extraction to succeed.
- This scrapes a rendered TUI screen, so capture is **best-effort**: very long reviews, heavy
  repaints, or unusual wrapping can degrade extraction. A wide pane (`-x 400`) and `capture-pane -J`
  (join wrapped lines) mitigate it. If the marker never appears within the timeout, the worker
  reports a job error and the host falls back to `claude -p`.

## Fallback

If the broker or the reviewer worker is unavailable, `runReviewCommand` **falls back to spawning
`claude -p`** (logs the reason to stderr). So the gate degrades to current behavior rather than
failing — at the cost of the credit pool for that one review.

## review_model and the live session

`review_model` / `review_models` (host-selected reviewer models) apply to spawned CLI reviewers and
to live channel reviewers. The host-selected model is included in the broker job payload and in the
persisted command trace, for example `["<broker>", "claude-live", "--model", "opus"]`.

Confirmed behavior:
- Headless reviewers receive the selected model in the spawned command, e.g.
  `claude -p ... --model opus` or `gemini ... --model pro`.
- Live reviewers keep one tmux TUI session per reviewer kind + repo. The worker tracks the current
  model for that session. If the next review requests a different model, the worker kills and
  relaunches the same tmux session through the CLI resume/session-id path with the requested model.
- Claude and Gemini start with an explicit generated `--session-id`, then resume by that id.
- Codex starts normally, then the worker discovers the saved Codex session id from
  `~/.codex/sessions/**/session_meta`. A Codex live model switch therefore requires at least one
  completed saved Codex review before the worker can resume it with a different model.
- With the default `CODE_ASSISTANT_PEERS_REVIEWER_CLEAR=always`, the process/session is reused but
  the conversation is reset before each review. Use `CODE_ASSISTANT_PEERS_REVIEWER_CLEAR=never`
  when the goal is to preserve reviewer memory across related reviews, accepting cross-task context
  bleed within the same repo and eventual auto-compaction.

## Verification checklist (the remaining empirical step)

Run with the worker up and `PEER_ASSISTANTS=claude-live`:
1. **Plumbing (no claude):** `bun broker/reviewer.ts --echo --once` against a submitted job returns
   a result — confirms broker↔worker↔result wiring. (Covered by tests too.)
2. **Live round-trip:** a real review reaches the tmux `claude` session and the reply comes back —
   the stored round's `command` is `["<broker>", "claude-live"]`, not a spawned `claude -p`.
   Watch it live: `tmux ls` to find the `peer-reviewer-<kind>-<repo>-<hash>` session, then `tmux attach -t <name>`.
3. **No file changes:** `git status` in the project is unchanged after a review.
4. **Billing = subscription:** the reviewer's usage appears under the Claude **subscription**, NOT
   the Agent-SDK/headless credit pool, and `ANTHROPIC_API_KEY` is unset. This is the load-bearing
   assumption — measure it.

## Tradeoffs vs `claude -p`

| | `claude -p` | tmux + live session |
|---|---|---|
| billing | credit pool (after 2026-06-15) ❌ | subscription ✅ (inferred; verify) |
| concurrency | parallel (fresh process each) | serialized (one session) |
| availability | always spawnable | session must be up (else fallback) |
| stability | stable | TUI scraping is best-effort |
