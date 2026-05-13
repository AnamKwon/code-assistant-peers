# mcp-code-assistant-peers

[English](../README.md) | [한국어](README.ko.md) | [中文](README.zh-CN.md)

CLI ベースのコーディングアシスタント同士で相互レビューを行うための MCP サーバーです。

ホスト側アシスタントがコードを変更したあと、このサーバーが設定済みの peer アシスタントに diff のレビューを依頼します。Claude Code と Codex は標準で利用でき、Gemini、GLM、DeepSeek などの CLI も adapter 設定で追加できます。レビューラウンド、finding、task 状態はローカル SQLite に保存され、後続ラウンドで過去の指摘が解決されたか確認できます。

## 主な機能

- Claude Code / Codex の組み込み adapter
- stdin または argv prompt を受け取るカスタム CLI adapter
- コード変更後の mandatory review gate
- `normal`, `adversarial`, `gate`, `collaborative` レビューモード
- reviewer が直接編集せず修正案だけを返す `peer_fix` workflow
- SQLite ベースの task memory、review rounds、findings、async status
- 長いレビュー向けの async review flow
- MCP 登録とローカル診断のための `setup`, `doctor`
- `CLAUDE.md` と `AGENTS.md` の project rule installer

## 要件

- Bun
- Claude Code CLI: `claude`
- OpenAI Codex CLI: `codex`
- 任意: Gemini、GLM、DeepSeek などの追加 LLM CLI
- MCP client が stdio server を起動できる trusted local project

```bash
bun install
bun run check
```

## クイックスタート

ソース checkout からの最短手順:

```bash
bun install
bun run setup
```

または shell wrapper:

```bash
sh scripts/setup.sh
```

デフォルトでは Claude Code と Codex の両方に MCP を登録し、`review_only`, `normal` モード、Codex MCP timeout 600 秒を設定します。

よく使う例:

```bash
# Claude Code のみ登録
bun cli.ts setup claude

# 修正提案付き reviewer と compact gate review
bun cli.ts setup both --workflow=peer_fix --mode=gate

# multi-peer review
bun cli.ts setup both --peers=claude,codex,gemini --mode=adversarial

# 現在の project に CLAUDE.md / AGENTS.md rule を追加
bun cli.ts setup both --install-rules

# 実際には変更せずコマンドだけ表示
bun cli.ts setup both --dry-run
```

セットアップ後、Claude Code / Codex を再起動し、MCP client から `code_assistant_peers_setup` を呼び出して状態を確認してください。

ローカル診断:

```bash
bun cli.ts doctor
```

`doctor` は Bun、Claude CLI、Codex CLI、local review storage、Codex MCP timeout を確認します。

## 手動登録

Claude Code:

```bash
claude mcp add --scope user --transport stdio code-assistant-peers -- env HOST_ASSISTANT=claude bun /path/to/mcp-code-assistant-peers/server.ts
```

Codex:

```bash
codex mcp add code-assistant-peers --env HOST_ASSISTANT=codex -- bun /path/to/mcp-code-assistant-peers/server.ts
```

グローバルインストール後は server binary を利用できます。

```bash
claude mcp add --scope user --transport stdio code-assistant-peers -- env HOST_ASSISTANT=claude code-assistant-peers-server
codex mcp add code-assistant-peers --env HOST_ASSISTANT=codex -- code-assistant-peers-server
```

## Assistant Adapters

組み込み adapter:

```text
claude -> claude -p --permission-mode plan ...
codex  -> codex exec --sandbox read-only --skip-git-repo-check -
```

