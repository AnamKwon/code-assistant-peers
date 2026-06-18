# mcp-code-assistant-peers

> Parallel peer review for CLI coding agents — fully live, no API keys required.

![AI peer reviewers that never sleep — persistent tmux sessions, parallel reviews, context that sticks](docs/assets/peer-reviewers-overview.png)

Translations: [한국어](docs/README.ko.md) | [日本語](docs/README.ja.md) | [中文](docs/README.zh-CN.md)

---

## What it does

When you edit code with Claude Code, Codex, or Gemini, this MCP gate routes the diff to **multiple independent peer reviewers** running in background tmux sessions. Each reviewer checks the change from a fresh context, findings are saved to SQLite, and the host assistant reads all results directly — no redundant synthesis pass, no extra token cost.

```
Your coding session
  │
  ▼
Host edits code  →  must_call_after_code_changes
                          │
              ┌───────────┼───────────┐
              ▼           ▼           ▼
        codex-live   gemini-live  claude-live    ← parallel, tmux
              │           │           │
              └───────────┴───────────┘
                          │
                    All findings delivered
                    directly to host
                          │
                          ▼
              Host reviews findings & improves code
```

---

## Why live mode?

### Live vs Headless

| | **Live** (`*-live`) | **Headless** |
|---|---|---|
| **Billing** | Subscription pool ✅ | API credit pool ❌ |
| **Auth** | OAuth login — no API key needed | API key required |
| **Session** | Persistent tmux session, warm | New process every call |
| **Review history** | Accumulates — reviewer learns the repo 📈 | Wiped on every call |
| **Parallelism** | All reviewers run concurrently ✅ | Each process blocks the next |
| **Startup** | Instant (session already running) | Cold start every time |
| **Fallback** | Auto-falls back to headless if unavailable | N/A |

**Every reviewer defaults to live mode.** You only need to log in once per CLI:

```bash
claude     # Claude Code login
codex      # Codex login
gemini     # Gemini CLI login — OAuth, no API key needed
```

No API keys. No credit pool charges. Reviews run on your subscription.

---

## Review history (key advantage)

Live sessions **keep conversation history by default**. The reviewer builds up knowledge of your codebase across multiple reviews in the same session:

```
Review #1 → "This function lacks null checking" (learns the codebase)
Review #2 → "Good fix. The same pattern exists on line 42 too." (accumulated knowledge)
Review #3 → "Consistent with the null-check pattern you've been applying" (contextual)
```

Each session is scoped per `(reviewer, repo)` — reviewers for different repos are completely isolated.

To reset history between reviews (old behavior):
```bash
CODE_ASSISTANT_PEERS_REVIEWER_CLEAR=always
```

---

## Quick start

```bash
# 1. Install
bun install

# 2. Auto-detect available CLIs and register MCP
bun cli.ts setup claude --peers=auto

# 3. Verify
bun cli.ts doctor
```

Inside Claude Code or Codex, make any code change — the review gate triggers automatically.

---

## Default configuration

Everything is pre-configured for live mode:

| Setting | Default | Description |
|---|---|---|
| `PEER_ASSISTANTS` | `codex-live,gemini-live,claude-live` | All three as independent peer reviewers |
| History | Keep (never clear) | Reviewers remember previous reviews |
| Host passes | Live session | Self-review uses host's live session |
| `CODE_ASSISTANT_PEERS_WORKFLOW` | `review_only` | Peer reviews and reports findings |
| `CODE_ASSISTANT_PEERS_REVIEW_MODE` | `normal` | Standard review mode |

---

## Review modes

| Mode | Description | Use when |
|---|---|---|
| `normal` | Find bugs, regressions, missing tests | Default |
| `adversarial` | Challenge assumptions aggressively | Security-critical changes |
| `gate` | Binary ALLOW / BLOCK decision | CI gates, pre-merge checks |
| `collaborative` | Host and peer compare perspectives | High-stakes architecture |

```bash
CODE_ASSISTANT_PEERS_REVIEW_MODE=adversarial
```

## Peer workflow modes

| Workflow | Description |
|---|---|
| `review_only` | Peer reviews and reports findings (default) |
| `peer_fix` | Peer proposes concrete fix patches alongside findings |

```bash
CODE_ASSISTANT_PEERS_WORKFLOW=peer_fix
```

---

## Architecture

### Review flow

```
First review in a session
  │
  ▼  Worker creates tmux session → CLI boots (one-time)
  │
  ▼  Review job delivered to session
  │    ├── Reviewer writes .peer-review/<id>-output.md  (primary path)
  │    └── Reviewer also prints to terminal              (fallback)
  │
  ▼  Worker reads result → broker → MCP → host
  │
  ▼  Session stays alive with full history

Next review (same repo)
  │
  ▼  Session already warm — no cold start — instant delivery
```

### Session isolation

Each live session is scoped to `(reviewer_kind, repo_path)`:

```
peer-reviewer-claude-<repo>-<hash>
peer-reviewer-codex-<repo>-<hash>
peer-reviewer-gemini-<repo>-<hash>
```

Watch a live session:
```bash
tmux ls                                              # list all sessions
tmux attach -t peer-reviewer-gemini-myrepo-abc123   # watch gemini think
```

### No aggregate pass

Peer results go **directly to the host** — no intermediate synthesis:

```
Before: peers → aggregate LLM call → host   (extra tokens, extra latency)
Now:    peers → host directly               (zero overhead)
```

