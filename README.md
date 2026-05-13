# mcp-code-assistant-peers

MCP server for cross-review workflows between CLI-based coding assistants.

Translations: [한국어](docs/README.ko.md) | [日本語](docs/README.ja.md) | [中文](docs/README.zh-CN.md)

The host assistant implements the requested change, then this server asks a configured peer assistant to review the resulting diff. Claude Code and Codex work out of the box, and additional CLIs such as Gemini, GLM, or DeepSeek can be registered through adapter configuration. Review rounds, findings, and task state are persisted locally so later rounds can verify whether earlier findings were addressed.

## Features

- CLI assistant peer review routing with built-in Claude Code and Codex adapters.
- Custom assistant adapters for CLIs that accept prompts through stdin or argv.
- Mandatory post-edit gate tool with strong MCP descriptions.
- Review modes: `normal`, `adversarial`, `gate`, and `collaborative`.
- Optional `peer_fix` workflow where the reviewer proposes concrete fixes without editing files.
- SQLite-backed task memory, review rounds, findings, and async status.
- Async review flow for long reviews that may exceed MCP host tool-call timeouts.
- Setup helpers for MCP registration and local assistant checks.
- Project rule installer for `CLAUDE.md` and `AGENTS.md`.

## Requirements

- Bun
- Claude Code CLI: `claude` for the built-in Claude adapter
- OpenAI Codex CLI: `codex` for the built-in Codex adapter
- Optional additional LLM CLIs such as Gemini, GLM, or DeepSeek
- A trusted local project where the MCP client is allowed to start stdio servers

Install dependencies:

```bash
bun install
```

Run local checks:

```bash
bun run check
```

For registry-based usage after publishing:

```bash
bun add -g mcp-code-assistant-peers
code-assistant-peers status
```

One-shot usage is also possible:

```bash
bunx mcp-code-assistant-peers status
```

## Quick Start

The easiest path is the setup command. From a source checkout:

```bash
bun install
bun run setup
```

Or run the shell wrapper:

```bash
sh scripts/setup.sh
```

By default this registers the MCP server for both Claude Code and Codex with `review_only`, `normal` mode, and a 600 second Codex MCP tool timeout.

The built-in Claude setup command uses the POSIX `env` command, so the one-step setup flow is intended for macOS/Linux shells. Windows users should manually register the server with equivalent environment variables.

Common variants:

```bash
# Register only Claude Code
bun cli.ts setup claude

# Register both clients with reviewer fix proposals and compact gate reviews
bun cli.ts setup both --workflow=peer_fix --mode=gate

# Configure multi-peer review. Each host removes itself from this list at runtime.
bun cli.ts setup both --peers=claude,codex,gemini --mode=adversarial

# Also install project rules into the current project
bun cli.ts setup both --install-rules

# Print the commands without changing local CLI config
bun cli.ts setup both --dry-run
```

After setup, restart Claude Code/Codex and call `code_assistant_peers_setup` from the MCP client to verify runtime availability.

### Manual Registration

Manual registration is still available if you want full control. Register the same server in each client with `HOST_ASSISTANT` and, when needed, `PEER_ASSISTANT` or `PEER_ASSISTANTS`.

Claude Code:

```bash
claude mcp add --scope user --transport stdio code-assistant-peers -- env HOST_ASSISTANT=claude bun /path/to/mcp-code-assistant-peers/server.ts
```

Codex:

```bash
codex mcp add code-assistant-peers --env HOST_ASSISTANT=codex -- bun /path/to/mcp-code-assistant-peers/server.ts
```

If installed globally from a registry, use the server binary instead of a local path:

```bash
claude mcp add --scope user --transport stdio code-assistant-peers -- env HOST_ASSISTANT=claude code-assistant-peers-server
codex mcp add code-assistant-peers --env HOST_ASSISTANT=codex -- code-assistant-peers-server
```

Verify the server can start:

