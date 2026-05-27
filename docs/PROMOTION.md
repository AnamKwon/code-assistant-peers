# Promotion Strategy

Use this document to promote `mcp-code-assistant-peers` without rewriting copy for each channel.

## Goal

Make developers who already use Claude Code, Codex, Gemini CLI, or other terminal coding agents understand one idea quickly:

> Your coding agent should not be the only reviewer of its own patch.

The first conversion target is not enterprise procurement. It is an individual developer installing the package, wiring it into Codex or Claude Code, and seeing a second assistant catch one concrete issue.

## Positioning

`mcp-code-assistant-peers` is a local MCP review gate for CLI coding agents. One assistant edits code, another assistant reviews the diff, and review rounds are stored locally so the host can fix blocking findings before giving the final answer.

Use this positioning consistently:

- **Category:** local MCP review gate for coding agents
- **Audience:** developers using Claude Code, Codex, Gemini CLI, or multiple CLI agents
- **Problem:** the model that wrote a patch often misses its own assumptions
- **Promise:** make another assistant review the change before the final answer
- **Proof:** async review gates, SQLite review memory, multi-peer support, npm install

## Primary Links

Use these links in promotion posts:

```text
GitHub: https://github.com/AnamKwon/code-assistant-peers
npm: https://www.npmjs.com/package/mcp-code-assistant-peers
Install:

Choose one setup path.

For Codex:
curl -fsSL https://bun.sh/install | bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
npm install -g mcp-code-assistant-peers
code-assistant-peers setup codex --peers=auto

For Claude Code:
curl -fsSL https://bun.sh/install | bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
npm install -g mcp-code-assistant-peers
code-assistant-peers setup claude --peers=auto

Then restart the configured MCP client, Codex or Claude Code, and call `code_assistant_peers_setup` from that client to verify the registered server.
```

Use `code-assistant-peers` as the primary command in setup instructions. `mcp-code-assistant-peers` is available as the package-name CLI alias and is useful for read-only `npx` commands, but global install plus `code-assistant-peers setup ...` is the clearest setup path.

## Launch Order

1. Update GitHub README and push the current branch.
2. Create a GitHub release for the current npm version.
3. Post to X/Twitter with the demo GIF.
4. Post to LinkedIn with a more practical engineering angle.
5. Post to Hacker News as a Show HN.
6. Post to Reddit communities only where self-promotion is allowed.
7. Share in MCP, Claude Code, Codex, and local AI developer Discord/Slack groups.
8. Follow up 24-48 hours later with a short technical thread showing one real finding caught by the peer reviewer.

## Messaging Rules

- Lead with the problem, not the MCP implementation.
- Show the loop: edit, review, fix, pass.
- Avoid claiming it makes code correct. Say it adds a second reviewer and persistent review memory.
- Be clear that the current npm package uses Bun at runtime.
- For `setup`, recommend global npm install or source checkout, not `npx`, because MCP registration needs a stable server path.

## Expanded Campaign Message: English

Use this longer message when a community expects more context than a short launch post. It is designed for LinkedIn, Reddit, GitHub Discussions, Discord announcements, and blog-style posts.