The host reads each reviewer's findings and decides what to fix.

---

## Setup

### Auto-setup (recommended)

```bash
bun cli.ts setup claude --peers=auto

# With options
bun cli.ts setup claude --peers=auto --workflow=peer_fix --mode=adversarial
```

### Manual peer selection

```bash
# All three live reviewers
bun cli.ts setup claude --peers=claude-live,codex-live,gemini-live

# Codex only
bun cli.ts setup claude --peers=codex-live
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `HOST_ASSISTANT` | `claude` | The coding agent running the MCP server |
| `PEER_ASSISTANTS` | auto | Comma-separated list of peer reviewer adapters |
| `CODE_ASSISTANT_PEERS_WORKFLOW` | `review_only` | `review_only` or `peer_fix` |
| `CODE_ASSISTANT_PEERS_REVIEW_MODE` | `normal` | `normal`, `adversarial`, `gate`, `collaborative` |
| `CODE_ASSISTANT_PEERS_REVIEWER_CLEAR` | *(keep history)* | `always` to reset before each review |
| `CODE_ASSISTANT_PEERS_LIVE_HOST_REVIEWS` | *(live)* | `0` to force headless for host-side passes |
| `CODE_ASSISTANT_PEERS_REVIEW_TIMEOUT_MS` | `600000` | Per-review timeout (ms) |
| `CODE_ASSISTANT_PEERS_REVIEWER_STARTUP_MS` | `30000` | Session boot timeout (ms) |
| `CODE_ASSISTANT_PEERS_TMUX_SESSION` | `peer-reviewer` | Tmux session name prefix |
| `CODE_ASSISTANT_PEERS_REVIEWER_CWD` | cwd | Repo directory for reviewer sessions |
| `CODE_ASSISTANT_PEERS_DIFF_BUDGET` | `4000` | Max diff characters in review prompt |

---

## Security

Each live session restricts file writes to `.peer-review/` only:

| Reviewer | Write boundary | Mechanism |
|---|---|---|
| `claude-live` | `.peer-review/<hash>/` only | `--allowedTools Write(promptDir:*)` + `--disallowedTools Edit,Write` for project files |
| `gemini-live` | `.peer-review/` only | Admin policy: ALLOW `.peer-review/` (priority 500), DENY elsewhere (priority 100), DENY shell (priority 600) |
| `codex-live` | Workspace (advisory) | `-c instructions` behavioral constraint + `--sandbox workspace-write` |

Shell execution (`run_shell_command`) is hard-denied for gemini-live, preventing prompt-injection via `sed -i`, shell scripts, etc.

---

## Custom adapters

Register any CLI that accepts prompts through stdin or argv:

```json
{
  "my-llm": {
    "id": "my-llm",
    "command": ["my-llm-cli", "--model", "best", "-"],
    "prompt_transport": "stdin",
    "description": "My custom LLM CLI"
  }
}
```

```bash
CODE_ASSISTANT_PEERS_ASSISTANTS='{"my-llm": {...}}' bun server.ts
PEER_ASSISTANTS=my-llm bun server.ts
```

---

## MCP tools

| Tool | When to call | Description |
|---|---|---|
| `begin_peer_task` | Before editing | Captures baseline for the review |
| `must_call_after_code_changes` | **After every edit** | Starts async review, returns immediately |
| `wait_for_peer_review` | After `must_call_after_code_changes` | Polls until complete |
| `get_peer_review_status` | Anytime | Check current status |
| `get_open_findings` | Anytime | List unresolved findings |
| `code_assistant_peers_setup` | Setup verification | Check CLI availability |

### Typical flow

```
1. begin_peer_task                  ← before editing
2. [make code changes]
3. must_call_after_code_changes     ← required after editing
4. wait_for_peer_review             ← repeat until reviewed / partial_failed
5. [read all peer findings, fix issues]
6. must_call_after_code_changes     ← if more edits were made
```

---

## Troubleshooting

### Session not starting

```bash
tmux ls | grep peer-reviewer               # list sessions
tail -f /tmp/code-assistant-peers-backend.log   # worker logs
```

### Gemini login required

```bash
gemini   # Run once and complete OAuth login
```

Next review starts automatically. No API key needed — Gemini subscription covers it.

### Claude billing: API vs subscription

The reviewer session must NOT have `ANTHROPIC_API_KEY` set. If it is set, Claude Code bills the API key regardless of interactive mode.

```bash
# In the reviewer environment, ensure this is unset:
unset ANTHROPIC_API_KEY

# Verify: launch claude and check it shows "Claude Team" or "Pro", not API key mode
claude
```

### Reset review history for a repo

```bash
tmux kill-session -t peer-reviewer-claude-myrepo-abc123
# Next review creates a fresh session
```

### Disable live mode (force headless)

```bash
CODE_ASSISTANT_PEERS_LIVE_HOST_REVIEWS=0   # host-side passes use headless
CODE_ASSISTANT_PEERS_REVIEWER_CLEAR=always  # clear history between reviews
PEER_ASSISTANTS=codex,gemini               # use headless adapters directly
```

---

## Requirements

- [Bun](https://bun.sh) v1.1+
- tmux (for live sessions)
- At least one of: Claude Code CLI, OpenAI Codex CLI, Google Gemini CLI
- Logged in to each CLI you want to use as a reviewer