他の CLI は `CODE_ASSISTANT_PEERS_ASSISTANTS` に JSON で登録します。

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
  }
}'
```

明示的な host/peer:

```bash
HOST_ASSISTANT=gemini PEER_ASSISTANT=codex code-assistant-peers-server
HOST_ASSISTANT=codex PEER_ASSISTANT=gemini code-assistant-peers-server
```

multi-peer review:

```bash
HOST_ASSISTANT=claude PEER_ASSISTANTS=codex,gemini,glm code-assistant-peers-server
```

状態:

- `reviewed`: 利用可能な peer と aggregate pass がすべて成功
- `partial_failed`: 一部 peer が失敗または skipped だが、少なくとも 1 つのレビューが成功
- `review_failed`: 成功した peer review がない、または aggregate pass が失敗

## Codex Timeout

長いレビューは Codex のデフォルト MCP timeout を超えることがあります。推奨設定:

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

setup コマンドはこの timeout を自動で書き込みます。

```bash
bun cli.ts setup codex --timeout=600
```

## Workflow

1. 可能なら変更前に `begin_peer_task`
2. ホスト側アシスタントがコードを変更
3. 最終回答前に `must_call_after_code_changes`
4. サーバーが peer reviewer を実行
5. ホストがレビュー結果を報告し、blocking finding を修正

より強い運用にしたい場合は project rules を追加します。

```bash
bun cli.ts install-rules /path/to/project
```

## Async Reviews

レビューが MCP host timeout を超える可能性がある場合:

1. `start_peer_review_async`
2. `wait_for_peer_review`
3. 必要に応じて polling
4. `get_peer_review_status`

task が `queued` または `running` の間、ホスト側アシスタントは最終回答を返すべきではありません。

## Review Modes

- `normal`: 標準 correctness review
- `adversarial`: より懐疑的な設計・失敗モードレビュー
- `gate`: `ALLOW:` / `BLOCK:` の compact gate
- `collaborative`: peer と host の両視点を比較する高コスト高信頼モード

デフォルト:

```bash
CODE_ASSISTANT_PEERS_REVIEW_MODE=adversarial
```

review focus:

```text
focus: "security and data loss only"
```

または:

```bash
CODE_ASSISTANT_PEERS_REVIEW_FOCUS="migration and rollback risk"
```

## Review Quality Model

レビュー prompt は Codex 風の heuristic に合わせています。

- 作者が実際に直す可能性が高い finding を優先
- reviewed change に紐づく具体的で actionable な bug を要求
- 推測、既存バグ、style-only コメントを避ける
- 狭く有用な line reference
- overall correctness verdict を含める

`gate` mode は first line を `ALLOW:` または `BLOCK:` に保ち、その後に findings、priority、confidence、overall correctness を含む compact JSON summary を要求します。

## Environment Variables

| Name | Default | Description |
| --- | --- | --- |
| `HOST_ASSISTANT` | required | 現在の host assistant id |
| `PEER_ASSISTANT` | inferred | reviewer assistant id |
| `PEER_ASSISTANTS` | unset | multi-peer reviewer id list |
| `CODE_ASSISTANT_PEERS_ASSISTANTS` | built-ins only | custom CLI adapter JSON |
| `CODE_ASSISTANT_PEERS_WORKFLOW` | `review_only` | `review_only` または `peer_fix` |
| `CODE_ASSISTANT_PEERS_REVIEW_MODE` | `normal` | `normal`, `adversarial`, `gate`, `collaborative` |
| `CODE_ASSISTANT_PEERS_REVIEW_FOCUS` | unset | default review focus |
| `CODE_ASSISTANT_PEERS_HOME` | `~/.mcp-code-assistant-peers` | SQLite storage |
| `CODE_ASSISTANT_PEERS_DIFF_BUDGET` | `12000` | diff character budget |
| `CODE_ASSISTANT_PEERS_REVIEW_OUTPUT_BUDGET` | `6000` | tool response character budget |
| `CODE_ASSISTANT_PEERS_ARGV_PROMPT_BUDGET` | `60000` | argv transport prompt limit |
| `CODE_ASSISTANT_PEERS_INCLUDE_SUCCESS_STDERR` | unset | `1` にすると成功した reviewer stderr も MCP response に含める |

## CLI

```bash
bun cli.ts status
bun cli.ts doctor
bun cli.ts tasks
bun cli.ts show <task-id>
bun cli.ts rounds <task-id>
bun cli.ts findings <task-id>
bun cli.ts compact <task-id>
bun cli.ts gc 30
bun cli.ts setup both --workflow=peer_fix --mode=gate --timeout=600
bun cli.ts install-rules /path/to/project
```

## Storage

```text
~/.mcp-code-assistant-peers/store.sqlite
```

## Security

このサーバーはローカル assistant CLI を起動し、repository context を reviewer に渡します。read-only / plan-oriented mode を使いますが、機密コードで使う前に client permission、project trust、sandbox 設定を確認してください。

## License

MIT
