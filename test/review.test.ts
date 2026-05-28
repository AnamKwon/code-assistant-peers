import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ADVERSARIAL_REVIEW_PROMPT,
  COLLABORATIVE_REVIEW_PROMPT,
  REVIEW_FINDING_GUIDELINES,
  REVIEW_OUTPUT_GUIDELINES,
  REVIEWER_SYSTEM_PROMPT,
  PEER_FIX_PROMPT,
  buildReviewCommandEnv,
  SELF_REVIEW_PROMPT,
  buildReviewCommand,
  buildReviewPrompt,
  buildReviewPromptFromSnapshot,
  chooseReviewModelTier,
  formatMultiPeerReviewOutputs,
  buildSerenaReviewerGuidance,
  normalizeHost,
  normalizeReviewFocus,
  peerFor,
  prepareReviewPromptSnapshot,
  resolveReviewerModel,
  selectAutoReviewerModel,
  runReviewCommand,
  truncateForReview,
} from "../shared/review.ts";
import { getGeminiAuthReadiness, hasNonBlankEnv, isTruthyEnv, loadAssistantRegistry, getAssistantAdapter, peersFor } from "../shared/assistants.ts";
import { areConfiguredAssistantsReady, resolveMultiPeerTaskStatus, shouldRunCodexSelfReview, summarizeMultiPeerAvailability } from "../shared/multi-peer.ts";
import {
  buildSemanticContext,
  buildSerenaFindSymbolArgs,
  buildSerenaNamePathArgs,
  decideSerenaAuto,
  extractSymbolHints,
  formatSymbolHints,
  parseSerenaCommand,
  validateSerenaToolSet,
} from "../shared/semantic.ts";
import { buildSerenaEnv, resolveAutoPeerSetupConfig, resolveGeminiAutoPeerReadiness, resolveSerenaSetupConfig, upsertCodexMcpTimeoutConfig } from "../shared/setup.ts";
import { getReviewDiff } from "../shared/git.ts";
import { captureWorkspaceSnapshot, emptyWorkspaceSnapshot } from "../shared/workspace-snapshot.ts";
import type { PeerTask } from "../shared/types.ts";

describe("assistant routing", () => {
  test("normalizes configured host", () => {
    expect(normalizeHost("claude")).toBe("claude");
    expect(normalizeHost("codex")).toBe("codex");
    expect(normalizeHost("gemini")).toBe("gemini");
    expect(() => normalizeHost(undefined)).toThrow("HOST_ASSISTANT");
  });

  test("selects the first default peer for Claude and Codex", () => {
    expect(peerFor("claude")).toBe("codex");
    expect(peerFor("codex")).toBe("claude");
  });

  test("defaults Codex peer review to Claude and Gemini", () => {
    expect(peersFor("codex")).toEqual(["claude", "gemini"]);
    expect(peerFor("codex")).toBe("claude");
  });

  test("enables Codex self-review only for Codex host", () => {
    expect(shouldRunCodexSelfReview("codex")).toBe(true);
    expect(shouldRunCodexSelfReview("codex", "normal")).toBe(true);
    expect(shouldRunCodexSelfReview("codex", "adversarial")).toBe(true);
    expect(shouldRunCodexSelfReview("codex", "gate")).toBe(false);
    expect(shouldRunCodexSelfReview("codex", "collaborative")).toBe(false);
    expect(shouldRunCodexSelfReview("claude")).toBe(false);
    expect(shouldRunCodexSelfReview("gemini")).toBe(false);
  });

  test("exposes Gemini CLI as a built-in adapter", () => {
    const registry = loadAssistantRegistry({} as NodeJS.ProcessEnv);

    expect(getAssistantAdapter("gemini", registry).command).toEqual(["gemini", "--skip-trust", "--approval-mode", "plan", "-p", ""]);
    expect(getAssistantAdapter("gemini", registry).prompt_transport).toBe("stdin");
    expect(getAssistantAdapter("gemini", registry).timeout_ms).toBe(180000);
    expect(buildReviewCommand("gemini")).toEqual(["gemini", "--skip-trust", "--approval-mode", "plan", "-p", ""]);
  });

  test("loads custom CLI assistants from environment JSON", () => {
    const registry = loadAssistantRegistry({
      CODE_ASSISTANT_PEERS_ASSISTANTS: JSON.stringify({
        glm: {
          command: ["glm"],
          prompt_transport: "stdin",
          description: "Gemini Code Assist",
          timeout_ms: 1234,
        },
        deepseek: {
          command: ["deepseek", "chat"],
          prompt_transport: "stdin",
        },
      }),
    } as NodeJS.ProcessEnv);

    expect(registry.glm.command).toEqual(["glm"]);
    expect(registry.glm.prompt_transport).toBe("stdin");
    expect(registry.glm.timeout_ms).toBe(1234);
    expect(registry.deepseek.prompt_transport).toBe("stdin");
  });

  test("rejects malformed custom assistant JSON with env-specific error", () => {
    expect(() => loadAssistantRegistry({
      CODE_ASSISTANT_PEERS_ASSISTANTS: "{bad json",
    } as NodeJS.ProcessEnv)).toThrow("CODE_ASSISTANT_PEERS_ASSISTANTS contains invalid JSON");
  });

  test("rejects custom assistants that override built-ins", () => {
    expect(() => loadAssistantRegistry({
      CODE_ASSISTANT_PEERS_ASSISTANTS: JSON.stringify({
        claude: { command: ["unsafe-claude"], prompt_transport: "stdin" },
      }),
    } as NodeJS.ProcessEnv)).toThrow("override a built-in adapter");

    const registry = loadAssistantRegistry({
      CODE_ASSISTANT_PEERS_ASSISTANTS: JSON.stringify({
        gemini: { command: ["gemini", "-p"], prompt_transport: "argv" },
      }),
    } as NodeJS.ProcessEnv);
    expect(registry.gemini.command).toEqual(["gemini", "--skip-trust", "--approval-mode", "plan", "-p", ""]);
    expect(registry.gemini.prompt_transport).toBe("stdin");
  });

  test("rejects illegal assistant ids through custom config", () => {
    expect(() => loadAssistantRegistry({
      CODE_ASSISTANT_PEERS_ASSISTANTS: JSON.stringify({
        "bad id": { command: ["x"], prompt_transport: "stdin" },
      }),
    } as NodeJS.ProcessEnv)).toThrow("Invalid assistant id");

    expect(() => loadAssistantRegistry({
      CODE_ASSISTANT_PEERS_ASSISTANTS: JSON.stringify({
        "-leading-hyphen": { command: ["x"], prompt_transport: "stdin" },
      }),
    } as NodeJS.ProcessEnv)).toThrow("Invalid assistant id");
  });

  test("selects configured peer assistant for custom hosts", () => {
    const registry = loadAssistantRegistry({
      CODE_ASSISTANT_PEERS_ASSISTANTS: JSON.stringify({
        glm: { command: ["glm"], prompt_transport: "stdin" },
        deepseek: { command: ["deepseek", "chat"], prompt_transport: "stdin" },
      }),
    } as NodeJS.ProcessEnv);

    expect(normalizeHost("glm", registry)).toBe("glm");
    expect(peerFor("glm", "gemini", undefined, registry)).toBe("gemini");
  });

  test("selects multiple peers from PEER_ASSISTANTS", () => {
    const registry = loadAssistantRegistry({
      CODE_ASSISTANT_PEERS_ASSISTANTS: JSON.stringify({
        glm: { command: ["glm"], prompt_transport: "stdin" },
        deepseek: { command: ["deepseek", "chat"], prompt_transport: "stdin" },
      }),
    } as NodeJS.ProcessEnv);

    expect(peersFor("claude", "codex,gemini,glm", undefined, registry)).toEqual(["codex", "gemini", "glm"]);
    expect(peersFor("gemini", "gemini,codex,glm", undefined, registry)).toEqual(["codex", "glm"]);
  });

  test("rejects unknown multi-peer assistants", () => {
    expect(() => peersFor("claude", "codex,unknown")).toThrow("PEER_ASSISTANTS contains unknown assistant");
  });

  test("selects peer from PEER_ASSISTANT environment default", () => {
    const previous = process.env.PEER_ASSISTANT;
    process.env.PEER_ASSISTANT = "codex";
    try {
      expect(peerFor("claude")).toBe("codex");
    } finally {
      if (previous === undefined) delete process.env.PEER_ASSISTANT;
      else process.env.PEER_ASSISTANT = previous;
    }
  });
});

