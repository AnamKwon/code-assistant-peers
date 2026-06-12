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

The worker is generic over the reviewer CLI: `gemini-live` drives an interactive Gemini CLI
session (`--skip-trust --approval-mode plan`, reset with `/clear`) and `codex-live` drives an
interactive Codex TUI (`--sandbox read-only`, reset with `/new`). Unlike Claude there is **no
known headless-vs-interactive billing split** for these — the benefit is a persistent per-repo
session whose conversation memory can be kept across reviews
(kept by DEFAULT; set `CODE_ASSISTANT_PEERS_REVIEWER_CLEAR=always` for isolated reviews). Both fall back to their headless CLI if the
broker/session is unavailable. Both are live-verified.

Prompt-file location differs by CLI to satisfy each one's read-permission model: claude/codex
read it from a shared tmp dir (claude grants it with `--add-dir`); **gemini reads it from a
`.peer-review/` dir inside the repo cwd** — gemini's `--include-directories` would otherwise
raise a second "trust this folder?" prompt that stalls a detached session, and the repo cwd is
already trusted via `--skip-trust`. The per-job file is deleted after each review; the empty
`.peer-review/` dir is untracked by git. Gemini must be authenticated once interactively
(`gemini` → login, or set `GEMINI_API_KEY`); the cached creds then work in the detached session.

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
| `CODE_ASSISTANT_PEERS_REVIEWER_GEMINI_ARGS` | `--skip-trust --approval-mode plan` | override `gemini` args (JSON array or space-separated) |
| `CODE_ASSISTANT_PEERS_REVIEWER_CODEX_ARGS` | `--sandbox read-only` | override `codex` args (JSON array or space-separated) |
| `CODE_ASSISTANT_PEERS_REVIEWER_PROMPT_DIR` | per-kind | override where the per-job prompt file is written (claude/codex: a tmp dir; gemini: `<cwd>/.peer-review`) |
| `CODE_ASSISTANT_PEERS_REVIEWER_CLEAR` | keep memory | DEFAULT keeps the session's conversation memory across reviews (note the session is per-REPO, so other tasks' history accumulates too, and a long-lived context will eventually auto-compact). `always` clears before every review for isolated rounds; `never` is a legacy alias for the default |
| `CODE_ASSISTANT_PEERS_REVIEWER_STARTUP_MS` | `30000` | how long to wait for the TUI to boot |
| `CODE_ASSISTANT_PEERS_REVIEW_TIMEOUT_MS` | `600000` | per-review deliver timeout |
| `CODE_ASSISTANT_PEERS_REVIEWER_POLL_MS` | `1000` | pane poll interval |

## Read-only safety

The reviewer session launches with `--permission-mode plan` and `Edit/Write/MultiEdit/NotebookEdit`
disallowed → it **cannot modify project files**, even if a reviewed diff contains injected
instructions. tmux does not isolate anything; the read-only permission mode is the safeguard (same
model the existing `claude -p` reviewer uses). It runs in the project dir so it can read the working
state needed to review uncommitted changes.

## How delivery / capture works (and its limits)

- The (large) review prompt is written to a temp file; the worker sends the session a SHORT
  instruction ("read this file, review it, print `PEER-REVIEW-BEGIN-<jobId>`, the review, then
  `PEER-REVIEW-DONE-<jobId>-END`").
- Completion is detected by polling `capture-pane` until **both per-job-unique markers** have been
  emitted (each also appears once in the echoed instruction, so each must appear at least twice).
  The review is the text between the last BEGIN and the last DONE — wrapping the body in two
  markers structurally excludes the echoed instruction, preamble narration, and tool-status
  chrome; `clear-history` per job keeps the scrollback to the current job.
- This scrapes a rendered TUI screen, so capture is **best-effort**: very long reviews, heavy
  repaints, or unusual wrapping can degrade extraction. A wide pane (`-x 400`) and `capture-pane -J`
  (join wrapped lines) mitigate it. If the marker never appears within the timeout, the worker
  reports a job error and the host falls back to `claude -p`.

## Fallback

If the broker or the reviewer worker is unavailable, `runReviewCommand` **falls back to spawning
`claude -p`** (logs the reason to stderr). So the gate degrades to current behavior rather than
failing — at the cost of the credit pool for that one review.

## Model switching on the live session (review_model applied)

`review_model` / `review_models` now apply to live reviewers too. The requested model rides on
the broker job; when it differs from the session's current model, the worker **restarts the
session resuming the same conversation** on the new model — memory preserved, verified live on
all three CLIs:

| CLI | first launch | switch (restart + resume) | session ref |
|---|---|---|---|
| claude | `--session-id <uuid> --model X` | `--resume <uuid> --model Y` | uuid we assign |
| gemini | `--session-id <uuid> -m X` | `-m Y --resume <index>` | per-project list index looked up from our uuid (`--list-sessions`) |
| codex | `-m X` (cannot assign an id) | `codex resume <uuid> -c model=Y` | rollout uuid captured by grepping `~/.codex/sessions` for our unique job marker |

Never `--last`/`latest`: session stores are shared with the user's own sessions (codex is even
machine-global), so only explicit refs are used. If no resumable ref exists (e.g. a reused
user-launched session, or codex before its first review), the switch restarts FRESH and logs
`conversation memory reset`. No model requested / same model = no restart at all.

Submission is echo-verified: a TUI that is still settling after a resume can swallow keystrokes,
so the worker re-sends the instruction (up to 3 times) until its BEGIN marker appears in the pane.

## Session environment isolation

Reviewer TUIs are launched through `env -i` with an explicit allowlist (PATH/HOME/auth vars
etc.) — inheriting the spawning process's environment breaks nested CLIs (observed: Claude
sessions stopped persisting transcripts, which silently broke resume). `ANTHROPIC_API_KEY` is
deliberately NOT allowlisted so claude stays on subscription auth.

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
| concurrency | parallel (fresh process each) | parallel across sessions (reviewer kind × repo); serialized within one session |
| availability | always spawnable | session must be up (else fallback) |
| stability | stable | TUI scraping is best-effort |