```text
I built mcp-code-assistant-peers because local AI coding workflows are getting fast enough that review is becoming the bottleneck.

Claude Code, Codex, Gemini CLI, and similar tools can produce useful patches quickly. The problem is that the assistant that wrote the patch is often the least reliable reviewer of its own assumptions. It may miss an edge case, skip a migration detail, forget a test path, or explain a change more confidently than the evidence supports.

mcp-code-assistant-peers adds a local peer-review gate for that workflow.

The loop is:

1. one coding assistant edits the code,
2. another assistant reviews the diff or workspace context,
3. review findings are stored locally in SQLite,
4. the host assistant fixes blocking issues,
5. the host workflow is instructed to handle the review gate before giving the final answer.

It is not trying to replace human review. It is meant to catch issues earlier, especially in the messy local phase before a PR exists.

What it supports:

- Claude Code and Codex out of the box
- Gemini-style and custom CLI adapters
- async review gates, so long reviews do not block the MCP host
- SQLite review memory across review rounds
- multi-peer review
- normal, adversarial, gate, and collaborative review modes
- non-git workspace fallback context when a normal git diff is unavailable

The most useful moment is simple: your assistant finishes a code change, then another assistant gets a chance to say, "this condition is wrong", "this migration path is missing", or "this install step will fail for users who only have one client installed."

That second opinion is not perfect, but it is structured, repeatable, and saved locally.

Install:

Choose one setup path.

For Codex:

curl -fsSL https://bun.sh/install | bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
npm install -g mcp-code-assistant-peers
code-assistant-peers setup codex --peers=auto

For Claude Code:

curl -fsSL https://bun.sh/install | bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
npm install -g mcp-code-assistant-peers
code-assistant-peers setup claude --peers=auto

Then restart the configured MCP client, Codex or Claude Code, and call `code_assistant_peers_setup` from that client to verify the registered server.

GitHub:
https://github.com/AnamKwon/code-assistant-peers

npm:
https://www.npmjs.com/package/mcp-code-assistant-peers

I would like feedback from developers already using more than one coding agent locally. The most useful feedback is: where did setup break, what did the reviewer catch, and where did it produce noise?
```

## Expanded Campaign Message: Korean Translation

This is the Korean translation of the message above. Use it to understand the English copy, or post it directly in Korean communities.

```text
로컬 AI 코딩 워크플로우가 충분히 빨라지면서, 이제 병목은 코드 작성보다 리뷰 쪽에 가까워지고 있다고 느껴서 mcp-code-assistant-peers를 만들었습니다.

Claude Code, Codex, Gemini CLI 같은 도구들은 유용한 패치를 빠르게 만들어냅니다. 문제는 그 패치를 작성한 같은 어시스턴트가 자기 자신의 가정을 리뷰할 때 가장 취약할 수 있다는 점입니다. 엣지 케이스를 놓치거나, 마이그레이션 경로를 빠뜨리거나, 테스트 경로를 확인하지 않거나, 실제 근거보다 더 확신 있게 변경을 설명할 수 있습니다.

mcp-code-assistant-peers는 이 워크플로우에 로컬 peer-review gate를 추가합니다.

흐름은 다음과 같습니다.

1. 한 코딩 어시스턴트가 코드를 수정합니다.
2. 다른 어시스턴트가 diff 또는 workspace context를 리뷰합니다.
3. 리뷰 finding은 로컬 SQLite에 저장됩니다.
4. host assistant가 blocking issue를 수정합니다.
5. host workflow는 최종 답변 전에 review gate를 처리하도록 안내됩니다.

이 도구는 사람의 코드 리뷰를 대체하려는 것이 아닙니다. PR이 만들어지기 전, 로컬에서 빠르게 수정하고 검토하는 지저분한 단계에서 문제를 더 일찍 잡기 위한 도구입니다.

지원하는 것:

- Claude Code와 Codex 기본 지원
- Gemini 스타일 CLI와 custom CLI adapter
- 긴 리뷰가 MCP host를 막지 않도록 하는 async review gate
- 리뷰 라운드 간 finding을 저장하는 SQLite review memory
- multi-peer review
- normal, adversarial, gate, collaborative review mode
- 일반 git diff가 없을 때 사용하는 non-git workspace fallback context

가장 유용한 순간은 단순합니다. 어시스턴트가 코드 변경을 끝낸 뒤, 다른 어시스턴트가 한 번 더 보고 "이 조건이 틀렸다", "이 마이그레이션 경로가 빠졌다", "한쪽 클라이언트만 설치한 사용자에게 이 설치 단계는 실패한다"라고 말해주는 것입니다.

그 두 번째 의견이 완벽한 것은 아니지만, 구조화되어 있고 반복 가능하며 로컬에 기록됩니다.

설치:

아래 중 하나만 선택하세요.

Codex를 쓰는 경우:

curl -fsSL https://bun.sh/install | bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
npm install -g mcp-code-assistant-peers
code-assistant-peers setup codex --peers=auto

Claude Code를 쓰는 경우:

curl -fsSL https://bun.sh/install | bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
npm install -g mcp-code-assistant-peers
code-assistant-peers setup claude --peers=auto

그다음 설정한 MCP 클라이언트, Codex 또는 Claude Code를 재시작하고, 해당 클라이언트에서 `code_assistant_peers_setup`을 호출해 등록된 서버를 확인하면 됩니다.

GitHub:
https://github.com/AnamKwon/code-assistant-peers

npm:
https://www.npmjs.com/package/mcp-code-assistant-peers

로컬에서 여러 코딩 에이전트를 함께 쓰고 있는 개발자들의 피드백을 받고 싶습니다. 특히 어디서 설치가 막혔는지, reviewer가 실제로 무엇을 잡았는지, 어디서 노이즈가 발생했는지가 가장 도움이 됩니다.
```

