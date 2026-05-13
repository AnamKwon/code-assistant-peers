import { describe, expect, test } from "bun:test";
import {
  COLLABORATIVE_REVIEW_PROMPT,
  REVIEW_FINDING_GUIDELINES,
  REVIEW_OUTPUT_GUIDELINES,
  REVIEWER_SYSTEM_PROMPT,
  buildReviewCommand,
  buildReviewPrompt,
  normalizeHost,
  normalizeReviewFocus,
  peerFor,
  truncateForReview,
} from "../shared/review.ts";
import { loadAssistantRegistry, getAssistantAdapter, peersFor } from "../shared/assistants.ts";
import { areConfiguredAssistantsReady, resolveMultiPeerTaskStatus } from "../shared/multi-peer.ts";
import { upsertCodexMcpTimeoutConfig } from "../shared/setup.ts";
import type { PeerTask } from "../shared/types.ts";

describe("assistant routing", () => {
  test("normalizes configured host", () => {
    expect(normalizeHost("claude")).toBe("claude");
    expect(normalizeHost("codex")).toBe("codex");
    expect(() => normalizeHost(undefined)).toThrow("HOST_ASSISTANT");
  });

  test("selects opposite peer", () => {
    expect(peerFor("claude")).toBe("codex");
    expect(peerFor("codex")).toBe("claude");
  });

  test("loads custom CLI assistants from environment JSON", () => {
    const registry = loadAssistantRegistry({
      CODE_ASSISTANT_PEERS_ASSISTANTS: JSON.stringify({
        gemini: {
          command: ["gemini", "-p"],
          prompt_transport: "argv",
          description: "Gemini CLI",
        },
        deepseek: {
          command: ["deepseek", "chat"],
          prompt_transport: "stdin",
        },
      }),
    } as NodeJS.ProcessEnv);

    expect(registry.gemini.command).toEqual(["gemini", "-p"]);
    expect(registry.gemini.prompt_transport).toBe("argv");
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
        gemini: { command: ["gemini", "-p"], prompt_transport: "argv" },
      }),
    } as NodeJS.ProcessEnv);

    expect(normalizeHost("glm", registry)).toBe("glm");
    expect(peerFor("glm", "gemini", undefined, registry)).toBe("gemini");
  });

  test("selects multiple peers from PEER_ASSISTANTS", () => {
    const registry = loadAssistantRegistry({
      CODE_ASSISTANT_PEERS_ASSISTANTS: JSON.stringify({
        gemini: { command: ["gemini", "-p"], prompt_transport: "argv" },
        glm: { command: ["glm"], prompt_transport: "stdin" },
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
});

describe("setup helpers", () => {
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
});

describe("review command construction", () => {
  test("codex reviewer uses read-only codex exec over stdin", () => {
    expect(buildReviewCommand("codex")).toEqual([
      "codex",
      "exec",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "-",
    ]);
  });

  test("claude reviewer uses print mode with read-only review instructions", () => {
    expect(buildReviewCommand("claude")).toEqual([
      "claude",
      "-p",
      "--permission-mode",
      "plan",
      "--system-prompt",
      REVIEWER_SYSTEM_PROMPT,
      "--allowedTools",
      "Read,Grep,Glob,Bash(git status:*),Bash(git diff:*),Bash(git show:*),Bash(git ls-files:*),mcp__code-assistant-peers__get_peer_task_context,mcp__code-assistant-peers__list_peer_review_rounds,mcp__code-assistant-peers__get_peer_review_round,mcp__code-assistant-peers__get_open_findings,mcp__code-assistant-peers__record_peer_review",
      "--disallowedTools",
      "Edit,Write,MultiEdit,NotebookEdit",
    ]);
  });

  test("custom argv reviewer commands append prompt as an argument", () => {
    const previous = process.env.CODE_ASSISTANT_PEERS_ASSISTANTS;
    process.env.CODE_ASSISTANT_PEERS_ASSISTANTS = JSON.stringify({
      gemini: { command: ["gemini", "-p"], prompt_transport: "argv" },
    });
    try {
      expect(getAssistantAdapter("gemini").prompt_transport).toBe("argv");
      expect(buildReviewCommand("gemini")).toEqual(["gemini", "-p"]);
    } finally {
      if (previous === undefined) delete process.env.CODE_ASSISTANT_PEERS_ASSISTANTS;
      else process.env.CODE_ASSISTANT_PEERS_ASSISTANTS = previous;
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
    expect(prompt).toContain("ALLOW: <short reason>");
    expect(prompt).toContain('"overall_correctness"');
    expect(prompt).toContain('"priority"');
    expect(prompt).toContain('"confidence": 0.8');
    expect(prompt).toContain('"overall_confidence": 0.8');
    expect(prompt).not.toContain("Start with findings.");
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
});
