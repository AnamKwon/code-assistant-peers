# mcp-code-assistant-peers

[English](../README.md) | [한국어](README.ko.md) | [日本語](README.ja.md)

这是一个 MCP 服务器，用于在基于 CLI 的编码助手之间建立交叉代码审查流程。

主助手完成代码修改后，本服务器会把 diff 发送给已配置的 peer 助手进行审查。Claude Code 和 Codex 内置支持，也可以通过 adapter 配置接入 Gemini、GLM、DeepSeek 等 CLI。审查轮次、findings 和 task 状态会保存在本地 SQLite 中，后续轮次可以验证之前的问题是否已经解决。

![mcp-code-assistant-peers architecture](assets/architecture.svg)

## 使用流程

![peer review gate demo](assets/peer-review-demo.gif)

1. 主助手修改代码。
2. MCP gate 将 diff 和 context 发送给 peer reviewer CLI。
3. reviewer findings 和状态保存到 SQLite。
4. 主助手修复 blocking findings，再次通过 gate 后给出最终回复。

## 功能

- 内置 Claude Code / Codex adapter
- 支持通过 stdin 或 argv 接收 prompt 的自定义 CLI adapter
- 代码修改后的 mandatory review gate
- `normal`, `adversarial`, `gate`, `collaborative` 审查模式
- `peer_fix` workflow：reviewer 只提出修复建议，不直接编辑文件
- SQLite 持久化 task memory、review rounds、findings、async status
- 用于避免 MCP host timeout 的 async-first review flow
- 用于 MCP 注册和本地诊断的 `setup`, `doctor`
- `CLAUDE.md` 和 `AGENTS.md` project rule installer

## 要求

- Bun
- Claude Code CLI: `claude`
- OpenAI Codex CLI: `codex`
- 可选：Gemini、GLM、DeepSeek 等 LLM CLI
- 允许 MCP client 启动 stdio server 的 trusted local project

```bash
bun install
bun run check
```

## 快速开始

从源码 checkout 开始：

```bash
bun install
bun run setup
```

或使用 shell wrapper：

```bash
sh scripts/setup.sh
```

默认会为 Claude Code 和 Codex 都注册 MCP server，使用 `review_only`、`normal` 模式，并将 Codex MCP timeout 设置为 600 秒。

常用示例：

```bash
# 只注册 Claude Code
bun cli.ts setup claude

# 让 reviewer 返回修复建议，并使用 compact gate review
bun cli.ts setup both --workflow=peer_fix --mode=gate

# 配置 multi-peer review
bun cli.ts setup both --peers=claude,codex,gemini --mode=adversarial

# 在当前项目安装 CLAUDE.md / AGENTS.md rules
bun cli.ts setup both --install-rules

# 只打印命令，不修改本地配置
bun cli.ts setup both --dry-run
```

设置完成后，重启 Claude Code/Codex，并在 MCP client 中调用 `code_assistant_peers_setup` 验证运行状态。

本地诊断：

```bash
bun cli.ts doctor
```

`doctor` 会检查 Bun、Claude CLI、Codex CLI、Gemini CLI、本地 review storage 和 Codex MCP timeout。

## 手动注册

Claude Code:

```bash
claude mcp add --scope user --transport stdio code-assistant-peers -- env HOST_ASSISTANT=claude bun /path/to/mcp-code-assistant-peers/server.ts
```

Codex:

```bash
codex mcp add code-assistant-peers --env HOST_ASSISTANT=codex -- bun /path/to/mcp-code-assistant-peers/server.ts
```

全局安装后可以使用 server binary：

```bash
claude mcp add --scope user --transport stdio code-assistant-peers -- env HOST_ASSISTANT=claude code-assistant-peers-server
codex mcp add code-assistant-peers --env HOST_ASSISTANT=codex -- code-assistant-peers-server
```

## Assistant Adapters

内置 adapter：

```text
claude -> claude -p --permission-mode plan ...
codex  -> codex exec --sandbox read-only --skip-git-repo-check -
gemini -> gemini --skip-trust --approval-mode plan -p ""  # 提示词通过 stdin 传入
```

其他 CLI 可以通过 `CODE_ASSISTANT_PEERS_ASSISTANTS` 注册：