## Product Story Angles

Use one of these angles depending on the community.

### English

```text
Angle 1: Review before the PR
Most AI coding mistakes are cheapest to catch before a pull request exists. mcp-code-assistant-peers adds a local review gate right after the assistant edits code.

Angle 2: Do not let one model grade its own homework
The assistant that wrote the patch can miss its own assumptions. This tool lets another coding assistant review the change and stores the findings locally.

Angle 3: Practical multi-agent workflow
This is not a demo of agents talking in circles. It is a narrow workflow: edit, review, fix, verify, then answer.

Angle 4: Local-first review memory
Review rounds and findings are saved in local SQLite, so follow-up review gates can check whether earlier findings were actually addressed.
```

### Korean Translation

```text
관점 1: PR 전에 리뷰하기
AI 코딩 실수는 PR을 만들기 전에 잡는 것이 가장 비용이 적습니다. mcp-code-assistant-peers는 어시스턴트가 코드를 수정한 직후 로컬 review gate를 추가합니다.

관점 2: 한 모델이 자기 숙제를 채점하게 두지 않기
패치를 작성한 어시스턴트는 자기 자신의 가정을 놓칠 수 있습니다. 이 도구는 다른 코딩 어시스턴트가 변경사항을 리뷰하게 하고 finding을 로컬에 저장합니다.

관점 3: 실용적인 multi-agent workflow
이것은 에이전트들이 의미 없이 대화하는 데모가 아닙니다. edit, review, fix, verify, answer로 이어지는 좁고 실용적인 워크플로우입니다.

관점 4: Local-first review memory
리뷰 라운드와 finding은 로컬 SQLite에 저장됩니다. 그래서 이후 review gate가 이전 finding이 실제로 해결됐는지 확인할 수 있습니다.
```

## Copy-Paste: Short Tagline

```text
Turn your coding agents into peer reviewers.
```

## Copy-Paste: One-Sentence Pitch

```text
mcp-code-assistant-peers is a local MCP review gate that lets Claude Code, Codex, Gemini, and other CLI coding agents review each other's code changes before the final answer.
```

## Copy-Paste: 30-Second Pitch

```text
Single-agent coding workflows are fast, but the same model that wrote a patch can miss its own assumptions.

mcp-code-assistant-peers adds a local peer-review loop:

1. one assistant edits code,
2. another assistant reviews the diff,
3. findings are stored locally,
4. the host fixes blocking issues before the final answer.

It supports Claude Code, Codex, Gemini-style CLIs, async review gates, SQLite review memory, and multi-peer review.

GitHub: https://github.com/AnamKwon/code-assistant-peers
npm: https://www.npmjs.com/package/mcp-code-assistant-peers
```

## Copy-Paste: Install Snippet

```text
Install:

Choose one setup path.

For Codex:

curl -fsSL https://bun.sh/install | bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
npm install -g mcp-code-assistant-peers
code-assistant-peers setup codex --peers=auto

For Claude Code:

curl -fsSL https://bun.sh/install | bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
npm install -g mcp-code-assistant-peers
code-assistant-peers setup claude --peers=auto

Then restart the configured MCP client, Codex or Claude Code, and call `code_assistant_peers_setup` from that client to verify the registered server.

Package:
https://www.npmjs.com/package/mcp-code-assistant-peers
```

## Copy-Paste: X / Twitter Short Post