describe("multi-peer review behavior", () => {
  test("requires every configured peer for setup readiness", () => {
    expect(areConfiguredAssistantsReady({
      claude: { available: { ok: true } },
      codex: { available: { ok: true } },
      gemini: { available: { ok: false } },
    }, "claude", ["codex", "gemini"])).toBe(false);

    expect(areConfiguredAssistantsReady({
      claude: { available: { ok: true } },
      codex: { available: { ok: true } },
      gemini: { available: { ok: true } },
    }, "claude", ["codex", "gemini"])).toBe(true);
  });

  test("marks multi-peer review as partial_failed when at least one peer succeeds and another peer is skipped or fails", () => {
    expect(resolveMultiPeerTaskStatus({
      successfulPeerReviews: 1,
      failedPeerReviews: 0,
      skippedPeers: 1,
      aggregateExitCode: 0,
    })).toBe("partial_failed");

    expect(resolveMultiPeerTaskStatus({
      successfulPeerReviews: 1,
      failedPeerReviews: 0,
      skippedPeers: 2,
      aggregateExitCode: 0,
    })).toBe("partial_failed");

    expect(resolveMultiPeerTaskStatus({
      successfulPeerReviews: 1,
      failedPeerReviews: 1,
      skippedPeers: 0,
      aggregateExitCode: 0,
    })).toBe("partial_failed");
  });

  test("marks multi-peer review as failed when no peer succeeds or aggregate review fails", () => {
    expect(resolveMultiPeerTaskStatus({
      successfulPeerReviews: 0,
      failedPeerReviews: 2,
      skippedPeers: 0,
      aggregateExitCode: 0,
    })).toBe("review_failed");

    expect(resolveMultiPeerTaskStatus({
      successfulPeerReviews: 2,
      failedPeerReviews: 0,
      skippedPeers: 0,
      aggregateExitCode: 1,
    })).toBe("review_failed");
  });

  test("summarizes multi-peer availability with host and peer preflights", () => {
    const hostUnavailable = summarizeMultiPeerAvailability(
      { ok: false, detail: "host missing" },
      [
        { reviewer: "claude", available: { ok: true, detail: "available" } },
        { reviewer: "gemini", available: { ok: false, detail: "gemini missing" } },
      ],
      false,
    );
    expect(hostUnavailable.failure).toBe("host_unavailable");
    expect(hostUnavailable.availablePeers).toEqual(["claude"]);
    expect(hostUnavailable.skippedPeers).toHaveLength(1);

    const noPeers = summarizeMultiPeerAvailability(
      { ok: true, detail: "available" },
      [
        { reviewer: "claude", available: { ok: false, detail: "claude missing" } },
      ],
      false,
    );
    expect(noPeers.failure).toBe("no_peers");
    expect(noPeers.availablePeers).toEqual([]);
    expect(noPeers.skippedPeers).toHaveLength(1);

    const selfReviewOnly = summarizeMultiPeerAvailability(
      { ok: true, detail: "available" },
      [
        { reviewer: "claude", available: { ok: false, detail: "claude missing" } },
      ],
      true,
    );
    expect(selfReviewOnly.failure).toBeUndefined();
    expect(selfReviewOnly.availablePeers).toEqual([]);
    expect(selfReviewOnly.skippedPeers).toHaveLength(1);
  });
});

describe("setup helpers", () => {
  test("auto-selects setup peers from available assistant CLIs", () => {
    expect(resolveAutoPeerSetupConfig(["codex"], {
      claude: { ok: true, detail: "/bin/claude" },
      codex: { ok: true, detail: "/bin/codex" },
      gemini: { ok: true, detail: "/bin/gemini" },
    }).peers).toBe("claude,gemini");

    expect(resolveAutoPeerSetupConfig(["codex"], {
      claude: { ok: false, detail: "missing" },
      codex: { ok: true, detail: "/bin/codex" },
      gemini: { ok: true, detail: "/bin/gemini" },
    }).peers).toBe("gemini");

    expect(resolveAutoPeerSetupConfig(["claude", "codex"], {
      claude: { ok: true, detail: "/bin/claude" },
      codex: { ok: true, detail: "/bin/codex" },
      gemini: { ok: false, detail: "no auth" },
    }).peers).toBe("claude,codex");
  });

  test("auto peer setup fails when no reviewer is available", () => {
    expect(() => resolveAutoPeerSetupConfig(["codex"], {
      claude: { ok: false, detail: "missing" },
      codex: { ok: true, detail: "/bin/codex" },
      gemini: { ok: false, detail: "no auth" },
    })).toThrow("--peers=auto could not find an available peer assistant");

    expect(() => resolveAutoPeerSetupConfig(["claude", "codex"], {
      claude: { ok: true, detail: "/bin/claude" },
      codex: { ok: false, detail: "missing" },
      gemini: { ok: false, detail: "no auth" },
    })).toThrow("--peers=auto could not find an available peer assistant for HOST_ASSISTANT=claude");
  });

  test("Gemini auto peer readiness is conservative", () => {
    expect(resolveGeminiAutoPeerReadiness({ GEMINI_API_KEY: "key" } as NodeJS.ProcessEnv).ok).toBe(true);
    expect(resolveGeminiAutoPeerReadiness({ GOOGLE_API_KEY: "key" } as NodeJS.ProcessEnv).ok).toBe(true);

    const oauthOnly = resolveGeminiAutoPeerReadiness({} as NodeJS.ProcessEnv);
    expect(oauthOnly.ok).toBe(false);
    expect(oauthOnly.detail).toContain("--peers=gemini");
    expect(oauthOnly.detail).toContain("Gemini CLI OAuth or Vertex credentials");

    const vertexMode = resolveGeminiAutoPeerReadiness({
      GEMINI_API_KEY: "key",
      GOOGLE_GENAI_USE_VERTEXAI: "true",
      GOOGLE_CLOUD_PROJECT: "project",
      GOOGLE_CLOUD_LOCATION: "us-central1",
    } as NodeJS.ProcessEnv);
    expect(vertexMode.ok).toBe(false);
    expect(vertexMode.detail).toContain("Vertex AI mode");
  });

  test("adds codex MCP timeout section when missing", () => {
    const result = upsertCodexMcpTimeoutConfig("[features]\nmulti_agent = true\n", "/repo/server.ts", 600);
    expect(result).toContain("[features]");
    expect(result).toContain("[mcp_servers.code-assistant-peers]");
    expect(result).toContain('command = "bun"');
    expect(result).toContain('args = ["/repo/server.ts"]');
    expect(result).toContain("tool_timeout_sec = 600");
  });

  test("updates existing codex MCP timeout section without touching later sections", () => {
    const result = upsertCodexMcpTimeoutConfig([
      "[mcp_servers.code-assistant-peers]",
      'command = "bun"',
      'args = ["/old/server.ts"]',
      "tool_timeout_sec = 120",
      "",
      "[profiles.default]",
      'model = "gpt-5.5"',
      "",
    ].join("\n"), "/repo/server.ts", 600);

    expect(result).toContain('args = ["/repo/server.ts"]');
    expect(result).not.toContain('args = ["/old/server.ts"]');
    expect(result).toContain("startup_timeout_sec = 30");
    expect(result).toContain("tool_timeout_sec = 600");
    expect(result).toContain("[profiles.default]");
    expect(result).toContain('model = "gpt-5.5"');
  });

  test("creates codex MCP timeout config from empty input and escapes quoted paths", () => {
    const result = upsertCodexMcpTimeoutConfig("", "/repo/quoted \"server\".ts", 600);
    expect(result).toContain("[mcp_servers.code-assistant-peers]");
    expect(result).toContain('args = ["/repo/quoted \\"server\\".ts"]');
    expect(result).toContain("tool_timeout_sec = 600");
  });

  test("auto-enables Serena through uvx when available", () => {
    const config = resolveSerenaSetupConfig({
      mode: "auto",
      hasSerenaBinary: false,
      hasUvx: true,
    });

    expect(config.enabled).toBe(true);
    expect(config.command?.[0]).toBe("uvx");
    expect(buildSerenaEnv(config)).toContain("CODE_ASSISTANT_PEERS_CONTEXT_PROVIDER=serena-auto");
    expect(buildSerenaEnv(config)).toContain("CODE_ASSISTANT_PEERS_DIFF_BUDGET=4000");
  });

  test("keeps standard review mode when Serena is not detected", () => {
    const config = resolveSerenaSetupConfig({
      mode: "auto",
      hasSerenaBinary: false,
      hasUvx: false,
    });

    expect(config.enabled).toBe(false);
    expect(buildSerenaEnv(config)).toEqual([]);
  });

  test("accepts explicit Serena command", () => {
    const config = resolveSerenaSetupConfig({
      mode: "on",
      explicitCommand: '["serena","start-mcp-server","--project-from-cwd"]',
      hasSerenaBinary: false,
      hasUvx: false,
    });

    expect(config.enabled).toBe(true);
    expect(config.command).toEqual(["serena", "start-mcp-server", "--project-from-cwd"]);
  });

  test("requires a Serena executable when setup forces Serena on", () => {
    expect(() => resolveSerenaSetupConfig({
      mode: "on",
      hasSerenaBinary: false,
      hasUvx: false,
    })).toThrow("--serena=on");
  });

  test("wraps malformed Serena command JSON with option context", () => {
    expect(() => resolveSerenaSetupConfig({
      mode: "on",
      explicitCommand: "[\"serena\"",
      hasSerenaBinary: false,
      hasUvx: false,
    })).toThrow("Invalid --serena-command JSON");
  });
});

