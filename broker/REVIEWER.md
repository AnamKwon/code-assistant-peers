# Channel reviewer — backgrounded live Claude (no `claude -p`)

Lets a **Codex host** (or any host) use **Claude** as a peer reviewer **without spawning
`claude -p`** — so the Claude reviews stay on the **subscription pool**, not the 2026-06-15
programmatic credit pool.

```
host (Codex/…) ──peer review──▶ code-assistant-peers MCP
                                   │  peer = claude-live  (prompt_transport: "channel")
                                   ▼
                              broker (localhost) ──push──▶ 🟦 backgrounded interactive Claude
                                   ◀──── review reply ───────  (read-only, subscription)
                                   ▼
                           runReviewCommand returns it (command = ["<broker>", "claude-live"])
```

## Status

| piece | state |
|---|---|
| `claude-live` adapter (`prompt_transport: "channel"`) | ✅ implemented |
| channel transport client (`shared/broker-client.ts`) | ✅ implemented + tested |
| `runReviewCommand` channel branch **+ fallback to `claude -p`** | ✅ implemented + tested |
| broker daemon (`broker/server.ts`) | ✅ implemented (generic relay) |
| **reviewer bridge → live Claude session (channels)** | ⬜ **needs a live session; research preview** |
| **billing actually = subscription** | ⬜ **must be measured** (see checklist) |

## Setup

1. **Start the broker:**
   ```bash
   CODE_ASSISTANT_PEERS_BROKER_PORT=7899 bun broker/server.ts
   ```
2. **Point the tool at the channel reviewer** — use `claude-live` where you'd use `claude`:
   ```bash
   PEER_ASSISTANTS=claude-live   # or codex,claude-live for multi-peer
   # optional: CODE_ASSISTANT_PEERS_BROKER_URL=http://127.0.0.1:7899
   ```
3. **Run a backgrounded, READ-ONLY interactive Claude reviewer** in the repo dir, connected to
   the broker via a channel bridge (e.g. `louislva/claude-peers-mcp`). It MUST be the
   **interactive** `claude` (NOT `claude -p`) so it stays on the subscription pool, launched
   read-only so it cannot modify files:
   ```bash
   # in tmux/screen (persistent terminal), inside the project dir:
   claude --permission-mode plan \
     --allowedTools 'Read,Grep,Glob,Bash(git status:*),Bash(git diff:*),Bash(git show:*)' \
     --disallowedTools 'Edit,Write,MultiEdit,NotebookEdit'
   # + a channel MCP that: GET /next from the broker, push the prompt into this session,
   #   then POST the review to /jobs/:id/result
   ```
   Requires Claude Code v2.1.80+ and claude.ai (OAuth) login — channels do not work with API-key auth.

## Read-only safety

The reviewer session is launched with `--permission-mode plan` + `Edit/Write/MultiEdit`
disallowed → it **cannot modify project files**, even if a reviewed diff contains injected
instructions. tmux does not isolate anything; the read-only permission mode is the safeguard
(same model the existing `claude -p` reviewer uses). Run it in the project dir so it can read
the working state (needed to review uncommitted changes).

## Fallback

If the broker or the live session is unavailable, `runReviewCommand` **falls back to spawning
`claude -p`** (logs the reason to stderr). So the gate degrades to current behavior rather than
failing — at the cost of the credit pool for that review.

## Verification checklist (the remaining empirical step)

Before relying on this for cost, confirm on a real run:
1. **Round-trip:** a review request reaches the live session and the reply comes back
   (`command` in the stored round is `["<broker>", "claude-live"]`, not a spawned `claude -p`).
2. **No file changes:** `git status` in the project is unchanged after a review.
3. **Billing = subscription:** the reviewer's usage appears under the Claude **subscription**,
   NOT the Agent-SDK/headless credit pool. This is the load-bearing assumption — measure it.

## Tradeoffs vs `claude -p`

| | `claude -p` | channel + live session |
|---|---|---|
| billing | credit pool ❌ | subscription ✅ (assumed; verify) |
| concurrency | parallel (fresh process each) | serialized (one session) |
| availability | always spawnable | session must be up (else fallback) |
| stability | stable | channels = research preview |