```text
I built mcp-code-assistant-peers.

It turns CLI coding agents into peer reviewers:

One agent edits.
Another reviews.
Findings are stored locally.
The final answer is gated after code changes.

Works with Claude Code, Codex, Gemini-style CLIs, and MCP.

npm: https://www.npmjs.com/package/mcp-code-assistant-peers
GitHub: https://github.com/AnamKwon/code-assistant-peers
```

## Copy-Paste: X / Twitter Thread

```text
1/ I built mcp-code-assistant-peers: a local MCP review gate for CLI coding agents.

The idea is simple:
the assistant that wrote the code should not be the only reviewer of its own patch.

2/ The workflow:

- Claude Code or Codex edits code
- mcp-code-assistant-peers captures the review context
- another assistant reviews the diff
- findings are saved locally
- the host fixes blocking issues before the final answer

3/ It supports:

- Claude Code and Codex out of the box
- Gemini and other prompt-capable CLIs through adapters
- async review gates
- SQLite review memory
- multi-peer review
- normal, adversarial, gate, and collaborative modes

4/ Install:

Choose one setup path.

For Codex:

curl -fsSL https://bun.sh/install | bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
npm install -g mcp-code-assistant-peers
code-assistant-peers setup codex --peers=auto

For Claude Code:

curl -fsSL https://bun.sh/install | bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
npm install -g mcp-code-assistant-peers
code-assistant-peers setup claude --peers=auto

Then restart the configured MCP client, Codex or Claude Code, and call `code_assistant_peers_setup` from that client to verify the registered server.

5/ GitHub:
https://github.com/AnamKwon/code-assistant-peers

npm:
https://www.npmjs.com/package/mcp-code-assistant-peers
```

## Copy-Paste: LinkedIn Post

```text
I released mcp-code-assistant-peers, a local MCP review gate for CLI coding agents.

The motivation is practical: single-agent coding workflows are fast, but the same model that wrote a patch often misses its own assumptions. I wanted a workflow where one assistant edits code and another assistant reviews the diff before the final answer.

What it does:

- routes code changes to a peer reviewer CLI
- supports Claude Code, Codex, Gemini-style CLIs, and custom adapters
- stores review rounds and findings in local SQLite
- runs review gates asynchronously to avoid MCP host timeouts
- supports multi-peer review and stricter gate modes

Install:

Choose one setup path.

For Codex:

curl -fsSL https://bun.sh/install | bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
npm install -g mcp-code-assistant-peers
code-assistant-peers setup codex --peers=auto

For Claude Code:

curl -fsSL https://bun.sh/install | bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
npm install -g mcp-code-assistant-peers
code-assistant-peers setup claude --peers=auto

Then restart the configured MCP client, Codex or Claude Code, and call `code_assistant_peers_setup` from that client to verify the registered server.

GitHub:
https://github.com/AnamKwon/code-assistant-peers

npm:
https://www.npmjs.com/package/mcp-code-assistant-peers
```

## Copy-Paste: Hacker News

Title:

```text
Show HN: code-assistant-peers, an MCP server that makes coding agents review each other
```

Body:

```text
I built code-assistant-peers, a local MCP review gate for CLI coding agents.

The idea is simple: one assistant edits code, another assistant reviews the diff, and findings are stored locally so later rounds can verify whether they were fixed.

Claude Code and Codex work out of the box. Gemini and other prompt-capable CLIs can be added through adapter configuration.

It supports:

- mandatory post-edit review tools
- async review gates
- SQLite review memory
- multi-peer review
- normal, adversarial, gate, and collaborative modes
- npm installation through mcp-code-assistant-peers

Install:

Choose one setup path.

For Codex:

curl -fsSL https://bun.sh/install | bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
npm install -g mcp-code-assistant-peers
code-assistant-peers setup codex --peers=auto

For Claude Code:

curl -fsSL https://bun.sh/install | bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
npm install -g mcp-code-assistant-peers
code-assistant-peers setup claude --peers=auto

Then restart the configured MCP client, Codex or Claude Code, and call `code_assistant_peers_setup` from that client to verify the registered server.

GitHub: https://github.com/AnamKwon/code-assistant-peers
npm: https://www.npmjs.com/package/mcp-code-assistant-peers
```