describe("review command construction", () => {
  test("codex reviewer uses read-only codex exec over stdin", () => {
    expect(buildReviewCommand("codex")).toEqual([
      "codex",
      "exec",
      "--ignore-user-config",
      "--ignore-rules",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "-",
    ]);
  });

  test("claude reviewer uses print mode with read-only review instructions", () => {
    const previous = process.env.CODE_ASSISTANT_PEERS_SERENA_COMMAND;
    delete process.env.CODE_ASSISTANT_PEERS_SERENA_COMMAND;
    try {
      const command = buildReviewCommand("claude");
      expect(command).toEqual([
        "claude",
        "-p",
        "--permission-mode",
        "plan",
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
        "--system-prompt",
        REVIEWER_SYSTEM_PROMPT,
        "--allowedTools",
        "Read,Grep,Glob,Bash(git status:*),Bash(git diff:*),Bash(git show:*),Bash(git ls-files:*),mcp__serena__get_symbols_overview,mcp__serena__find_symbol,mcp__serena__find_referencing_symbols,mcp__serena__find_implementations,mcp__serena__get_diagnostics_for_file",
        "--disallowedTools",
        "Edit,Write,MultiEdit,NotebookEdit,mcp__serena__create_text_file,mcp__serena__delete_memory,mcp__serena__edit_memory,mcp__serena__insert_after_symbol,mcp__serena__insert_before_symbol,mcp__serena__replace_content,mcp__serena__replace_symbol_body,mcp__serena__rename_symbol,mcp__serena__safe_delete_symbol,mcp__serena__write_memory",
      ]);
    } finally {
      if (previous === undefined) delete process.env.CODE_ASSISTANT_PEERS_SERENA_COMMAND;
      else process.env.CODE_ASSISTANT_PEERS_SERENA_COMMAND = previous;
    }
  });

  test("claude reviewer mounts Serena MCP config when a Serena command is configured", () => {
    const previous = process.env.CODE_ASSISTANT_PEERS_SERENA_COMMAND;
    process.env.CODE_ASSISTANT_PEERS_SERENA_COMMAND = '["serena","start-mcp-server","--project-from-cwd"]';
    try {
      const command = buildReviewCommand("claude");
      const strictConfigIndex = command.indexOf("--strict-mcp-config");
      const mcpConfigIndex = command.indexOf("--mcp-config");
      expect(strictConfigIndex).toBeGreaterThan(0);
      expect(mcpConfigIndex).toBeGreaterThan(0);
      expect(strictConfigIndex).toBeLessThan(mcpConfigIndex);
      expect(mcpConfigIndex).toBeLessThan(command.indexOf("--system-prompt"));
      expect(JSON.parse(command[mcpConfigIndex + 1])).toEqual({
        mcpServers: {
          serena: {
            command: "serena",
            args: ["start-mcp-server", "--project-from-cwd"],
          },
        },
      });
      expect(command.join(" ")).toContain("mcp__serena__get_symbols_overview");
      expect(command.join(" ")).not.toContain("mcp__serena__activate_project");
    } finally {
      if (previous === undefined) delete process.env.CODE_ASSISTANT_PEERS_SERENA_COMMAND;
      else process.env.CODE_ASSISTANT_PEERS_SERENA_COMMAND = previous;
    }
  });

  test("review model selection inserts provider model arguments before prompt transport", () => {
    expect(buildReviewCommand("claude", "sonnet").slice(0, 7)).toEqual([
      "claude",
      "-p",
      "--permission-mode",
      "plan",
      "--model",
      "sonnet",
      "--strict-mcp-config",
    ]);
    expect(buildReviewCommand("codex", "gpt-5.5")).toEqual([
      "codex",
      "exec",
      "--ignore-user-config",
      "--ignore-rules",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "-m",
      "gpt-5.5",
      "-",
    ]);
    expect(buildReviewCommand("gemini", "flash")).toEqual([
      "gemini",
      "--skip-trust",
      "--approval-mode",
      "plan",
      "--model",
      "flash",
      "-p",
      "",
    ]);
  });

  test("review model resolution lets per-reviewer models override the global model", () => {
    expect(resolveReviewerModel("claude", {
      review_model: "sonnet",
      review_models: { claude: "opus" },
    })).toBe("opus");
    expect(resolveReviewerModel("codex", {
      review_model: "sonnet",
      review_models: { claude: "opus" },
    })).toBe("sonnet");
    expect(resolveReviewerModel("gemini", {})).toBeNull();
  });

  test("auto review model selection uses hardcoded reviewer model tiers", () => {
    expect(selectAutoReviewerModel("claude", { diffLength: 1000, changedFileCount: 1, focus: "docs" })).toBe("haiku");
    expect(selectAutoReviewerModel("claude", { focus: "security and data loss", diffLength: 1000 })).toBe("opus");
    expect(selectAutoReviewerModel("claude", { diffWasTruncated: true })).toBe("sonnet[1m]");
    expect(selectAutoReviewerModel("codex", { mode: "adversarial" })).toBe("gpt-5.5");
    expect(selectAutoReviewerModel("gemini", { diffLength: 1000, changedFileCount: 1, focus: "tests" })).toBe("flash");
  });

  test("review model auto token routes through the automatic selector", () => {
    expect(resolveReviewerModel("claude", {
      review_model: "auto",
    }, { focus: "auth migration", diffLength: 5000 })).toBe("opus");
    expect(resolveReviewerModel("codex", {
      review_model: "auto",
      review_models: { codex: "gpt-5.4" },
    }, { mode: "adversarial" })).toBe("gpt-5.4");
    expect(resolveReviewerModel("gemini", {
      review_model: "sonnet",
      review_models: { gemini: "auto" },
    }, { diffLength: 1000, changedFileCount: 1, focus: "readme" })).toBe("flash");
  });

  test("review model tier classifier prefers deeper models for risky or broad reviews", () => {
    expect(chooseReviewModelTier({ focus: "security", diffLength: 2000 })).toBe("deep");
    expect(chooseReviewModelTier({ mode: "collaborative" })).toBe("deep");
    expect(chooseReviewModelTier({ diffWasTruncated: true })).toBe("long_context");
    expect(chooseReviewModelTier({ focus: "docs", diffLength: 2000, changedFileCount: 1 })).toBe("fast");
    expect(chooseReviewModelTier({ mode: "gate", diffLength: 2000 })).toBe("balanced");
  });

  test("Serena reviewer guidance gives Claude a read-only lookup path", () => {
    const previous = process.env.CODE_ASSISTANT_PEERS_SERENA_COMMAND;
    process.env.CODE_ASSISTANT_PEERS_SERENA_COMMAND = '["serena","start-mcp-server","--project-from-cwd"]';
    try {
      const guidance = buildSerenaReviewerGuidance("claude", [
        "shared/review.ts",
        "README.md",
        "shared/semantic.ts",
      ], true);

      expect(guidance).toContain("Serena reviewer tools:");
      expect(guidance).toContain("mcp__serena__get_symbols_overview");
      expect(guidance).toContain("mcp__serena__find_referencing_symbols");
      expect(guidance).toContain("diff is truncated");
      expect(guidance).toContain("- shared/review.ts");
      expect(guidance).toContain("- shared/semantic.ts");
      expect(guidance).not.toContain("README.md");
      expect(guidance).not.toContain("mcp__serena__activate_project");
    } finally {
      if (previous === undefined) delete process.env.CODE_ASSISTANT_PEERS_SERENA_COMMAND;
      else process.env.CODE_ASSISTANT_PEERS_SERENA_COMMAND = previous;
    }
  });

  test("Serena reviewer guidance handles non-truncated diffs", () => {
    const previous = process.env.CODE_ASSISTANT_PEERS_SERENA_COMMAND;
    process.env.CODE_ASSISTANT_PEERS_SERENA_COMMAND = '["serena","start-mcp-server","--project-from-cwd"]';
    try {
      const guidance = buildSerenaReviewerGuidance("claude", ["shared/review.ts"], false);

      expect(guidance).toContain("Use Serena when the diff alone is not enough");
      expect(guidance).not.toContain("diff is truncated");
    } finally {
      if (previous === undefined) delete process.env.CODE_ASSISTANT_PEERS_SERENA_COMMAND;
      else process.env.CODE_ASSISTANT_PEERS_SERENA_COMMAND = previous;
    }
  });

  test("Serena reviewer guidance stays disabled for non-Claude reviewers", () => {
    const previous = process.env.CODE_ASSISTANT_PEERS_SERENA_COMMAND;
    process.env.CODE_ASSISTANT_PEERS_SERENA_COMMAND = '["serena","start-mcp-server","--project-from-cwd"]';
    try {
      expect(buildSerenaReviewerGuidance("codex", ["shared/review.ts"], false)).toBe("");
    } finally {
      if (previous === undefined) delete process.env.CODE_ASSISTANT_PEERS_SERENA_COMMAND;
      else process.env.CODE_ASSISTANT_PEERS_SERENA_COMMAND = previous;
    }
  });

  test("custom argv reviewer commands append prompt as an argument", () => {
    const previous = process.env.CODE_ASSISTANT_PEERS_ASSISTANTS;
    process.env.CODE_ASSISTANT_PEERS_ASSISTANTS = JSON.stringify({
      glm: { command: ["gemini", "-p"], prompt_transport: "argv" },
    });
    try {
      expect(getAssistantAdapter("glm").prompt_transport).toBe("argv");
      expect(buildReviewCommand("glm")).toEqual(["gemini", "-p"]);
    } finally {
      if (previous === undefined) delete process.env.CODE_ASSISTANT_PEERS_ASSISTANTS;
      else process.env.CODE_ASSISTANT_PEERS_ASSISTANTS = previous;
    }
  });

  test("argv prompt budget overflow uses UTF-8 bytes and returns a failed review result instead of throwing", async () => {
    const previous = process.env.CODE_ASSISTANT_PEERS_ASSISTANTS;
    process.env.CODE_ASSISTANT_PEERS_ASSISTANTS = JSON.stringify({
      foo: { command: ["foo"], prompt_transport: "argv" },
    });
    try {
      const result = await runReviewCommand("foo", process.cwd(), "가".repeat(20001));
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("bytes");
      expect(result.stderr).toContain("CODE_ASSISTANT_PEERS_ARGV_PROMPT_BUDGET");
      expect(result.command).toEqual(["foo", "<prompt>"]);
    } finally {
      if (previous === undefined) delete process.env.CODE_ASSISTANT_PEERS_ASSISTANTS;
      else process.env.CODE_ASSISTANT_PEERS_ASSISTANTS = previous;
    }
  });

  test("review command environment defaults to adapter allowlist", () => {
    const env = buildReviewCommandEnv({
      id: "test",
      command: ["test"],
      prompt_transport: "stdin",
      env_allowlist: ["PATH", "SAFE_KEY"],
    }, {
      PATH: "/bin",
      SAFE_KEY: "kept",
      SECRET_KEY: "removed",
    } as NodeJS.ProcessEnv);

    expect(env).toEqual({
      PATH: "/bin",
      SAFE_KEY: "kept",
      CODE_ASSISTANT_PEERS_REVIEWER_SUBPROCESS: "1",
    });
  });

  test("custom reviewers keep common model credential env vars by default", () => {
    const env = buildReviewCommandEnv({
      id: "custom",
      command: ["custom"],
      prompt_transport: "stdin",
    }, {
      PATH: "/bin",
      OPENAI_API_KEY: "openai",
      GEMINI_API_KEY: "gemini",
      ANTHROPIC_API_KEY: "anthropic",
      SECRET_KEY: "removed",
    } as NodeJS.ProcessEnv);

    expect(env).toEqual({
      PATH: "/bin",
      OPENAI_API_KEY: "openai",
      GEMINI_API_KEY: "gemini",
      ANTHROPIC_API_KEY: "anthropic",
      CODE_ASSISTANT_PEERS_REVIEWER_SUBPROCESS: "1",
    });
  });

  test("review command startup failures are returned as review failures", async () => {
    const previous = process.env.CODE_ASSISTANT_PEERS_ASSISTANTS;
    process.env.CODE_ASSISTANT_PEERS_ASSISTANTS = JSON.stringify({
      missing: { command: ["definitely-missing-reviewer-command"], prompt_transport: "stdin" },
    });
    try {
      const result = await runReviewCommand("missing", process.cwd(), "prompt");
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Review command failed to start");
    } finally {
      if (previous === undefined) delete process.env.CODE_ASSISTANT_PEERS_ASSISTANTS;
      else process.env.CODE_ASSISTANT_PEERS_ASSISTANTS = previous;
    }
  });

  test("review command timeout terminates hanging reviewers", async () => {
    const previousAssistants = process.env.CODE_ASSISTANT_PEERS_ASSISTANTS;
    const previousTimeout = process.env.CODE_ASSISTANT_PEERS_REVIEW_TIMEOUT_MS;
    process.env.CODE_ASSISTANT_PEERS_ASSISTANTS = JSON.stringify({
      sleepy: {
        command: ["bun", "--eval", "setTimeout(() => {}, 1000)"],
        prompt_transport: "stdin",
      },
    });
    process.env.CODE_ASSISTANT_PEERS_REVIEW_TIMEOUT_MS = "50";
    try {
      const result = await runReviewCommand("sleepy", process.cwd(), "prompt");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Review command timed out after 50ms");
      expect(result.command).toEqual(["bun", "--eval", "setTimeout(() => {}, 1000)"]);
    } finally {
      if (previousAssistants === undefined) delete process.env.CODE_ASSISTANT_PEERS_ASSISTANTS;
      else process.env.CODE_ASSISTANT_PEERS_ASSISTANTS = previousAssistants;
      if (previousTimeout === undefined) delete process.env.CODE_ASSISTANT_PEERS_REVIEW_TIMEOUT_MS;
      else process.env.CODE_ASSISTANT_PEERS_REVIEW_TIMEOUT_MS = previousTimeout;
    }
  });

  test("Gemini readiness env parsing avoids false positives", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "gemini-readiness-"));
    const vertexCredentialFile = join(tempDir, "adc.json");
    await writeFile(vertexCredentialFile, "{}");
    expect(hasNonBlankEnv("")).toBe(false);
    expect(hasNonBlankEnv("   ")).toBe(false);
    expect(hasNonBlankEnv("key")).toBe(true);
    expect(isTruthyEnv("false")).toBe(false);
    expect(isTruthyEnv("0")).toBe(false);
    expect(isTruthyEnv("true")).toBe(true);
    expect(isTruthyEnv(" ON ")).toBe(true);

    expect((await getGeminiAuthReadiness({
      GEMINI_API_KEY: "   ",
      GOOGLE_API_KEY: "",
      GOOGLE_GENAI_USE_VERTEXAI: "false",
      GOOGLE_CLOUD_PROJECT: "project",
    } as NodeJS.ProcessEnv, [], [])).ok).toBe(false);

    expect((await getGeminiAuthReadiness({
      GOOGLE_GENAI_USE_VERTEXAI: "true",
      GOOGLE_CLOUD_PROJECT: "project",
    } as NodeJS.ProcessEnv, [], [])).ok).toBe(false);

    expect((await getGeminiAuthReadiness({
      GOOGLE_GENAI_USE_VERTEXAI: "true",
      GOOGLE_CLOUD_PROJECT: "project",
      GOOGLE_CLOUD_LOCATION: "us-central1",
    } as NodeJS.ProcessEnv, [], [])).ok).toBe(false);

    expect((await getGeminiAuthReadiness({
      GEMINI_API_KEY: "key",
      GOOGLE_GENAI_USE_VERTEXAI: "true",
      GOOGLE_CLOUD_PROJECT: "",
    } as NodeJS.ProcessEnv, [], [])).ok).toBe(false);

    expect((await getGeminiAuthReadiness({
      GEMINI_API_KEY: "key",
    } as NodeJS.ProcessEnv, [], [])).ok).toBe(true);

    try {
      expect((await getGeminiAuthReadiness({
        GOOGLE_GENAI_USE_VERTEXAI: "true",
        GOOGLE_CLOUD_PROJECT: "project",
        GOOGLE_CLOUD_LOCATION: "us-central1",
      } as NodeJS.ProcessEnv, [], [vertexCredentialFile])).ok).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("review prompt shaping", () => {
  test("keeps small diffs intact", () => {
    expect(truncateForReview("abc", 10)).toBe("abc");
  });

  test("truncates large diffs with inspection guidance", () => {
    const result = truncateForReview("0123456789", 5);
    expect(result).toContain("01234");
    expect(result).toContain("Diff truncated");
  });

  test("documents collaborative review token tradeoff", () => {
    expect(COLLABORATIVE_REVIEW_PROMPT).toContain("spends more tokens");
    expect(COLLABORATIVE_REVIEW_PROMPT).toContain("not the default");
  });

  test("review prompt includes Codex-inspired finding quality rules", async () => {
    const task: PeerTask = {
      id: "test-task",
      host: "codex",
      peer: "claude",
      prompt: "review prompt quality",
      cwd: process.cwd(),
      git_root: null,
      baseline_status: [],
      baseline_diff: "",
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
      status: "open",
    };

    const { prompt } = await buildReviewPrompt(task);
    expect(REVIEW_FINDING_GUIDELINES).toContain("author would likely fix");
    expect(REVIEW_FINDING_GUIDELINES).toContain("introduced by the reviewed change");
    expect(REVIEW_OUTPUT_GUIDELINES).toContain("overall correctness verdict");
    expect(prompt).toContain("Finding selection rules:");
    expect(prompt).toContain("patch is correct");
  });

  test("review prompt includes optional focus", async () => {
    const task: PeerTask = {
      id: "test-task",
      host: "codex",
      peer: "claude",
      prompt: "review focus",
      cwd: process.cwd(),
      git_root: null,
      baseline_status: [],
      baseline_diff: "",
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
      status: "open",
    };

    const { prompt } = await buildReviewPrompt(task, { focus: "security and data loss only" });
    expect(prompt).toContain("Review focus:");
    expect(prompt).toContain("security and data loss only");
  });

  test("extracts lightweight symbol hints for TypeScript source", () => {
    const hints = extractSymbolHints("shared/example.ts", [
      "export class ReviewGate {",
      "  async runReview() {",
      "    return true;",
      "  }",
      "}",
      "export function normalizeReviewFocus(value: string) { return value; }",
      "export const buildPrompt = () => 'prompt';",
    ].join("\n"));

    expect(hints).toContainEqual({ file: "shared/example.ts", line: 1, kind: "class", name: "ReviewGate" });
    expect(hints).toContainEqual({ file: "shared/example.ts", line: 2, kind: "method", name: "runReview" });
    expect(hints).toContainEqual({ file: "shared/example.ts", line: 6, kind: "function", name: "normalizeReviewFocus" });
    expect(hints).toContainEqual({ file: "shared/example.ts", line: 7, kind: "const-function", name: "buildPrompt" });
  });

  test("symbol hints ignore control-flow keywords that resemble methods", () => {
    const hints = extractSymbolHints("shared/example.ts", [
      "else if (ready) {",
      "return(value) {",
      "new Thing() {",
      "delete item() {",
      "typeof value() {",
      "void cleanup() {",
    ].join("\n"));
    expect(hints).toEqual([]);
  });

  test("semantic context truncates large symbol hint output", async () => {
    const hints = Array.from({ length: 100 }, (_, index) => ({
      file: "shared/very-long-file-name-for-symbol-hints.ts",
      line: index + 1,
      kind: "function",
      name: `veryLongFunctionName${index}`,
    }));
    const formatted = formatSymbolHints(hints, 300);
    expect(formatted).toContain("Symbol hints truncated at 300 characters");

    const context = await buildSemanticContext(process.cwd(), [], "x".repeat(6100));
    expect(context).toContain("Semantic context truncated at 6000 characters");
  });

  test("parses Serena stdio command from JSON array and shell-like string", () => {
    expect(parseSerenaCommand('["uvx","--from","git+https://github.com/oraios/serena","serena-mcp-server"]')).toEqual({
      command: "uvx",
      args: ["--from", "git+https://github.com/oraios/serena", "serena-mcp-server"],
    });

    expect(parseSerenaCommand("serena-mcp-server --transport stdio")).toEqual({
      command: "serena-mcp-server",
      args: ["--transport", "stdio"],
    });
  });

  test("serena-direct provider falls back cleanly when no Serena command is configured", async () => {
    const previousProvider = process.env.CODE_ASSISTANT_PEERS_CONTEXT_PROVIDER;
    const previousCommand = process.env.CODE_ASSISTANT_PEERS_SERENA_COMMAND;
    process.env.CODE_ASSISTANT_PEERS_CONTEXT_PROVIDER = "serena-direct";
    delete process.env.CODE_ASSISTANT_PEERS_SERENA_COMMAND;
    try {
      const context = await buildSemanticContext(process.cwd(), []);
      expect(context).toContain("Serena direct context unavailable");
      expect(context).toContain("CODE_ASSISTANT_PEERS_SERENA_COMMAND is not set");
    } finally {
      if (previousProvider === undefined) delete process.env.CODE_ASSISTANT_PEERS_CONTEXT_PROVIDER;
      else process.env.CODE_ASSISTANT_PEERS_CONTEXT_PROVIDER = previousProvider;
      if (previousCommand === undefined) delete process.env.CODE_ASSISTANT_PEERS_SERENA_COMMAND;
      else process.env.CODE_ASSISTANT_PEERS_SERENA_COMMAND = previousCommand;
    }
  });

  test("serena-direct requires activate_project before project-scoped symbol queries", () => {
    expect(validateSerenaToolSet(["get_symbols_overview", "find_symbol"])).toContain("activate_project");
    expect(validateSerenaToolSet(["activate_project", "get_symbols_overview"])).toBeNull();
  });

  test("serena-direct uses current Serena find_symbol argument names", () => {
    expect(buildSerenaFindSymbolArgs({
      file: "shared/semantic.ts",
      line: 18,
      kind: "function",
      name: "buildSemanticContext",
    })).toMatchObject({
      name_path_pattern: "buildSemanticContext",
      relative_path: "shared/semantic.ts",
      include_body: false,
    });
  });

  test("serena-direct adapts reference arguments to Serena name path schema", () => {
    const hint = {
      file: "shared/semantic.ts",
      line: 19,
      kind: "function",
      name: "buildSemanticContext",
    };

    expect(buildSerenaNamePathArgs({ properties: { name_path: {} } }, hint)).toMatchObject({
      name_path: "buildSemanticContext",
      relative_path: "shared/semantic.ts",
    });
    expect(buildSerenaNamePathArgs({ properties: { name_path_pattern: {} } }, hint)).toMatchObject({
      name_path_pattern: "buildSemanticContext",
      relative_path: "shared/semantic.ts",
    });
  });

  test("serena-auto skips small source changes", async () => {
    const decision = await decideSerenaAuto(process.cwd(), ["shared/types.ts"], {
      diffLength: 100,
      diffBudget: 4000,
    });
    expect(decision.useSerena).toBe(false);
    expect(decision.sourceFileCount).toBe(1);
  });

  test("serena-auto uses Serena when diff is truncated", async () => {
    const decision = await decideSerenaAuto(process.cwd(), ["shared/types.ts"], {
      diffLength: 5000,
      diffBudget: 4000,
    });
    expect(decision.useSerena).toBe(true);
    expect(decision.reasons).toContain("diff_truncated");
  });

  test("serena-auto uses Serena for risky source paths", async () => {
    const decision = await decideSerenaAuto(process.cwd(), ["src/checkout.ts"], {
      diffLength: 100,
      diffBudget: 4000,
    });
    expect(decision.useSerena).toBe(true);
    expect(decision.reasons).toContain("risk_path");
  });

  test("review prompt uses CODE_ASSISTANT_PEERS_REVIEW_FOCUS env default", async () => {
    const previous = process.env.CODE_ASSISTANT_PEERS_REVIEW_FOCUS;
    process.env.CODE_ASSISTANT_PEERS_REVIEW_FOCUS = "migration rollback risk";
    try {
      const task: PeerTask = {
        id: "test-task",
        host: "codex",
        peer: "claude",
        prompt: "review env focus",
        cwd: process.cwd(),
        git_root: null,
        baseline_status: [],
        baseline_diff: "",
        created_at: new Date(0).toISOString(),
        updated_at: new Date(0).toISOString(),
        status: "open",
      };

      const { prompt } = await buildReviewPrompt(task);
      expect(prompt).toContain("Review focus:");
      expect(prompt).toContain("migration rollback risk");
    } finally {
      if (previous === undefined) delete process.env.CODE_ASSISTANT_PEERS_REVIEW_FOCUS;
      else process.env.CODE_ASSISTANT_PEERS_REVIEW_FOCUS = previous;
    }
  });

  test("review prompt includes injected Serena-style semantic context", async () => {
    const task: PeerTask = {
      id: "test-task",
      host: "codex",
      peer: "claude",
      prompt: "review semantic context",
      cwd: process.cwd(),
      git_root: null,
      baseline_status: [],
      baseline_diff: "",
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
      status: "open",
    };

    const { prompt } = await buildReviewPrompt(task, {
      semantic_context: "Serena references: buildReviewPrompt -> runCollaborativeReviewTool",
    });
    expect(prompt).toContain("Semantic context:");
    expect(prompt).toContain("Semantic context status:");
    expect(prompt).toContain("External semantic context:");
    expect(prompt).toContain("Serena references: buildReviewPrompt -> runCollaborativeReviewTool");
    expect(prompt).toContain("Reviewer CLI processes are launched as separate subprocesses");
    expect(prompt).toContain("Treat any Semantic context section as advisory impact context");
    expect(prompt).toContain("source of truth");
  });

  test("reuses a prepared review snapshot for prompt construction", async () => {
    const task: PeerTask = {
      id: "test-task",
      host: "codex",
      peer: "codex",
      prompt: "review snapshot reuse",
      cwd: process.cwd(),
      git_root: null,
      baseline_status: [],
      baseline_diff: "",
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
      status: "open",
    };

    const snapshot = await prepareReviewPromptSnapshot(task, { mode: "normal" });
    const { prompt } = buildReviewPromptFromSnapshot(task, { mode: "normal" }, snapshot);
    expect(prompt).toContain("Current git status:");
    expect(prompt).toContain("Semantic context status:");
    expect(prompt).toContain("Previous review memory:");
  });

  test("includes non-git workspace snapshot changes in review prompts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cap-nongit-"));
    try {
      await writeFile(join(dir, "feature.ts"), "export const value = 1;\n");
      const baseline = await captureWorkspaceSnapshot(dir);
      await writeFile(join(dir, "feature.ts"), "export const value = 2;\n");
      await writeFile(join(dir, "new-file.ts"), "export const added = true;\n");

      const reviewContext = await getReviewDiff(dir, { baselineWorkspaceSnapshot: baseline });
      expect(reviewContext.label).toBe("non-git workspace snapshot diff");
      expect(reviewContext.changedFiles).toEqual(["feature.ts", "new-file.ts"]);
      expect(reviewContext.diff).toContain("## Modified: feature.ts");
      expect(reviewContext.diff).toContain("export const value = 1;");
      expect(reviewContext.diff).toContain("export const value = 2;");
      expect(reviewContext.warning).toContain("Git metadata was not available");

      const task: PeerTask = {
        id: "non-git-task",
        host: "codex",
        peer: "claude",
        prompt: "review non-git changes",
        cwd: dir,
        git_root: null,
        baseline_status: [],
        baseline_diff: "",
        baseline_workspace_snapshot: baseline,
        created_at: new Date(0).toISOString(),
        updated_at: new Date(0).toISOString(),
        status: "open",
      };
      const snapshot = await prepareReviewPromptSnapshot(task, { mode: "normal" });
      const { prompt } = buildReviewPromptFromSnapshot(task, { mode: "normal" }, snapshot);
      expect(prompt).toContain("Review target: non-git workspace snapshot diff");
      expect(prompt).toContain("Changed files:\nfeature.ts\nnew-file.ts");
      expect(prompt).toContain("Included uncommitted diff for review:\n# Non-git workspace snapshot diff");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reports current non-git files as added when no pre-edit baseline exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cap-nongit-empty-baseline-"));
    try {
      await writeFile(join(dir, "feature.ts"), "export const value = 2;\n");
      const reviewContext = await getReviewDiff(dir, {
        baselineWorkspaceSnapshot: emptyWorkspaceSnapshot("No pre-edit baseline snapshot was captured."),
      });

      expect(reviewContext.changedFiles).toEqual(["feature.ts"]);
      expect(reviewContext.diff).toContain("## Added: feature.ts");
      expect(reviewContext.diff).toContain("export const value = 2;");
      expect(reviewContext.warning).toContain("No pre-edit baseline snapshot was captured");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("omits sensitive non-git snapshot file contents", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cap-nongit-secret-"));
    try {
      await writeFile(join(dir, ".env"), "API_KEY=before-secret\n");
      await writeFile(join(dir, "secrets.json"), "{\"token\":\"before-json-secret\"}\n");
      await writeFile(join(dir, "auth.json"), "{\"oauth\":\"before-oauth-secret\"}\n");
      const baseline = await captureWorkspaceSnapshot(dir);
      await writeFile(join(dir, ".env"), "API_KEY=after-secret-with-new-size\n");
      await writeFile(join(dir, "secrets.json"), "{\"token\":\"after-json-secret-with-new-size\"}\n");
      await writeFile(join(dir, "auth.json"), "{\"oauth\":\"after-oauth-secret-with-new-size\"}\n");

      expect(baseline.files[".env"].text).toBeUndefined();
      expect(baseline.files[".env"].omitted).toBe("sensitive path");
      expect(baseline.files[".env"].sensitive).toBe(true);
      expect(baseline.files[".env"].fingerprint).toStartWith("sensitive:");
      expect(baseline.files[".env"].sha256).toBeUndefined();
      expect(baseline.files["secrets.json"].text).toBeUndefined();
      expect(baseline.files["secrets.json"].omitted).toBe("sensitive path");
      expect(baseline.files["secrets.json"].sensitive).toBe(true);
      expect(baseline.files["secrets.json"].fingerprint).toStartWith("sensitive:");
      expect(baseline.files["secrets.json"].sha256).toBeUndefined();
      expect(baseline.files["auth.json"].text).toBeUndefined();
      expect(baseline.files["auth.json"].omitted).toBe("sensitive path");
      expect(baseline.files["auth.json"].sensitive).toBe(true);
      expect(baseline.files["auth.json"].fingerprint).toStartWith("sensitive:");
      expect(baseline.files["auth.json"].sha256).toBeUndefined();

      const reviewContext = await getReviewDiff(dir, { baselineWorkspaceSnapshot: baseline });
      expect(reviewContext.changedFiles).toEqual([".env", "auth.json", "secrets.json"]);
      expect(reviewContext.diff).toContain("## Modified: .env");
      expect(reviewContext.diff).toContain("## Modified: auth.json");
      expect(reviewContext.diff).toContain("## Modified: secrets.json");
      expect(reviewContext.diff).toContain("sensitive path");
      expect(reviewContext.diff).not.toContain("sha256");
      expect(reviewContext.diff).not.toContain("sensitive:");
      expect(reviewContext.diff).not.toContain("before-secret");
      expect(reviewContext.diff).not.toContain("after-secret");
      expect(reviewContext.diff).not.toContain("before-json-secret");
      expect(reviewContext.diff).not.toContain("after-json-secret");
      expect(reviewContext.diff).not.toContain("before-oauth-secret");
      expect(reviewContext.diff).not.toContain("after-oauth-secret");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reports sensitive non-git files as possible changes even when metadata matches", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cap-nongit-sensitive-metadata-"));
    try {
      await writeFile(join(dir, ".env"), "TOKEN=old-value\n");
      const baseline = await captureWorkspaceSnapshot(dir);
      const unchangedMetadata = baseline.files[".env"].fingerprint;

      const reviewContext = await getReviewDiff(dir, { baselineWorkspaceSnapshot: baseline });
      expect(baseline.files[".env"].fingerprint).toBe(unchangedMetadata);
      expect(reviewContext.changedFiles).toEqual([".env"]);
      expect(reviewContext.diff).toContain("## Modified: .env");
      expect(reviewContext.warning).toContain("reported as possible changes");
      expect(reviewContext.diff).not.toContain("TOKEN=old-value");
      expect(reviewContext.diff).not.toContain("sensitive:");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("recaptures baseline paths when non-git snapshots are capped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cap-nongit-capped-"));
    try {
      for (let i = 1; i <= 501; i += 1) {
        await writeFile(join(dir, `f${String(i).padStart(3, "0")}.ts`), `export const v${i} = ${i};\n`);
      }
      const baseline = await captureWorkspaceSnapshot(dir);
      expect(baseline.truncated).toBe(true);

      await writeFile(join(dir, "f000.ts"), "export const newPrefix = true;\n");
      const reviewContext = await getReviewDiff(dir, { baselineWorkspaceSnapshot: baseline });

      expect(reviewContext.warning).toContain("additions outside the captured set may be omitted");
      expect(reviewContext.changedFiles).not.toContain("f500.ts");
      expect(reviewContext.diff).not.toContain("## Deleted: f500.ts");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reports captured additions when only the current non-git snapshot is capped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cap-nongit-current-capped-"));
    try {
      await writeFile(join(dir, "baseline.ts"), "export const baseline = true;\n");
      const baseline = await captureWorkspaceSnapshot(dir);
      expect(baseline.truncated).toBe(false);

      for (let i = 1; i <= 501; i += 1) {
        await writeFile(join(dir, `added-${String(i).padStart(3, "0")}.ts`), `export const added${i} = ${i};\n`);
      }

      const reviewContext = await getReviewDiff(dir, { baselineWorkspaceSnapshot: baseline });
      expect(reviewContext.warning).toContain("additions outside the captured set may be omitted");
      expect(reviewContext.changedFiles).toContain("added-001.ts");
      expect(reviewContext.diff).toContain("## Added: added-001.ts");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("keeps ordinary auth source contents in non-git snapshot diffs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cap-nongit-auth-source-"));
    try {
      await writeFile(join(dir, "auth.ts"), "export const mode = 'old';\n");
      const baseline = await captureWorkspaceSnapshot(dir);
      await writeFile(join(dir, "auth.ts"), "export const mode = 'new';\n");

      expect(baseline.files["auth.ts"].text).toContain("old");
      const reviewContext = await getReviewDiff(dir, { baselineWorkspaceSnapshot: baseline });
      expect(reviewContext.diff).toContain("export const mode = 'old';");
      expect(reviewContext.diff).toContain("export const mode = 'new';");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("serena-auto context reports when Serena optimization is skipped", async () => {
    const previousProvider = process.env.CODE_ASSISTANT_PEERS_CONTEXT_PROVIDER;
    process.env.CODE_ASSISTANT_PEERS_CONTEXT_PROVIDER = "serena-auto";
    try {
      const context = await buildSemanticContext(process.cwd(), ["shared/types.ts"], null, {
        diffLength: 1,
        diffBudget: 12000,
      });
      expect(context).toContain("Semantic context status:");
      expect(context).toContain("Provider: serena-auto");
      expect(context).toContain("Serena optimization: skipped");
    } finally {
      if (previousProvider === undefined) delete process.env.CODE_ASSISTANT_PEERS_CONTEXT_PROVIDER;
      else process.env.CODE_ASSISTANT_PEERS_CONTEXT_PROVIDER = previousProvider;
    }
  });

  test("serena-auto context reports unavailable when triggered without Serena command", async () => {
    const previousProvider = process.env.CODE_ASSISTANT_PEERS_CONTEXT_PROVIDER;
    const previousCommand = process.env.CODE_ASSISTANT_PEERS_SERENA_COMMAND;
    process.env.CODE_ASSISTANT_PEERS_CONTEXT_PROVIDER = "serena-auto";
    delete process.env.CODE_ASSISTANT_PEERS_SERENA_COMMAND;
    try {
      const context = await buildSemanticContext(process.cwd(), ["shared/types.ts"], null, {
        diffLength: 13000,
        diffBudget: 12000,
      });
      expect(context).toContain("Provider: serena-auto");
      expect(context).toContain("Serena optimization: unavailable (diff_truncated)");
      expect(context).toContain("Serena direct context unavailable");
      expect(context).not.toContain("Serena optimization: used (diff_truncated)");
    } finally {
      if (previousProvider === undefined) delete process.env.CODE_ASSISTANT_PEERS_CONTEXT_PROVIDER;
      else process.env.CODE_ASSISTANT_PEERS_CONTEXT_PROVIDER = previousProvider;
      if (previousCommand === undefined) delete process.env.CODE_ASSISTANT_PEERS_SERENA_COMMAND;
      else process.env.CODE_ASSISTANT_PEERS_SERENA_COMMAND = previousCommand;
    }
  });

  test("review focus truncation is visible", () => {
    const focus = normalizeReviewFocus("x".repeat(1005));
    expect(focus).toContain("Review focus truncated at 1000 characters");
  });

  test("gate prompt requests compact JSON after ALLOW or BLOCK", async () => {
    const task: PeerTask = {
      id: "test-task",
      host: "codex",
      peer: "claude",
      prompt: "review gate schema",
      cwd: process.cwd(),
      git_root: null,
      baseline_status: [],
      baseline_diff: "",
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
      status: "open",
    };

    const { prompt } = await buildReviewPrompt(task, { mode: "gate" });
    const promptInstructions = prompt.split("\nIncluded uncommitted diff for review:")[0];
    expect(prompt).toContain("ALLOW: <short reason>");
    expect(prompt).toContain('"overall_correctness"');
    expect(prompt).toContain('"priority"');
    expect(prompt).toContain('"confidence": 0.8');
    expect(prompt).toContain('"overall_confidence": 0.8');
    expect(promptInstructions).not.toContain("Start with findings.");
    expect(prompt.indexOf("ALLOW: <short reason>")).toBeLessThan(prompt.indexOf("Finding selection rules:"));
  });

  test("includes collaborative instructions for claude peer prompts", async () => {
    const task: PeerTask = {
      id: "test-task",
      host: "codex",
      peer: "claude",
      prompt: "review collaborative mode",
      cwd: process.cwd(),
      git_root: null,
      baseline_status: [],
      baseline_diff: "",
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
      status: "open",
    };

    const { prompt } = await buildReviewPrompt(task, { mode: "collaborative" });
    expect(prompt).toContain("collaborative two-assistant review");
    expect(prompt).toContain("Review mode: collaborative");
  });

  test("formats self-review output separately from peer output", () => {
    const output = formatMultiPeerReviewOutputs([], {
      reviewer: "codex",
      label: "codex self-review",
      review: {
        reviewer: "codex",
        command: ["codex"],
        exit_code: 0,
        stdout: "Self review found no blocking issues.",
        stderr: "",
        started_at: new Date(0).toISOString(),
        completed_at: new Date(0).toISOString(),
      },
      round: { round: 2 },
    });

    expect(output).toContain("Peer review outputs:\n(none)");
    expect(output).toContain("Codex self-review output:");
    expect(output).toContain("Self review found no blocking issues.");
  });

  test("formats combined peer and self-review output", () => {
    const output = formatMultiPeerReviewOutputs([
      {
        reviewer: "claude",
        label: "claude peer review",
        review: {
          reviewer: "claude",
          command: ["claude"],
          exit_code: 0,
          stdout: "Claude peer review output.",
          stderr: "",
          started_at: new Date(0).toISOString(),
          completed_at: new Date(0).toISOString(),
        },
        round: { round: 1 },
      },
    ], {
      reviewer: "codex",
      label: "codex self-review",
      review: {
        reviewer: "codex",
        command: ["codex"],
        exit_code: 0,
        stdout: "Self review found no blocking issues.",
        stderr: "",
        started_at: new Date(0).toISOString(),
        completed_at: new Date(0).toISOString(),
      },
      round: { round: 2 },
    });

    expect(output).toContain("Peer review outputs:");
    expect(output).toContain("--- claude peer review round 1 exit 0 ---");
    expect(output).toContain("Claude peer review output.");
    expect(output).toContain("Codex self-review output:");
    expect(output).toContain("Self review found no blocking issues.");
  });

  test("includes self-review guidance for Codex self-review prompts", async () => {
    const task: PeerTask = {
      id: "test-task",
      host: "codex",
      peer: "codex",
      prompt: "review self mode",
      cwd: process.cwd(),
      git_root: null,
      baseline_status: [],
      baseline_diff: "",
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
      status: "open",
    };

    const { prompt } = await buildReviewPrompt(task, { self_review: true });
    expect(SELF_REVIEW_PROMPT).toContain("self-review of your own implementation");
    expect(prompt).toContain("self-review of your own implementation");
    expect(prompt).toContain("shipping.\n\nFinding selection rules:");
    expect(prompt).toContain("Review perspective: self-review");
  });

  test("keeps adversarial framing in Codex self-review prompts", async () => {
    const task: PeerTask = {
      id: "test-task",
      host: "codex",
      peer: "codex",
      prompt: "review adversarial self mode",
      cwd: process.cwd(),
      git_root: null,
      baseline_status: [],
      baseline_diff: "",
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
      status: "open",
    };

    const { prompt } = await buildReviewPrompt(task, { self_review: true, mode: "adversarial" });
    expect(prompt).toContain("self-review of your own implementation");
    expect(prompt).toContain("challenge whether this change should ship");
    expect(prompt).toContain("Review mode: adversarial");
    expect(prompt).toContain("Review perspective: self-review");
    expect(ADVERSARIAL_REVIEW_PROMPT).toContain("challenge whether this change should ship");
  });

  test("ignores peer_fix workflow for Codex self-review prompts", async () => {
    const task: PeerTask = {
      id: "test-task",
      host: "codex",
      peer: "codex",
      prompt: "review self mode with peer fix",
      cwd: process.cwd(),
      git_root: null,
      baseline_status: [],
      baseline_diff: "",
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
      status: "open",
    };

    const { prompt } = await buildReviewPrompt(task, { self_review: true, workflow: "peer_fix" });
    const promptInstructions = prompt.split("\nIncluded uncommitted diff for review:")[0];
    expect(prompt).toContain("Review mode: normal");
    expect(promptInstructions).not.toContain("proposing fixes as a peer assistant");
    expect(promptInstructions).not.toContain(PEER_FIX_PROMPT);
  });

  test("rejects gate and collaborative modes for Codex self-review prompts", async () => {
    const task: PeerTask = {
      id: "test-task",
      host: "codex",
      peer: "codex",
      prompt: "review unsupported self-review modes",
      cwd: process.cwd(),
      git_root: null,
      baseline_status: [],
      baseline_diff: "",
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
      status: "open",
    };

    await expect(buildReviewPrompt(task, { self_review: true, mode: "gate" })).rejects.toThrow(
      "Codex self-review is only supported for normal and adversarial review modes",
    );
    await expect(buildReviewPrompt(task, { self_review: true, mode: "collaborative" })).rejects.toThrow(
      "Codex self-review is only supported for normal and adversarial review modes",
    );
  });
});
