# Launch Guide

Use this guide when sharing `mcp-code-assistant-peers` publicly.

## One-Line Pitch

Turn your coding agents into peer reviewers.

## Short Description

`mcp-code-assistant-peers` is an MCP review gate that lets Claude Code, Codex, Gemini, and other CLI coding agents review each other's code changes. It stores review rounds and findings locally, supports async reviews, and can fan out to multiple peer reviewers.

## Longer Description

Single-agent coding workflows are fast, but the same model that wrote the patch can miss its own assumptions. `mcp-code-assistant-peers` adds a local peer-review loop:

1. the host assistant edits code,
2. the MCP gate asks a peer assistant to review the diff,
3. findings are stored in SQLite,
4. the host fixes blocking issues before the final response.

Claude Code and Codex work out of the box, and other prompt-capable CLIs can be added through adapter configuration.

## Demo Script

Record a 60-90 second terminal demo:

1. Run setup:

   ```bash
   bun install
   bun run setup
   bun cli.ts doctor
   ```

2. In Claude Code, ask for a small code change.
3. Let the MCP gate call Codex for review.
4. Show a concrete finding from Codex.
5. Fix the issue and show a passing gate review.

## Suggested GitHub Topics

- `mcp`
- `model-context-protocol`
- `claude-code`
- `codex`
- `gemini`
- `ai-agents`
- `multi-agent`
- `code-review`
- `peer-review`
- `review-gate`

## Show HN Draft

Title:

```text
Show HN: code-assistant-peers, an MCP server that makes coding agents review each other
```

Body:

```text
I built code-assistant-peers, a local MCP review gate for CLI coding agents.

The idea is simple: one assistant edits code, another assistant reviews the diff, and the findings are stored locally so later rounds can verify whether they were fixed.

Claude Code and Codex work out of the box. Gemini, GLM, DeepSeek, and other prompt-capable CLIs can be added through adapter configuration.

It supports:
- mandatory post-edit review tools
- SQLite review memory
- async review status
- multi-peer review through PEER_ASSISTANTS
- normal, adversarial, gate, and collaborative modes

Setup is:

bun install
bun run setup

I built it because I wanted Claude Code and Codex to check each other's blind spots instead of trusting the model that wrote the patch.
```

## X / Twitter Draft

```text
I built code-assistant-peers: an MCP review gate that lets Claude Code, Codex, Gemini, and other CLI coding agents review each other's code changes.

One agent edits.
Another reviews.
Findings are stored locally.
The final answer is gated after edits.

bun install
bun run setup
```

## Reddit Draft

```text
I built an MCP server that lets CLI coding agents review each other's code.

Claude Code and Codex work out of the box. You can also register Gemini/GLM/DeepSeek-style CLIs if they accept prompts through stdin or argv.

The useful part is not just "ask another model." It keeps review rounds and findings in SQLite, supports async reviews for long diffs, and exposes a mandatory post-edit gate tool so coding assistants are nudged to run peer review before final responses.

Repo: https://github.com/AnamKwon/code-assistant-peers
```

## Release Checklist

- [ ] README first screen explains the project in under 10 seconds.
- [ ] `bun run check` passes.
- [ ] Package dry-run includes docs. Use the pack command supported by your Bun version.
- [ ] `bun cli.ts doctor` passes on the maintainer machine.
- [ ] GitHub topics are set.
- [ ] A demo GIF or asciinema recording is attached.
- [ ] `v0.1.0` GitHub release is created.
- [ ] Issues labeled `good first issue` are created.

Pack command examples:

```bash
# Verified in this repository on Bun 1.3.11
bun pm pack --dry-run

# Use this instead if your Bun release exposes top-level pack
bun pack --dry-run
```

## Good First Issues

- Add more built-in assistant adapter examples.
- Add Windows-specific setup documentation.
- Add a sample demo repository with an intentional bug.
- Add a JSON export command for review history.