```bash
env HOST_ASSISTANT=codex bun server.ts
```

Check installed dependencies from an MCP client by calling:

```text
code_assistant_peers_setup
```

You can also run local diagnostics without opening an MCP client:

```bash
bun cli.ts doctor
```

`doctor` checks Bun, Claude CLI, Codex CLI, local review storage, and the recommended Codex MCP timeout.

## Assistant Adapters

Claude and Codex are built in:

```text
claude -> claude -p --permission-mode plan ...
codex  -> codex exec --sandbox read-only --skip-git-repo-check -
```

For other CLIs, set `CODE_ASSISTANT_PEERS_ASSISTANTS` to a JSON object. Each adapter needs:

- `command`: argv array used to launch the assistant.
- `prompt_transport`: `stdin` or `argv`.
- `description`: optional human-readable label.

Example:

```bash
export CODE_ASSISTANT_PEERS_ASSISTANTS='{
  "gemini": {
    "command": ["gemini", "-p"],
    "prompt_transport": "argv",
    "description": "Gemini CLI prompt mode"
  },
  "glm": {
    "command": ["glm", "chat"],
    "prompt_transport": "stdin"
  },
  "deepseek": {
    "command": ["deepseek", "chat"],
    "prompt_transport": "stdin"
  }
}'
```

Then choose the host and peer:

```bash
HOST_ASSISTANT=gemini PEER_ASSISTANT=codex code-assistant-peers-server
HOST_ASSISTANT=codex PEER_ASSISTANT=gemini code-assistant-peers-server
```

If `PEER_ASSISTANT` is omitted, `claude` pairs with `codex`, `codex` pairs with `claude`, and custom hosts use the first other registered adapter.

For multi-peer review, set `PEER_ASSISTANTS` to a comma-separated list. When this variable is present, it takes precedence over `PEER_ASSISTANT`. The server removes the host from the list, checks which peer CLIs are available, sends reviews to the available peers, and stores one review round per reviewer plus a final aggregate round.

```bash
HOST_ASSISTANT=claude PEER_ASSISTANTS=codex,gemini,glm code-assistant-peers-server
```

Multi-peer outcomes:

- `reviewed`: every available peer and the aggregate pass succeeded.
- `partial_failed`: at least one peer was skipped or failed, but at least one review succeeded.
- `review_failed`: no peer review succeeded, or the aggregate pass failed.

Custom adapters cannot override built-in ids (`claude` and `codex`). Use a distinct id such as `claude-custom` when experimenting with a different command.

Prefer `stdin` transport for code review CLIs when possible. Review prompts can include large diffs; `argv` transport is convenient for prompt flags such as `gemini -p`, but it is subject to operating-system argument length limits. The server refuses argv prompts above `CODE_ASSISTANT_PEERS_ARGV_PROMPT_BUDGET` to fail with a clear error instead of an opaque process spawn failure.

## Recommended Codex Timeout

Long reviews can exceed Codex's default MCP tool timeout. Codex supports per-server MCP timeouts in `~/.codex/config.toml`:

```toml
[mcp_servers.code-assistant-peers]
command = "bun"
args = ["/path/to/mcp-code-assistant-peers/server.ts"]
startup_timeout_sec = 30
tool_timeout_sec = 600

[mcp_servers.code-assistant-peers.env]
HOST_ASSISTANT = "codex"
CODE_ASSISTANT_PEERS_WORKFLOW = "peer_fix"
CODE_ASSISTANT_PEERS_REVIEW_MODE = "normal"
```

Restart Codex after editing the config.

The setup command writes this timeout automatically for Codex:

```bash
bun cli.ts setup codex --timeout=600
```

## Workflow

1. The host assistant calls `begin_peer_task` before editing when feasible.
2. The host assistant implements the requested change.
3. The host assistant calls `must_call_after_code_changes` before the final answer.
4. The server runs the opposite reviewer:
   - Claude host uses Codex in read-only exec mode.
   - Codex host uses Claude print mode with read-only tools.
   - Custom hosts use the configured `PEER_ASSISTANT` adapter.