```bash
export CODE_ASSISTANT_PEERS_ASSISTANTS='{
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

指定 host/peer：

```bash
HOST_ASSISTANT=gemini PEER_ASSISTANT=codex code-assistant-peers-server
HOST_ASSISTANT=codex PEER_ASSISTANT=gemini code-assistant-peers-server
```

multi-peer review：

```bash
HOST_ASSISTANT=claude PEER_ASSISTANTS=codex,gemini,glm code-assistant-peers-server
```

结果状态：

- `reviewed`: 所有可用 peer 和 aggregate pass 都成功
- `partial_failed`: 至少一个 review 成功，但部分 peer 失败或 skipped
- `review_failed`: 没有 peer review 成功，或 aggregate pass 失败

## Codex Timeout

长审查可能超过 Codex 默认 MCP timeout。推荐配置：

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

setup 命令会自动写入该 timeout：

```bash
bun cli.ts setup codex --timeout=600
```

## Workflow

1. 尽可能在修改前调用 `begin_peer_task`
2. host assistant 修改代码
3. 最终回答前调用 `must_call_after_code_changes`
4. server 启动 async peer review job，或复用正在运行的 job
5. 通过 `wait_for_peer_review` 或 `get_peer_review_status` 等到 terminal 状态
6. host 汇报审查结果，并修复 blocking findings

如果希望更强约束，可以安装 project rules：

```bash
bun cli.ts install-rules /path/to/project
```

## Async Reviews

所有 post-edit review gate 都是 async-first。这样可以避免长审查触发 MCP host timeout；如果同一个 task 已经是 `queued` 或 `running`，也不会启动重复的 reviewer process。

1. `must_call_after_code_changes`、`finalize_code_changes_with_peer_review`、`verify_code_changes_after_edit`、`request_peer_review`、`start_peer_review_async` 会把 task 保存为 `queued`，并启动 background review。
2. background review 会把 SQLite 状态更新为 `running`，随后更新为 `reviewed`/`partial_failed`/`review_failed`。
3. 使用 `wait_for_peer_review` 进行 bounded polling。
4. 使用 `get_peer_review_status` 查看状态、最新 round 和 open findings。

当 task 仍是 `queued` 或 `running` 时，host assistant 不应给出最终回答。

## Review Modes

- `normal`: 标准 correctness review
- `adversarial`: 更严格的设计和失败模式审查
- `gate`: `ALLOW:` / `BLOCK:` compact gate
- `collaborative`: peer 与 host 两个视角对比后生成最终审查，token 成本更高

默认模式：

```bash
CODE_ASSISTANT_PEERS_REVIEW_MODE=adversarial
```

review focus：

```text
focus: "security and data loss only"
```

或：

```bash
CODE_ASSISTANT_PEERS_REVIEW_FOCUS="migration and rollback risk"
```

## Review Quality Model

review prompt 与 Codex 风格的 review heuristic 对齐：

- 优先报告作者确实会修的问题
- 要求与 reviewed change 直接相关、具体、可行动的 bug
- 避免猜测性问题、既有问题、纯风格评论
- 使用窄而有用的 line reference
- 包含 overall correctness verdict

`gate` mode 保持首行为 `ALLOW:` 或 `BLOCK:`，随后要求包含 findings、priority、confidence 和 overall correctness 的 compact JSON summary。

## Environment Variables

| Name | Default | Description |
| --- | --- | --- |
| `HOST_ASSISTANT` | required | 当前 host assistant id |
| `PEER_ASSISTANT` | inferred | reviewer assistant id |
| `PEER_ASSISTANTS` | unset | multi-peer reviewer id 列表 |
| `CODE_ASSISTANT_PEERS_ASSISTANTS` | built-ins only | custom CLI adapter JSON |
| `CODE_ASSISTANT_PEERS_WORKFLOW` | `review_only` | `review_only` 或 `peer_fix` |
| `CODE_ASSISTANT_PEERS_REVIEW_MODE` | `normal` | `normal`, `adversarial`, `gate`, `collaborative` |
| `CODE_ASSISTANT_PEERS_REVIEW_FOCUS` | unset | 默认 review focus |
| `CODE_ASSISTANT_PEERS_HOME` | `~/.mcp-code-assistant-peers` | SQLite storage |
| `CODE_ASSISTANT_PEERS_DIFF_BUDGET` | `12000` | diff 字符预算 |
| `CODE_ASSISTANT_PEERS_REVIEW_OUTPUT_BUDGET` | `6000` | tool response 字符预算 |
| `CODE_ASSISTANT_PEERS_REVIEW_TIMEOUT_MS` | adapter default, otherwise `600000` | reviewer CLI process hard timeout. Built-in Gemini uses `180000` |
| `CODE_ASSISTANT_PEERS_ARGV_PROMPT_BUDGET` | `60000` | argv transport prompt 限制 |
| `CODE_ASSISTANT_PEERS_INCLUDE_SUCCESS_STDERR` | unset | 设置为 `1` 时，在 MCP response 中包含成功 reviewer 的 stderr |

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

本服务器会启动本地 assistant CLI，并把 repository context 传给 reviewer。虽然会尽量使用 read-only / plan-oriented mode，但在敏感代码上使用前，仍应检查 client permission、project trust 和 sandbox 配置。

## License

MIT