## Copy-Paste: Reddit Post

```text
I built an MCP server that lets CLI coding agents review each other's code.

The problem I wanted to solve: when one assistant writes a patch, it can miss its own assumptions. So mcp-code-assistant-peers adds a local review gate where another assistant reviews the diff before the final answer.

What it supports:

- Claude Code and Codex out of the box
- Gemini-style and custom CLI adapters
- async review gates
- SQLite review memory
- multi-peer review
- gate/adversarial/collaborative review modes

Install:

Choose one setup path.

For Codex:

curl -fsSL https://bun.sh/install | bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
npm install -g mcp-code-assistant-peers
code-assistant-peers setup codex --peers=auto

For Claude Code:

curl -fsSL https://bun.sh/install | bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
npm install -g mcp-code-assistant-peers
code-assistant-peers setup claude --peers=auto

Then restart the configured MCP client, Codex or Claude Code, and call `code_assistant_peers_setup` from that client to verify the registered server.

GitHub:
https://github.com/AnamKwon/code-assistant-peers

npm:
https://www.npmjs.com/package/mcp-code-assistant-peers

I would be especially interested in feedback from people already using multiple coding agents in their local workflow.
```

## Copy-Paste: Discord / Slack

```text
I released mcp-code-assistant-peers, a local MCP review gate for CLI coding agents.

It lets one assistant write code and another assistant review the diff before the final answer. Review rounds and findings are stored locally in SQLite.

Works with Claude Code, Codex, Gemini-style CLIs, and custom adapters.

Install:
Choose one setup path.

For Codex:

curl -fsSL https://bun.sh/install | bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
npm install -g mcp-code-assistant-peers
code-assistant-peers setup codex --peers=auto

For Claude Code:

curl -fsSL https://bun.sh/install | bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
npm install -g mcp-code-assistant-peers
code-assistant-peers setup claude --peers=auto

Then restart the configured MCP client, Codex or Claude Code, and call `code_assistant_peers_setup` from that client to verify the registered server.

GitHub: https://github.com/AnamKwon/code-assistant-peers
npm: https://www.npmjs.com/package/mcp-code-assistant-peers
```

## Copy-Paste: Korean Community Post

```text
CLI 코딩 에이전트끼리 서로 코드 리뷰를 하게 만드는 MCP 서버를 만들었습니다.

이름은 mcp-code-assistant-peers 입니다.

문제의식은 단순합니다. Claude Code나 Codex가 코드를 잘 작성하더라도, 같은 모델이 자기 패치의 가정을 놓칠 때가 있습니다. 그래서 한 에이전트가 코드를 수정하면 다른 에이전트가 diff를 리뷰하고, finding을 SQLite에 저장한 뒤 blocking issue를 고치고 최종 답변하도록 만드는 로컬 MCP review gate를 만들었습니다.

지원하는 것:

- Claude Code / Codex 기본 지원
- Gemini 스타일 CLI와 custom adapter 지원
- async review gate
- SQLite review memory
- multi-peer review
- normal / adversarial / gate / collaborative review mode

설치:

아래 중 하나만 선택하세요.

Codex를 쓰는 경우:

curl -fsSL https://bun.sh/install | bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
npm install -g mcp-code-assistant-peers
code-assistant-peers setup codex --peers=auto

Claude Code를 쓰는 경우:

curl -fsSL https://bun.sh/install | bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
npm install -g mcp-code-assistant-peers
code-assistant-peers setup claude --peers=auto

설정한 MCP 클라이언트, Codex 또는 Claude Code를 재시작한 뒤 해당 클라이언트에서 `code_assistant_peers_setup`을 호출해 등록된 서버를 확인하면 됩니다.

GitHub:
https://github.com/AnamKwon/code-assistant-peers

npm:
https://www.npmjs.com/package/mcp-code-assistant-peers

여러 코딩 에이전트를 같이 쓰는 분들이 실제 워크플로우에서 써보고 피드백 주시면 도움이 될 것 같습니다.
```

## Copy-Paste: GitHub Release Notes