5. The host assistant reports the peer review result and fixes any blocking findings.

MCP cannot technically force every final answer through a tool call. For stronger behavior, install project rules:

```bash
bun cli.ts install-rules /path/to/project
```

This creates or updates `CLAUDE.md` and `AGENTS.md` with instructions requiring the MCP gate after edits. Preview the rule:

```bash
bun cli.ts rules
```

## Async Reviews

Use async review tools when a review may exceed the host MCP timeout:

1. `start_peer_review_async` stores the task as `queued`, starts the review in the background, and returns immediately.
2. The background review updates SQLite to `running`, then `reviewed` or `review_failed`.
3. `wait_for_peer_review` polls for a bounded time. Repeat it until the task reaches a terminal state.
4. `get_peer_review_status` returns the current task status, latest round preview, and open findings.

The host assistant should not give the final response while the async task is still `queued` or `running`.

## Review Modes

`normal`: standard correctness review.

`adversarial`: skeptical design and failure-mode review.

`gate`: compact `ALLOW:` or `BLOCK:` result for final-response gating.

`collaborative`: both CLIs participate. The peer reviewer first reviews skeptically, then the host-side reviewer compares the peer review, defends reasonable choices, rejects false positives, and produces a combined review. This is more expensive because it runs multiple model passes, so it is not the default.

Set a default mode:

```bash
CODE_ASSISTANT_PEERS_REVIEW_MODE=adversarial
```

Per-call `mode` arguments override the environment default.

You can also narrow a review with a focus:

```text
focus: "security and data loss only"
```

or set a default:

```bash
CODE_ASSISTANT_PEERS_REVIEW_FOCUS="migration and rollback risk"
```

## Review Quality Model

The reviewer prompt is aligned with Codex-style review heuristics:

- Prefer findings the author would actually fix.
- Require concrete, actionable bugs tied to the reviewed change.
- Avoid speculative issues, pre-existing defects, and style-only comments.
- Keep line references narrow and useful.
- End with an overall correctness verdict.

`gate` mode keeps the first line as `ALLOW:` or `BLOCK:` and then asks the reviewer for a compact JSON summary containing findings, priority, confidence, and overall correctness. This keeps final gates easy to parse while preserving enough context for humans.

Compared with similar review plugins and MCP servers, this project now includes:

- local `doctor` diagnostics for setup drift and Codex timeout issues,
- per-review `focus` controls inspired by review/delegation plugins,
- persistent review rounds and findings,
- multi-peer fan-out through `PEER_ASSISTANTS`,
- async status tools for long-running reviews.

## Workflows

`review_only`: the peer only reviews.

`peer_fix`: the peer still cannot edit files, but it should include concrete fix proposals or patch-style guidance.

Set a default workflow:

```bash
CODE_ASSISTANT_PEERS_WORKFLOW=peer_fix
```

Switch registered MCP mode/workflow:

```bash
bun cli.ts apply-mode claude adversarial
bun cli.ts apply-mode codex gate peer_fix
bun cli.ts apply-mode both collaborative peer_fix
```

Generate commands without applying them:

```bash
bun cli.ts mode-command both collaborative peer_fix
bun cli.ts reinstall-command codex review_only gate
```

## Tools

Primary workflow tools:

- `begin_peer_task`
- `must_call_after_code_changes`
- `finalize_code_changes_with_peer_review`
- `verify_code_changes_after_edit`
- `request_peer_review`

Async workflow tools:

- `start_peer_review_async`
- `wait_for_peer_review`
- `get_peer_review_status`

Review memory tools:

- `peer_task_status`
- `get_peer_task_context`
- `list_peer_review_rounds`
- `get_peer_review_round`
- `get_open_findings`
- `record_peer_review`
- `compact_peer_history`
- `gc_peer_store`

Setup tool:

- `code_assistant_peers_setup`

## Persistent Storage

Task and review memory are stored in SQLite:

```text
~/.mcp-code-assistant-peers/store.sqlite
```

The store includes:

- task metadata and status
- baseline/current review context
- review rounds
- structured findings
- compacted task summaries

Override the store location:

```bash
CODE_ASSISTANT_PEERS_HOME=/path/to/store
```

## Environment Variables

| Name | Default | Description |
| --- | --- | --- |
| `HOST_ASSISTANT` | required | Assistant id for the current host, for example `claude`, `codex`, `gemini`, `glm`, or `deepseek`. |
| `PEER_ASSISTANT` | inferred | Assistant id for the reviewer. Required for explicit custom pairings. |
| `PEER_ASSISTANTS` | unset | Comma-separated reviewer ids for multi-peer review. Takes precedence over `PEER_ASSISTANT`. |
| `CODE_ASSISTANT_PEERS_ASSISTANTS` | built-ins only | JSON object defining custom CLI assistant adapters. |
| `CODE_ASSISTANT_PEERS_WORKFLOW` | `review_only` | `review_only` or `peer_fix`. |
| `CODE_ASSISTANT_PEERS_REVIEW_MODE` | `normal` | `normal`, `adversarial`, `gate`, or `collaborative`. |
| `CODE_ASSISTANT_PEERS_REVIEW_FOCUS` | unset | Optional default review focus, such as security, data loss, migration risk, UI regressions, or performance. |
| `CODE_ASSISTANT_PEERS_HOME` | `~/.mcp-code-assistant-peers` | SQLite and task mirror directory. |
| `CODE_ASSISTANT_PEERS_DIFF_BUDGET` | `12000` | Character budget for included diffs. |
| `CODE_ASSISTANT_PEERS_REVIEW_OUTPUT_BUDGET` | `6000` | Character budget for tool responses. |
| `CODE_ASSISTANT_PEERS_ARGV_PROMPT_BUDGET` | `60000` | Maximum prompt size for custom adapters using `prompt_transport: "argv"`. |
| `CODE_ASSISTANT_PEERS_INCLUDE_SUCCESS_STDERR` | unset | Set `1` to include successful reviewer stderr in MCP responses. |

## CLI

```bash
bun cli.ts status
bun cli.ts tasks
bun cli.ts show <task-id>
bun cli.ts rounds <task-id>
bun cli.ts findings <task-id>
bun cli.ts compact <task-id>
bun cli.ts gc 30
bun cli.ts env peer_fix claude collaborative
bun cli.ts install-command claude peer_fix adversarial
bun cli.ts reinstall-command codex review_only gate
bun cli.ts mode-command both collaborative peer_fix
bun cli.ts apply-mode both collaborative peer_fix
bun cli.ts setup both --workflow=peer_fix --mode=gate --timeout=600
bun cli.ts rules
bun cli.ts install-rules /path/to/project
```

## Project Layout

```text
server.ts              MCP stdio server and tool handlers
cli.ts                 setup/status/mode management CLI
shared/git.ts          git status and diff helpers
shared/review.ts       reviewer prompts and CLI invocation
shared/assistants.ts   assistant adapter registry
shared/store.ts        SQLite persistence
shared/types.ts        shared TypeScript types
test/                  Bun test suite
```

## Packaging Notes

This package exposes two binaries:

- `code-assistant-peers`: management CLI
- `code-assistant-peers-server`: MCP stdio server

The scripts use Bun via shebangs, so Bun must be available on the user's `PATH`.

## Security

This server launches local assistant CLIs and passes repository context to them for review. It tries to use read-only or plan-oriented reviewer modes, but users should still review their local client permissions, project trust settings, and sandbox configuration before using it on sensitive code.

See `SECURITY.md` for reporting guidance.

## Development

```bash
bun install
bun run typecheck
bun test
```

## License

MIT