```text
## mcp-code-assistant-peers npm release

This alpha release makes `mcp-code-assistant-peers` available through npm and improves the local peer-review workflow for CLI coding agents.

Highlights:

- npm package: `mcp-code-assistant-peers`
- primary setup command: `code-assistant-peers`
- package-name CLI alias for read-only commands: `mcp-code-assistant-peers`
- MCP server binary: `code-assistant-peers-server`
- async-first review gates
- multi-peer review support
- Claude Code, Codex, Gemini-style CLI support
- SQLite-backed review rounds and findings
- non-git workspace fallback context for review
- documentation assets and demo GIF

Install:

Choose one setup path.

For Codex:

curl -fsSL https://bun.sh/install | bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
npm install -g mcp-code-assistant-peers
code-assistant-peers setup codex --peers=auto

For Claude Code:

curl -fsSL https://bun.sh/install | bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
npm install -g mcp-code-assistant-peers
code-assistant-peers setup claude --peers=auto

Then restart the configured MCP client, Codex or Claude Code, and call `code_assistant_peers_setup` from that client to verify the registered server.

Notes:

- Bun is required because the package binaries use Bun shebangs.
- Use global npm install or a source checkout for `setup`; do not use `npx` for MCP registration because setup needs a stable server path.
```

## Copy-Paste: Follow-Up Technical Post

```text
One detail in mcp-code-assistant-peers that matters for real workflows:

review rounds are stored locally.

That means a peer reviewer can flag an issue, the host assistant can fix it, and the next review round can verify whether the previous finding was addressed.

This is more useful than a one-off "ask another model" prompt because the review state survives across async runs and follow-up gates.

GitHub:
https://github.com/AnamKwon/code-assistant-peers

npm:
https://www.npmjs.com/package/mcp-code-assistant-peers
```

## Suggested Hashtags

Use sparingly. Pick two to four, not all of them.

```text
#MCP #ClaudeCode #Codex #AIEngineering #DevTools #CodeReview #AIAgents
```

## First Week Checklist

- [ ] Push the branch containing npm install docs.
- [ ] Confirm GitHub README shows the npm install section.
- [ ] Create GitHub release for the current npm version.
- [ ] Attach or reference `docs/assets/peer-review-demo.gif`.
- [ ] Post X/Twitter short post.
- [ ] Post LinkedIn post.
- [ ] Submit Show HN.
- [ ] Post to one relevant Reddit community after checking rules.
- [ ] Share in two MCP or coding-agent communities.
- [ ] Reply to every installation issue with exact command output requests.
- [ ] Collect repeated setup problems into README updates.

## Reply Templates

### When Someone Asks "Does It Require Bun?"

```text
Yes. The current npm package uses Bun shebangs for the CLI and MCP server, so Bun needs to be installed first:

curl -fsSL https://bun.sh/install | bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
npm install -g mcp-code-assistant-peers

A future release could ship compiled Node-compatible JS bins, but the current alpha expects Bun.

If global npm installs require elevated permissions on your machine, use your normal Node/npm version manager setup rather than adding `sudo` blindly.
```

### When Someone Asks "Can I Use npx?"

```text
You can use npx for read-only commands such as:

npx mcp-code-assistant-peers status

Do not use npx for setup. MCP registration needs a stable server path, and npx can point to an ephemeral npm cache path. Use global install or a source checkout for setup. Choose one setup path.

For Codex:

npm install -g mcp-code-assistant-peers
code-assistant-peers setup codex --peers=auto

For Claude Code:

npm install -g mcp-code-assistant-peers
code-assistant-peers setup claude --peers=auto

Then restart the configured MCP client, Codex or Claude Code, and call `code_assistant_peers_setup` from that client to verify the registered server.
```

### When Someone Asks "Why Not Just Ask Another Model?"

```text
The useful part is the workflow around the second model:

- the host assistant is nudged to run a mandatory post-edit gate
- review rounds are stored locally
- findings can be verified in later rounds
- long reviews run asynchronously
- multiple peer CLIs can review the same change

So it is not only "ask another model"; it is a repeatable local review gate.
```
