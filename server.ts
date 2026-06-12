#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createHash } from "node:crypto";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { formatStatus, getGitRoot, getReviewDiff, getStatusEntries, getUncommittedDiff } from "./shared/git.ts";
import { captureWorkspaceSnapshot, emptyWorkspaceSnapshot } from "./shared/workspace-snapshot.ts";
import {
  COLLABORATIVE_REVIEW_PROMPT,
  buildReviewCommand,
  buildReviewCommandEnv,
  buildReviewModelRoutingContext,
  buildReviewPromptFromSnapshot,
  formatMultiPeerReviewOutputs,
  normalizeHost,
  normalizeReviewFocus,
  peerFor,
  prepareReviewPromptSnapshot,
  resolveReviewerModel,
  runReviewCommand,
  truncateForReview,
  type ReviewPromptSnapshotSeed,
} from "./shared/review.ts";
import {
  addFindings,
  appendReviewRound,
  appendReviewRoundAndSaveTask,
  claimStaleReviewRecovery,
  compactTaskHistory,
  gcStore,
  getReviewRound,
  listFindings,
  listReviewRounds,
  loadTask,
  saveTask,
} from "./shared/store.ts";
import { getAssistantAdapter, getGeminiAuthReadiness, liveHostReviewer, loadAssistantRegistry, peersFor } from "./shared/assistants.ts";
import { spawnWithTimeout } from "./shared/process.ts";
import { areConfiguredAssistantsReady, resolveMultiPeerTaskStatus, shouldRunHostSelfReview, summarizeMultiPeerAvailability } from "./shared/multi-peer.ts";
import type { AssistantHost, NewPeerReviewFinding, PeerReviewResult, PeerTask, PeerWorkflow, ReviewMode, ReviewRequestOptions, ReviewScope } from "./shared/types.ts";

if (process.env.CODE_ASSISTANT_PEERS_REVIEWER_SUBPROCESS === "1") {
  console.error("Refusing to start code-assistant-peers inside a reviewer subprocess to avoid recursive peer-review MCP calls.");
  process.exit(2);
}

const assistantRegistry = loadAssistantRegistry();
const host = normalizeHost(process.env.HOST_ASSISTANT, assistantRegistry);
const peers = peersFor(host, process.env.PEER_ASSISTANTS, process.env.PEER_ASSISTANT, assistantRegistry);
const peer = peers[0];
const REVIEW_OUTPUT_BUDGET = parseInt(process.env.CODE_ASSISTANT_PEERS_REVIEW_OUTPUT_BUDGET ?? "6000", 10);
const INCLUDE_SUCCESS_STDERR = process.env.CODE_ASSISTANT_PEERS_INCLUDE_SUCCESS_STDERR === "1";
const DEFAULT_WORKFLOW = normalizeWorkflow(process.env.CODE_ASSISTANT_PEERS_WORKFLOW);
const DEFAULT_REVIEW_MODE = normalizeDefaultReviewMode(process.env.CODE_ASSISTANT_PEERS_REVIEW_MODE);
const STALE_REVIEW_RECOVERY_MS = parsePositiveInteger(process.env.CODE_ASSISTANT_PEERS_STALE_REVIEW_MS) ?? defaultStaleReviewRecoveryMs();
const MODEL_PROBE_TIMEOUT_MS = parsePositiveInteger(process.env.CODE_ASSISTANT_PEERS_MODEL_PROBE_TIMEOUT_MS) ?? 30000;

type ReviewRoundOutcome = {
  reviewer: AssistantHost;
  label: string;
  review: PeerReviewResult;
  round: { round: number };
  prompt: string;
};

type ReviewStartContext = {
  requestSignature: string;
  snapshotSeed: ReviewPromptSnapshotSeed;
};

const asyncReviewLocks = new Map<string, Promise<void>>();
const activeAsyncReviews = new Set<string>();

function log(message: string): void {
  console.error(`[code-assistant-peers] ${message}`);
}

const REVIEW_MODEL_INPUT_PROPERTIES = {
  review_model: {
    type: "string" as const,
    description: "Optional reviewer model selected by the host coding agent for this request. Omit to use each reviewer CLI default. Use an explicit model id only when that same id is valid for every targeted reviewer CLI. Prefer review_models for mixed reviewer providers. Use \"auto\" only when the host wants this MCP server to choose from known model routing.",
  },
  review_models: {
    type: "object" as const,
    additionalProperties: { type: "string" as const },
    description: "Optional per-reviewer model mapping selected by the host coding agent, such as {\"claude\":\"opus\",\"codex\":\"gpt-5.5\"}. This overrides review_model for matching reviewers. A per-reviewer value of \"auto\" delegates only that reviewer to MCP automatic routing.",
  },
  force_review: {
    type: "boolean" as const,
    description: "Set true to re-run reviewers even when the repository state and review options match the latest completed review. Default false: an unchanged state reuses the recorded review instead of spending reviewer tokens again.",
  },
};

const HOST_MODEL_SELECTION_GUIDANCE = [
  "Host model selection policy:",
  "- Prefer explicit review_models when the host coding agent can match the reviewer to a known candidate from code_assistant_peers_setup.",
  "- Prefer review_models over review_model when reviewers use different providers because model ids are provider-specific.",
  "- Omit review_model/review_models to keep the reviewer CLI default model.",
  "- Use review_model=\"auto\" only when the host wants the MCP server to choose from the hardcoded model catalog.",
  "- Use fast models for small docs/tests/lint/copy/comment changes.",
  "- Use balanced models for ordinary code review and gate checks.",
  "- Use deep models for adversarial/collaborative/peer_fix reviews or security, auth, data loss, migration, release, database, privacy, race/concurrency, secrets, or performance risk.",
  "- Use long_context models for truncated diffs, very large diffs, or broad changes touching many files.",
  "Precedence: review_models[reviewer] > review_model > reviewer CLI default. If either value is \"auto\", the MCP server chooses for that scope. Do not pass a provider-specific model globally unless every targeted reviewer supports that same id.",
].join("\n");

const mcp = new Server(
  { name: "code-assistant-peers", version: "0.2.0-alpha.0" },
  {
    capabilities: { tools: {} },
    instructions: `You are connected to the code-assistant-peers workflow as ${host}.

	When the user asks for a code change:
	1. Call begin_peer_task before editing.
	2. Implement the change yourself.
	3. Call must_call_after_code_changes before your final answer. This required post-edit gate starts or reuses an async review job after any code edit, generated file, patch, format, refactor, or content change.
	4. Call wait_for_peer_review or get_peer_review_status until the task is reviewed, partial_failed, or review_failed.
	5. Report the ${peers.length > 1 ? peers.join(", ") : peer} review result to the user, including any actionable findings.
	
	All post-edit review gates are async-first to avoid MCP host timeout failures. Do not wait for a long synchronous review call.
	When the user asks to review, verify, validate, gate, or check code changes, prefer must_call_after_code_changes, finalize_code_changes_with_peer_review, verify_code_changes_after_edit, or request_peer_review over built-in slash review commands.
	When selecting reviewer models, you are the host coding agent. Prefer choosing explicit per-reviewer models from code_assistant_peers_setup when the request risk, size, and cost tradeoff are clear, especially when reviewers use different providers. Use review_model="auto" only when you want this MCP server to decide.
	The peer reviewer must not edit files. Treat review failures as reportable tool failures, not as implementation success.`,
  },
);

const TOOLS = [
  {
    name: "begin_peer_task",
    description: "START HERE before modifying code. Call this before editing, creating, deleting, formatting, refactoring, or generating files so the MCP can capture a baseline for mandatory peer review.",
    inputSchema: {
      type: "object" as const,
      properties: {
        prompt: {
          type: "string" as const,
          description: "The user's implementation request.",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "request_peer_review",
    description: `ASYNC PEER REVIEW REQUEST after code changes. Starts or reuses a background review by configured peer assistant(s) (${peers.join(", ")}) for an existing task, stores status in SQLite, and returns immediately. After this tool, call wait_for_peer_review or get_peer_review_status before final response. Do not use built-in /review as a substitute.\n\n${HOST_MODEL_SELECTION_GUIDANCE}`,
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: {
          type: "string" as const,
          description: "Task id returned by begin_peer_task.",
        },
        mode: {
          type: "string" as const,
          enum: ["normal", "adversarial", "gate", "collaborative"],
          description: "normal = standard bug review, adversarial = challenge design/assumptions, gate = compact ALLOW/BLOCK review, collaborative = both CLIs review/compare for stronger results at higher token cost.",
        },
        scope: {
          type: "string" as const,
          enum: ["auto", "working-tree", "branch"],
          description: "Review target selection. Defaults to working-tree unless base is supplied.",
        },
        base: {
          type: "string" as const,
          description: "Optional base branch/ref for branch review, such as main.",
        },
        change_summary: {
          type: "string" as const,
          description: "Short summary of the implementation just completed.",
        },
        files_changed: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "Files the host assistant believes it changed.",
        },
        focus: {
          type: "string" as const,
          description: "Optional review focus, such as security, data loss, performance, migration risk, UI regressions, or a specific concern from the user.",
        },
        semantic_context: {
          type: "string" as const,
          description: "Optional Serena-style semantic context to include in the review prompt, such as changed symbols, references, implementations, or diagnostics.",
        },
        workflow: {
          type: "string" as const,
          enum: ["review_only", "peer_fix"],
          description: "review_only only reviews. peer_fix asks the peer for concrete fix proposals, but still forbids direct file edits.",
        },
        ...REVIEW_MODEL_INPUT_PROPERTIES,
      },
      required: ["task_id"],
    },
  },
  {
    name: "verify_code_changes_after_edit",
    description: `ASYNC MANDATORY AFTER EDITING CODE. Call this after modifying, adding, deleting, generating, formatting, or refactoring files and before final response. Creates a task if needed, starts or reuses a background peer review, and returns task status immediately. Then call wait_for_peer_review until reviewed/partial_failed/review_failed. Prefer must_call_after_code_changes for final answers.\n\n${HOST_MODEL_SELECTION_GUIDANCE}`,
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: {
          type: "string" as const,
          description: "Existing task id. If omitted, a task is created automatically.",
        },
        prompt: {
          type: "string" as const,
          description: "Original user request or review purpose. Required when task_id is omitted.",
        },
        change_summary: {
          type: "string" as const,
          description: "Short summary of the implementation just completed.",
        },
        files_changed: {
          type: "array" as const,
          items: { type: "string" as const },
        },
        focus: {
          type: "string" as const,
          description: "Optional review focus, such as security, data loss, performance, migration risk, UI regressions, or a specific concern from the user.",
        },
        semantic_context: {
          type: "string" as const,
          description: "Optional Serena-style semantic context to include in the review prompt, such as changed symbols, references, implementations, or diagnostics.",
        },
        mode: {
          type: "string" as const,
          enum: ["normal", "adversarial", "gate", "collaborative"],
        },
        scope: {
          type: "string" as const,
          enum: ["auto", "working-tree", "branch"],
        },
        base: {
          type: "string" as const,
        },
        workflow: {
          type: "string" as const,
          enum: ["review_only", "peer_fix"],
        },
        ...REVIEW_MODEL_INPUT_PROPERTIES,
      },
    },
  },
  {
    name: "finalize_code_changes_with_peer_review",
    description: `ASYNC MANDATORY FINALIZATION GATE after editing files. Call this before the final response whenever code was modified, added, deleted, generated, formatted, or refactored. It starts or reuses peer verification with the opposite assistant in the background, stores status in SQLite, and requires wait_for_peer_review/get_peer_review_status before final response. Do not use built-in /review instead.\n\n${HOST_MODEL_SELECTION_GUIDANCE}`,
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: {
          type: "string" as const,
          description: "Existing task id. If omitted, a task is created automatically.",
        },
        prompt: {
          type: "string" as const,
          description: "Original user request or review purpose. Required when task_id is omitted.",
        },
        change_summary: {
          type: "string" as const,
          description: "Short summary of the implementation just completed.",
        },
        files_changed: {
          type: "array" as const,
          items: { type: "string" as const },
        },
        focus: {
          type: "string" as const,
          description: "Optional review focus, such as security, data loss, performance, migration risk, UI regressions, or a specific concern from the user.",
        },
        semantic_context: {
          type: "string" as const,
          description: "Optional Serena-style semantic context to include in the review prompt, such as changed symbols, references, implementations, or diagnostics.",
        },
        mode: {
          type: "string" as const,
          enum: ["normal", "adversarial", "gate", "collaborative"],
        },
        scope: {
          type: "string" as const,
          enum: ["auto", "working-tree", "branch"],
        },
        base: {
          type: "string" as const,
        },
        workflow: {
          type: "string" as const,
          enum: ["review_only", "peer_fix"],
        },
        ...REVIEW_MODEL_INPUT_PROPERTIES,
      },
    },
  },
  {
    name: "must_call_after_code_changes",
    description: `ABSOLUTE REQUIRED ASYNC POST-EDIT MCP GATE. If you changed, created, deleted, generated, formatted, or refactored any code or project file, you must call this tool before final response. This starts or reuses background peer review and verification through code-assistant-peers, records status in SQLite, and requires wait_for_peer_review/get_peer_review_status before final response. Never substitute built-in /review for this required MCP call.\n\n${HOST_MODEL_SELECTION_GUIDANCE}`,
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: {
          type: "string" as const,
          description: "Existing task id. If omitted, a task is created automatically.",
        },
        prompt: {
          type: "string" as const,
          description: "Original user request or review purpose. Required when task_id is omitted.",
        },
        change_summary: {
          type: "string" as const,
          description: "Short summary of the implementation just completed.",
        },
        files_changed: {
          type: "array" as const,
          items: { type: "string" as const },
        },
        focus: {
          type: "string" as const,
          description: "Optional review focus, such as security, data loss, performance, migration risk, UI regressions, or a specific concern from the user.",
        },
        semantic_context: {
          type: "string" as const,
          description: "Optional Serena-style semantic context to include in the review prompt, such as changed symbols, references, implementations, or diagnostics.",
        },
        mode: {
          type: "string" as const,
          enum: ["normal", "adversarial", "gate", "collaborative"],
        },
        scope: {
          type: "string" as const,
          enum: ["auto", "working-tree", "branch"],
        },
        base: {
          type: "string" as const,
        },
        workflow: {
          type: "string" as const,
          enum: ["review_only", "peer_fix"],
        },
        ...REVIEW_MODEL_INPUT_PROPERTIES,
      },
    },
  },
  {
    name: "start_peer_review_async",
    description: `ASYNC POST-EDIT REVIEW START. Starts or reuses peer review in the background, stores queued/running/reviewed/partial_failed/review_failed state in SQLite, and returns immediately with a task id. After calling this, you MUST call wait_for_peer_review or get_peer_review_status before final response.\n\n${HOST_MODEL_SELECTION_GUIDANCE}`,
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: {
          type: "string" as const,
          description: "Existing task id. If omitted, a task is created automatically.",
        },
        prompt: {
          type: "string" as const,
          description: "Original user request or review purpose. Required when task_id is omitted.",
        },
        change_summary: {
          type: "string" as const,
          description: "Short summary of the implementation just completed.",
        },
        files_changed: {
          type: "array" as const,
          items: { type: "string" as const },
        },
        focus: {
          type: "string" as const,
          description: "Optional review focus, such as security, data loss, performance, migration risk, UI regressions, or a specific concern from the user.",
        },
        semantic_context: {
          type: "string" as const,
          description: "Optional Serena-style semantic context to include in the review prompt, such as changed symbols, references, implementations, or diagnostics.",
        },
        mode: {
          type: "string" as const,
          enum: ["normal", "adversarial", "gate", "collaborative"],
        },
        scope: {
          type: "string" as const,
          enum: ["auto", "working-tree", "branch"],
        },
        base: {
          type: "string" as const,
        },
        workflow: {
          type: "string" as const,
          enum: ["review_only", "peer_fix"],
        },
        ...REVIEW_MODEL_INPUT_PROPERTIES,
      },
    },
  },
  {
    name: "wait_for_peer_review",
    description: "WAIT FOR ASYNC PEER REVIEW. Polls SQLite task state for a background review and waits briefly for completion. Use after start_peer_review_async, and repeat if status is queued/running. Keep timeout_seconds below the host MCP timeout.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: {
          type: "string" as const,
          description: "Task id returned by start_peer_review_async or begin_peer_task.",
        },
        timeout_seconds: {
          type: "number" as const,
          description: "Maximum seconds to wait in this call. Defaults to 30 and is capped at 90.",
        },
        poll_interval_ms: {
          type: "number" as const,
          description: "Polling interval in milliseconds. Defaults to 1000.",
        },
      },
      required: ["task_id"],
    },
  },
  {
    name: "get_peer_review_status",
    description: "READ ASYNC REVIEW STATUS. Returns the SQLite task status, review round count, latest round preview, and open findings. Use this to decide whether a background peer review is queued, running, reviewed, partial_failed, or review_failed.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: {
          type: "string" as const,
          description: "Task id returned by start_peer_review_async or begin_peer_task.",
        },
      },
      required: ["task_id"],
    },
  },
  {
    name: "code_assistant_peers_setup",
    description: "Check whether configured assistant CLIs and MCP runtime assumptions are ready.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "peer_task_status",
    description: "Show saved task metadata and review result.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: {
          type: "string" as const,
          description: "Task id returned by begin_peer_task.",
        },
      },
      required: ["task_id"],
    },
  },
  {
    name: "get_peer_task_context",
    description: "Read persistent task context, current status, bounded diff, prior review rounds, and open findings for a task id.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: {
          type: "string" as const,
          description: "Task id returned by begin_peer_task.",
        },
      },
      required: ["task_id"],
    },
  },
  {
    name: "list_peer_review_rounds",
    description: "List prior peer review rounds for a task without returning full prompts.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: { type: "string" as const },
      },
      required: ["task_id"],
    },
  },
  {
    name: "get_peer_review_round",
    description: "Read one full peer review round by task id and round number.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: { type: "string" as const },
        round: { type: "number" as const },
      },
      required: ["task_id", "round"],
    },
  },
  {
    name: "get_open_findings",
    description: "List unresolved findings recorded for a task.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: { type: "string" as const },
      },
      required: ["task_id"],
    },
  },
  {
    name: "record_peer_review",
    description: "Persist a concise review summary and structured findings for the current task. Intended for print-mode peer reviewers.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: { type: "string" as const },
        reviewer: { type: "string" as const },
        summary: { type: "string" as const },
        findings: {
          type: "array" as const,
          items: {
            type: "object" as const,
            properties: {
              severity: { type: "string" as const },
              file: { type: "string" as const },
              line: { type: "number" as const },
              message: { type: "string" as const },
              status: {
                type: "string" as const,
                enum: ["open", "addressed", "dismissed", "unknown"],
              },
            },
            required: ["severity", "message"],
          },
        },
      },
      required: ["task_id", "summary", "findings"],
    },
  },
  {
    name: "compact_peer_history",
    description: "Create a compact persistent summary for a task's accumulated review history.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_id: { type: "string" as const },
      },
      required: ["task_id"],
    },
  },
  {
    name: "gc_peer_store",
    description: "Garbage collect old resolved review rounds and compaction records. Open findings are preserved.",
    inputSchema: {
      type: "object" as const,
      properties: {
        days: {
          type: "number" as const,
          description: "Delete eligible records older than this many days. Defaults to 30.",
        },
      },
    },
  },
];

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  switch (name) {
    case "begin_peer_task": {
      const prompt = String((args as { prompt?: unknown }).prompt ?? "").trim();
      if (!prompt) {
        return textResult("prompt is required", true);
      }

      const task = await createPeerTask(prompt);
      const dirtyNote = task.baseline_status.length > 0
        ? `\nWarning: baseline working tree was dirty (${task.baseline_status.length} path(s)).`
        : "";
      return textResult(`Started peer task ${task.id}. Implement the change, then call must_call_after_code_changes.${dirtyNote}`);
    }

    case "request_peer_review": {
      const taskId = String((args as { task_id?: unknown }).task_id ?? "").trim();
      const task = await loadTask(taskId);
      if (!task) return textResult(`Task not found: ${taskId}`, true);
      return await startOrReuseAsyncPeerReview(task, parseReviewOptions(args), "Requested async peer review");
    }

    case "verify_code_changes_after_edit": {
      return await runAsyncReviewGateTool(args, "Code changes require peer review");
    }

    case "finalize_code_changes_with_peer_review": {
      return await runAsyncReviewGateTool(args, "Code changes require final peer review");
    }

    case "must_call_after_code_changes": {
      return await runAsyncReviewGateTool(args, "Code changes require mandatory peer review");
    }

    case "start_peer_review_async": {
      return await startAsyncReviewTool(args, "Code changes require async peer review");
    }

    case "wait_for_peer_review": {
      return await waitForPeerReviewTool(args);
    }

    case "get_peer_review_status": {
      const taskId = String((args as { task_id?: unknown }).task_id ?? "").trim();
      const task = await loadTask(taskId);
      if (!task) return textResult(`Task not found: ${taskId}`, true);
      return textResult(await buildReviewStatusJson(task), task.status === "review_failed");
    }

    case "code_assistant_peers_setup": {
      return textResult(JSON.stringify(await buildSetupStatus(), null, 2));
    }

    case "peer_task_status": {
      const taskId = String((args as { task_id?: unknown }).task_id ?? "").trim();
      const task = await loadTask(taskId);
      if (!task) return textResult(`Task not found: ${taskId}`, true);
      const rounds = await listReviewRounds(taskId);
      const findings = await listFindings(taskId);
      return textResult(JSON.stringify({ task: redactTaskForToolResult(task), rounds, findings }, null, 2));
    }

    case "get_peer_task_context": {
      const taskId = String((args as { task_id?: unknown }).task_id ?? "").trim();
      const task = await loadTask(taskId);
      if (!task) return textResult(`Task not found: ${taskId}`, true);
      const [currentStatus, currentReviewContext, rounds, openFindings] = await Promise.all([
        getStatusEntries(task.cwd),
        getReviewDiff(task.cwd, {
          baselineWorkspaceSnapshot: task.baseline_workspace_snapshot
            ?? (task.git_root === null
              ? emptyWorkspaceSnapshot("No pre-edit baseline snapshot was captured; current non-git files are reported as added for review.")
              : null),
        }),
        listReviewRounds(taskId),
        listFindings(taskId, "open"),
      ]);
      return textResult(JSON.stringify({
        task: redactTaskForToolResult(task),
        baseline_status: formatStatus(task.baseline_status),
        current_status: formatStatus(currentStatus),
        current_diff: truncateForReview(currentReviewContext.diff, 30_000),
        prior_rounds: rounds.map((round) => ({
          id: round.id,
          round: round.round,
          reviewer: round.reviewer,
          exit_code: round.exit_code,
          completed_at: round.completed_at,
          output_preview: truncateForReview(round.stdout || round.stderr, 2000),
        })),
        open_findings: openFindings,
      }, null, 2));
    }

    case "list_peer_review_rounds": {
      const taskId = String((args as { task_id?: unknown }).task_id ?? "").trim();
      const rounds = await listReviewRounds(taskId);
      return textResult(JSON.stringify(rounds.map((round) => ({
        id: round.id,
        task_id: round.task_id,
        round: round.round,
        reviewer: round.reviewer,
        exit_code: round.exit_code,
        warning: round.warning,
        started_at: round.started_at,
        completed_at: round.completed_at,
        stdout_preview: truncateForReview(round.stdout, 2000),
        stderr_preview: truncateForReview(round.stderr, 1000),
      })), null, 2));
    }

    case "get_peer_review_round": {
      const taskId = String((args as { task_id?: unknown }).task_id ?? "").trim();
      const roundNumber = Number((args as { round?: unknown }).round);
      if (!Number.isFinite(roundNumber)) return textResult("round must be a number", true);
      const round = await getReviewRound(taskId, roundNumber);
      if (!round) return textResult(`Review round not found: ${taskId} round ${roundNumber}`, true);
      return textResult(JSON.stringify(round, null, 2));
    }

    case "get_open_findings": {
      const taskId = String((args as { task_id?: unknown }).task_id ?? "").trim();
      return textResult(JSON.stringify(await listFindings(taskId, "open"), null, 2));
    }

    case "record_peer_review": {
      const parsed = args as {
        task_id?: unknown;
        reviewer?: unknown;
        summary?: unknown;
        findings?: unknown;
      };
      const taskId = String(parsed.task_id ?? "").trim();
      const reviewer = String(parsed.reviewer ?? peer).trim();
      const summary = String(parsed.summary ?? "").trim();
      const task = await loadTask(taskId);
      if (!task) return textResult(`Task not found: ${taskId}`, true);
      const allowedReviewers = new Set([task.peer, ...(task.peers ?? [])]);
      if (!allowedReviewers.has(reviewer)) return textResult(`reviewer must be one of: ${[...allowedReviewers].join(", ")}`, true);
      if (!summary) return textResult("summary is required", true);
      if (!Array.isArray(parsed.findings)) return textResult("findings must be an array", true);

      const findings = parsed.findings.map(normalizeFinding);
      const now = new Date().toISOString();
      const round = await appendReviewRound(task, {
        reviewer,
        command: ["mcp", "record_peer_review"],
        exit_code: 0,
        stdout: summary,
        stderr: "",
        started_at: now,
        completed_at: now,
      }, summary);
      const inserted = await addFindings(taskId, round.id, findings);
      return textResult(`Recorded review round ${round.round} with ${inserted.length} finding(s).`);
    }

    case "compact_peer_history": {
      const taskId = String((args as { task_id?: unknown }).task_id ?? "").trim();
      return textResult(await compactTaskHistory(taskId));
    }

    case "gc_peer_store": {
      const days = Number((args as { days?: unknown }).days ?? 30);
      if (!Number.isFinite(days) || days < 1) return textResult("days must be a positive number", true);
      return textResult(JSON.stringify(await gcStore(days), null, 2));
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    isError,
  };
}

function buildFailureReviewResult(reviewer: AssistantHost, failureMessage: string): PeerReviewResult {
  const now = new Date().toISOString();
  return {
    reviewer,
    command: ["async-peer-review-preflight"],
    exit_code: 1,
    stdout: "",
    stderr: failureMessage,
    started_at: now,
    completed_at: now,
    warning: failureMessage,
  };
}

async function withAsyncReviewLock<T>(taskId: string, action: () => Promise<T>): Promise<T> {
  const previousLock = asyncReviewLocks.get(taskId) ?? Promise.resolve();
  let releaseLock: (() => void) | undefined;
  const currentLock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const chainedLock = previousLock.then(() => currentLock);
  asyncReviewLocks.set(taskId, chainedLock);

  await previousLock.catch(() => undefined);
  try {
    return await action();
  } finally {
    releaseLock?.();
    if (asyncReviewLocks.get(taskId) === chainedLock) {
      asyncReviewLocks.delete(taskId);
    }
  }
}

function buildReviewRequestSignatureFromState(
  task: PeerTask,
  options: ReviewRequestOptions,
  reviewState: { statusEntries: PeerTask["baseline_status"]; diff: string },
): string {
  // NOTE: change_summary / files_changed are deliberately EXCLUDED. They are host-written free
  // text that hosts reword on every call, so including them made the signature differ while the
  // actual repository state (git_status + git_diff below) was identical — defeating the
  // same-state dedup and superseding in-flight reviews for no reason. They still flow into the
  // review prompt; they just don't define "did anything reviewable change". Use force_review to
  // re-run a review for an unchanged state.
  const payload = {
    cwd: task.cwd,
    host: task.host,
    peer: task.peer,
    peers: task.peers ?? [task.peer],
    prompt: task.prompt,
    mode: options.mode ?? "normal",
    scope: options.scope ?? "auto",
    base: options.base ?? null,
    workflow: options.workflow ?? "review_only",
    focus: normalizeReviewFocus(options.focus ?? process.env.CODE_ASSISTANT_PEERS_REVIEW_FOCUS),
    semantic_context: options.semantic_context ?? null,
    self_review: options.self_review ?? false,
    review_model: options.review_model ?? null,
    review_models: options.review_models ?? {},
    git_status: reviewState.statusEntries,
    git_diff: reviewState.diff,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

async function captureReviewStartContext(task: PeerTask, options: ReviewRequestOptions): Promise<ReviewStartContext> {
  const [statusEntries, reviewContext] = await Promise.all([
    getStatusEntries(task.cwd),
    getReviewDiff(task.cwd, {
      scope: options.scope,
      base: options.base,
      baselineWorkspaceSnapshot: task.baseline_workspace_snapshot
        ?? (task.git_root === null
          ? emptyWorkspaceSnapshot("No pre-edit baseline snapshot was captured; current non-git files are reported as added for review.")
          : null),
    }),
  ]);
  return {
    requestSignature: buildReviewRequestSignatureFromState(task, options, {
      statusEntries,
      diff: reviewContext.diff,
    }),
    snapshotSeed: {
      currentStatus: statusEntries,
      reviewContext,
    },
  };
}

function buildLegacyReviewRequestSignature(task: PeerTask, options: ReviewRequestOptions): string {
  return buildReviewRequestSignatureFromState(task, options, {
    statusEntries: task.baseline_status,
    diff: task.baseline_diff,
  });
}

async function recordReviewFailure(task: PeerTask, reviewer: AssistantHost, failureMessage: string): Promise<void> {
  task.review = buildFailureReviewResult(reviewer, failureMessage);
  task.status = "review_failed";
  task.updated_at = task.review.completed_at;
  try {
    await appendReviewRoundAndSaveTask(task, task.review, failureMessage);
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    log(`Could not append synthetic failure round for task ${task.id}: ${message}`);
  }
}

async function canFinalizeReview(taskId: string, expectedSignature?: string): Promise<boolean> {
  if (!expectedSignature) return true;
  const current = await loadTask(taskId);
  return Boolean(current && current.status === "running" && current.review_signature === expectedSignature);
}

async function withReviewCommitLock<T>(
  taskId: string,
  expectedSignature: string | undefined,
  action: (current: PeerTask) => Promise<T>,
): Promise<T | null> {
  return await withAsyncReviewLock(taskId, async () => {
    const current = await loadTask(taskId);
    if (!current || !(expectedSignature ? current.review_signature === expectedSignature && current.status === "running" : true)) {
      return null;
    }
    return await action(current);
  });
}

async function withReviewFailureCommitLock<T>(
  taskId: string,
  expectedSignature: string | undefined,
  action: (current: PeerTask) => Promise<T>,
): Promise<T | null> {
  return await withAsyncReviewLock(taskId, async () => {
    if (!expectedSignature) {
      const current = await loadTask(taskId);
      if (!current) return null;
      return await action(current);
    }
    const current = await loadTask(taskId);
    if (!current || current.review_signature !== expectedSignature || (current.status !== "queued" && current.status !== "running")) {
      return null;
    }
    return await action(current);
  });
}

async function createPeerTask(
  prompt: string,
  seed?: ReviewPromptSnapshotSeed,
  options: { persist?: boolean; nonGitBaseline?: "snapshot" | "empty" } = {},
): Promise<PeerTask> {
  const cwd = process.cwd();
  const gitRoot = await getGitRoot(cwd);
  const baselineStatus = seed?.currentStatus ?? await getStatusEntries(cwd);
  const baselineDiff = seed?.reviewContext.diff ?? await getUncommittedDiff(cwd);
  const baselineWorkspaceSnapshot = gitRoot
    ? null
    : options.nonGitBaseline === "empty"
      ? emptyWorkspaceSnapshot("No pre-edit baseline snapshot was captured; current non-git files are reported as added for review.")
      : await captureWorkspaceSnapshot(cwd);
  const now = new Date().toISOString();
  const task: PeerTask = {
    id: crypto.randomUUID(),
    host,
    peer,
    peers,
    prompt,
    cwd,
    git_root: gitRoot,
    baseline_status: baselineStatus,
    baseline_diff: baselineDiff,
    baseline_workspace_snapshot: baselineWorkspaceSnapshot,
    created_at: now,
    updated_at: now,
    status: "open",
  };
  if (options.persist !== false) {
    await saveTask(task);
  }
  return task;
}

async function runAsyncReviewGateTool(args: unknown, defaultPrompt: string) {
  const parsed = args as { task_id?: unknown; prompt?: unknown };
  const taskId = String(parsed.task_id ?? "").trim();
  const task = taskId
    ? await loadTask(taskId)
    : await createPeerTask(String(parsed.prompt ?? defaultPrompt).trim(), undefined, { nonGitBaseline: "empty" });
  if (!task) return textResult(`Task not found: ${taskId}`, true);
  return await startOrReuseAsyncPeerReview(task, parseReviewOptions(args), "Mandatory async peer review gate");
}

async function startAsyncReviewTool(args: unknown, defaultPrompt: string) {
  const parsed = args as { task_id?: unknown; prompt?: unknown };
  const taskId = String(parsed.task_id ?? "").trim();
  const task = taskId
    ? await loadTask(taskId)
    : await createPeerTask(String(parsed.prompt ?? defaultPrompt).trim(), undefined, { nonGitBaseline: "empty" });
  if (!task) return textResult(`Task not found: ${taskId}`, true);
  return await startOrReuseAsyncPeerReview(task, parseReviewOptions(args), "Started async peer review");
}

function redactTaskForToolResult(task: PeerTask): PeerTask {
  const redacted = structuredClone(task);
  const snapshot = redacted.baseline_workspace_snapshot;
  if (!snapshot) return redacted;
  for (const entry of Object.values(snapshot.files)) {
    if (!entry.sensitive) continue;
    entry.fingerprint = "[redacted sensitive fingerprint]";
    if (entry.sha256) entry.sha256 = "[redacted sensitive fingerprint]";
  }
  return redacted;
}

function startBackgroundAsyncReview(
  task: PeerTask,
  options: ReviewRequestOptions,
  expectedSignature?: string,
  promptSnapshotSeed?: ReviewPromptSnapshotSeed,
): void {
  activeAsyncReviews.add(task.id);
  void runAsyncPeerReview(task, options, expectedSignature, promptSnapshotSeed);
}

async function startOrReuseAsyncPeerReview(task: PeerTask, options: ReviewRequestOptions, label: string) {
  return await withAsyncReviewLock(task.id, async () => {
    const current = await loadTask(task.id) ?? task;
    const startContext = await captureReviewStartContext(current, options);
    const requestSignature = startContext.requestSignature;
    const currentSignature = current.review_signature ?? buildLegacyReviewRequestSignature(current, options);
    const hasSensitivePossibleChange = startContext.snapshotSeed.reviewContext.diff.includes("sensitive path");
    const hasNoNonGitBaseline = current.git_root === null && !current.baseline_workspace_snapshot;

    if (currentSignature === requestSignature && isTerminalReviewStatus(current.status) && !hasSensitivePossibleChange && !hasNoNonGitBaseline && options.force_review !== true) {
      return textResult([
        `Peer review already completed for task ${current.id}.`,
        "The repository state and review options match the latest recorded review, so no reviewer was re-run (no extra tokens spent). Pass force_review=true to re-run anyway.",
        "Call wait_for_peer_review with this task_id before your final response.",
        await buildReviewStatusJson(current),
      ].join("\n\n"));
    }

    if (current.status === "queued" || current.status === "running") {
      if (currentSignature === requestSignature) {
        if (!activeAsyncReviews.has(current.id) && isStaleReviewState(current)) {
          const staleStatus = current.status;
          const claimed = await claimStaleReviewRecovery(
            current.id,
            requestSignature,
            new Date(Date.now() - STALE_REVIEW_RECOVERY_MS).toISOString(),
          );
          if (!claimed) {
            const refreshed = await loadTask(current.id) ?? current;
            return textResult([
              `Peer review is already ${refreshed.status} for task ${refreshed.id}.`,
              "Another MCP server process appears to have claimed or refreshed this review state.",
              "No duplicate reviewer process was started.",
              "Call wait_for_peer_review with this task_id before your final response.",
              await buildReviewStatusJson(refreshed),
            ].join("\n\n"));
          }
          startBackgroundAsyncReview(claimed, options, requestSignature, startContext.snapshotSeed);
          return textResult([
            `${label} for task ${claimed.id}.`,
            `Recovered stale ${staleStatus} review state: no active reviewer job exists in this MCP server process, so a fresh background review was started for the same snapshot.`,
            "Status is stored in SQLite as queued/running/reviewed/partial_failed/review_failed.",
            "Call wait_for_peer_review with this task_id before your final response.",
            await buildReviewStatusJson(claimed),
          ].join("\n\n"));
        }
        if (current.review_signature !== requestSignature) {
          current.review_signature = requestSignature;
          current.updated_at = new Date().toISOString();
          await saveTask(current);
        }
        return textResult([
          `Peer review is already ${current.status} for task ${current.id}.`,
          "No duplicate reviewer process was started.",
          "Call wait_for_peer_review with this task_id before your final response.",
          await buildReviewStatusJson(current),
        ].join("\n\n"));
      }

      const failureMessage = [
        `Peer review task ${current.id} was superseded because the repository state changed while it was ${current.status}.`,
        "A fresh review task was started with the newer repository snapshot.",
      ].join("\n");
      await recordReviewFailure(current, current.host, failureMessage);

      const replacement = await createPeerTask(current.prompt, startContext.snapshotSeed, { persist: false });
      replacement.host = current.host;
      replacement.peer = current.peer;
      replacement.peers = current.peers;
      replacement.cwd = current.cwd;
      replacement.git_root = current.git_root;
      replacement.status = "queued";
      replacement.review_signature = requestSignature;
      replacement.updated_at = new Date().toISOString();
      await saveTask(replacement);
      startBackgroundAsyncReview(replacement, options, requestSignature, startContext.snapshotSeed);

      return textResult([
        `${label} for task ${replacement.id}.`,
        `The previous task ${current.id} was marked review_failed because it became stale while running.`,
        "Status is stored in SQLite as queued/running/reviewed/partial_failed/review_failed.",
        "Call wait_for_peer_review with this task_id before your final response.",
        await buildReviewStatusJson(replacement),
      ].join("\n\n"));
    }

    current.status = "queued";
    current.updated_at = new Date().toISOString();
    current.review_signature = requestSignature;
    await saveTask(current);
    startBackgroundAsyncReview(current, options, requestSignature, startContext.snapshotSeed);

    return textResult([
      `${label} for task ${current.id}.`,
      "Status is stored in SQLite as queued/running/reviewed/partial_failed/review_failed.",
      "Call wait_for_peer_review with this task_id before your final response.",
      await buildReviewStatusJson(current),
    ].join("\n\n"));
  });
}

async function runAsyncPeerReview(
  initialTask: PeerTask,
  options: ReviewRequestOptions,
  expectedSignature?: string,
  promptSnapshotSeed?: ReviewPromptSnapshotSeed,
): Promise<void> {
  let task = initialTask;
  activeAsyncReviews.add(initialTask.id);
  try {
    const startedTask = await withAsyncReviewLock(initialTask.id, async () => {
      const current = await loadTask(initialTask.id) ?? initialTask;
      if (expectedSignature && (current.review_signature !== expectedSignature || (current.status !== "queued" && current.status !== "running"))) {
        log(`Async review for task ${initialTask.id} was superseded before it started.`);
        return null;
      }
      current.status = "running";
      current.updated_at = new Date().toISOString();
      await saveTask(current);
      return current;
    });
    if (!startedTask) return;
    task = startedTask;
    await runPeerReviewTool(task, options, expectedSignature, promptSnapshotSeed);
  } catch (error) {
    const now = new Date().toISOString();
    let failedTask = task;
    try {
      failedTask = await loadTask(initialTask.id) ?? task;
    } catch {
      failedTask = task;
    }
    const message = error instanceof Error ? error.stack || error.message : String(error);
    const failureReview: PeerReviewResult = {
      reviewer: failedTask.peers && failedTask.peers.length > 1 ? "async-multi-peer-review" : failedTask.peer,
      command: ["async-peer-review"],
      exit_code: 1,
      stdout: "",
      stderr: message,
      started_at: now,
      completed_at: now,
    };
    failedTask.review = failureReview;
    failedTask.status = "review_failed";
    failedTask.updated_at = now;
    try {
      const committed = await withReviewFailureCommitLock(initialTask.id, expectedSignature, async (current) => {
        current.review = failureReview;
        current.status = "review_failed";
        current.updated_at = now;
        await appendReviewRoundAndSaveTask(current, failureReview, "(async review failed before reviewer completed)");
        return true;
      });
      if (!committed) {
        log(`Async review failure for task ${initialTask.id} was superseded before it could be persisted.`);
        return;
      }
    } catch (saveError) {
      const saveMessage = saveError instanceof Error ? saveError.stack || saveError.message : String(saveError);
      log(`Async review failed and could not persist failure for task ${initialTask.id}: ${saveMessage}`);
    }
    log(`Async review failed for task ${initialTask.id}: ${message}`);
  } finally {
    activeAsyncReviews.delete(initialTask.id);
  }
}

async function waitForPeerReviewTool(args: unknown) {
  const parsed = args as { task_id?: unknown; timeout_seconds?: unknown; poll_interval_ms?: unknown };
  const taskId = String(parsed.task_id ?? "").trim();
  if (!taskId) return textResult("task_id is required", true);
  const timeoutSeconds = clampNumber(Number(parsed.timeout_seconds ?? 30), 1, 90);
  const pollIntervalMs = clampNumber(Number(parsed.poll_interval_ms ?? 1000), 250, 5000);
  const deadline = Date.now() + timeoutSeconds * 1000;

  while (Date.now() <= deadline) {
    const task = await loadTask(taskId);
    if (!task) return textResult(`Task not found: ${taskId}`, true);
    if (isTerminalReviewStatus(task.status)) {
      return textResult(await buildReviewStatusJson(task), task.status === "review_failed");
    }
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  }

  const task = await loadTask(taskId);
  if (!task) return textResult(`Task not found: ${taskId}`, true);
  if (isTerminalReviewStatus(task.status)) {
    return textResult(await buildReviewStatusJson(task), task.status === "review_failed");
  }
  return textResult([
    `Peer review is still ${task.status} for task ${task.id}.`,
    "Call wait_for_peer_review again, or call get_peer_review_status to inspect current SQLite state.",
    await buildReviewStatusJson(task),
  ].join("\n\n"));
}

async function runPeerReviewTool(
  task: PeerTask,
  options: ReviewRequestOptions,
  expectedSignature?: string,
  promptSnapshotSeed?: ReviewPromptSnapshotSeed,
) {
  const taskPeers = task.peers?.length ? task.peers : [task.peer];
  if (taskPeers.length > 1 || shouldRunHostSelfReview(task.host, options.mode)) {
    const promptSnapshot = await prepareReviewPromptSnapshot(task, options, promptSnapshotSeed);
    return await runMultiPeerReviewTool(task, options, taskPeers, promptSnapshot, expectedSignature);
  }

  if (options.mode === "collaborative") {
    const availability = await Promise.all([task.peer, task.host].map(async (reviewer) => ({
      reviewer,
      available: await isAssistantAvailable(reviewer),
    })));
    const skippedPeers = availability.filter((item) => !item.available.ok);
    if (skippedPeers.length > 0) {
      const failureMessage = [
        `Collaborative review could not start for task ${task.id}.`,
        ...skippedPeers.map((item) => `Skipped ${item.reviewer}: ${item.available.detail}`),
      ].join("\n");
      const failureCommitted = await withReviewCommitLock(task.id, expectedSignature, async (current) => {
        await recordReviewFailure(current, skippedPeers[0]?.reviewer ?? task.peer, failureMessage);
        return true;
      });
      if (!failureCommitted) {
        log(`Skipping stale collaborative preflight failure for task ${task.id}.`);
        return textResult("Review was superseded by a newer request.", true);
      }
      return textResult(failureMessage, true);
    }
    const promptSnapshot = await prepareReviewPromptSnapshot(task, options, promptSnapshotSeed);
    return await runCollaborativeReviewTool(task, options, promptSnapshot, expectedSignature);
  }

  const peerAvailability = await isAssistantAvailable(task.peer);
  if (!peerAvailability.ok) {
    const failureMessage = [
      `No configured peer assistant is available for task ${task.id}.`,
      `Skipped ${task.peer}: ${peerAvailability.detail}`,
    ].join("\n");
    const failureCommitted = await withReviewCommitLock(task.id, expectedSignature, async (current) => {
      await recordReviewFailure(current, task.peer, failureMessage);
      return true;
    });
    if (!failureCommitted) {
      log(`Skipping stale single-peer preflight failure for task ${task.id}.`);
      return textResult("Review was superseded by a newer request.", true);
    }
    return textResult(failureMessage, true);
  }

  const promptSnapshot = await prepareReviewPromptSnapshot(task, options, promptSnapshotSeed);
  const startedAt = new Date().toISOString();
  const { prompt, warning } = buildReviewPromptFromSnapshot(task, options, promptSnapshot);
  const result = await runReviewCommand(
    task.peer,
    task.cwd,
    prompt,
    resolveReviewerModel(task.peer, options, buildReviewModelRoutingContext(options, promptSnapshot)),
  );
  const completedAt = new Date().toISOString();

  const commitResult = await withReviewCommitLock(task.id, expectedSignature, async (current) => {
    current.review = {
      reviewer: task.peer,
      command: result.command,
      exit_code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      started_at: startedAt,
      completed_at: completedAt,
      warning,
    };
    current.status = result.exitCode === 0 ? "reviewed" : "review_failed";
    current.updated_at = completedAt;
    return await appendReviewRoundAndSaveTask(current, current.review, prompt);
  });
  if (!commitResult) {
    log(`Skipping stale single-peer review commit for task ${task.id}.`);
    return textResult("Review was superseded by a newer request.", true);
  }
  const round = commitResult;

  const body = [
    `${task.peer} ${options.mode ?? "normal"} review round ${round.round} ${result.exitCode === 0 ? "completed" : "failed"} for task ${task.id}.`,
    warning ? `Warning: ${warning}` : "",
    result.stdout.trim() ? `Reviewer output:\n${compactForToolResult(result.stdout, REVIEW_OUTPUT_BUDGET)}` : "",
    shouldIncludeStderr(result.exitCode, result.stderr)
      ? `Reviewer stderr:\n${compactForToolResult(result.stderr, Math.min(REVIEW_OUTPUT_BUDGET, 3000))}`
      : result.stderr.trim()
        ? "Reviewer stderr was captured and stored, but omitted from this response because the review succeeded."
        : "",
    `Full review log is stored as round ${round.round}. Use peer_task_status, get_peer_review_round, or bun cli.ts show ${task.id} to inspect it.`,
  ].filter(Boolean).join("\n\n");
  return textResult(body, result.exitCode !== 0);
}

async function runMultiPeerReviewTool(
  task: PeerTask,
  options: ReviewRequestOptions,
  taskPeers: AssistantHost[],
  promptSnapshot?: Awaited<ReturnType<typeof prepareReviewPromptSnapshot>>,
  expectedSignature?: string,
) {
  const selfReviewEnabled = shouldRunHostSelfReview(task.host, options.mode);
  const [hostAvailability, peerAvailability] = await Promise.all([
    isAssistantAvailable(task.host),
    Promise.all(taskPeers.map(async (reviewer) => ({
      reviewer,
      available: await isAssistantAvailable(reviewer),
    }))),
  ]);
  const availability = summarizeMultiPeerAvailability(hostAvailability, peerAvailability, selfReviewEnabled);

  if (availability.failure === "host_unavailable") {
    const failureMessage = [
      `Aggregate reviewer ${task.host} is not available for task ${task.id}.`,
      `Skipped ${task.host}: ${hostAvailability.detail}`,
    ].join("\n");
    const failureCommitted = await withReviewCommitLock(task.id, expectedSignature, async (current) => {
      await recordReviewFailure(current, task.host, failureMessage);
      return true;
    });
    if (!failureCommitted) {
      log(`Skipping stale host-unavailable failure for task ${task.id}.`);
      return textResult("Review was superseded by a newer request.", true);
    }
    return textResult(failureMessage, true);
  }

  const { availablePeers, skippedPeers } = availability;

  if (availablePeers.length === 0 && !selfReviewEnabled) {
    const failureMessage = [
      `No configured peer assistants are available for task ${task.id}.`,
      ...skippedPeers.map((item) => `Skipped ${item.reviewer}: ${item.available.detail}`),
    ].join("\n");
    const failureCommitted = await withReviewCommitLock(task.id, expectedSignature, async (current) => {
      await recordReviewFailure(current, skippedPeers[0]?.reviewer ?? task.host, failureMessage);
      return true;
    });
    if (!failureCommitted) {
      log(`Skipping stale no-peers failure for task ${task.id}.`);
      return textResult("Review was superseded by a newer request.", true);
    }
    return textResult(failureMessage, true);
  }

  const snapshot = promptSnapshot ?? await prepareReviewPromptSnapshot(task, options);
  const selfReviewPromise = selfReviewEnabled
    // liveHostReviewer routes the self-review through the host's live (tmux) session when
    // CODE_ASSISTANT_PEERS_LIVE_HOST_REVIEWS=1 and a <host>-live adapter is registered.
    ? runSinglePeerRound(task, { ...options, self_review: true }, liveHostReviewer(task.host), `${task.host} self-review`, snapshot, expectedSignature)
    : Promise.resolve<ReviewRoundOutcome | null>(null);
  const [peerResults, selfReviewResult] = await Promise.all([
    Promise.all(availablePeers.map((reviewer) => runSinglePeerRound(task, options, reviewer, reviewer, snapshot, expectedSignature))),
    selfReviewPromise,
  ]);
  const reviewResults = [...peerResults, ...(selfReviewResult ? [selfReviewResult] : [])];
  const statusResults = reviewResults;
  const selfReviewFailureWarning = selfReviewResult && selfReviewResult.review.exit_code !== 0
    ? `${task.host} self-review round ${selfReviewResult.round.round} exited ${selfReviewResult.review.exit_code}`
    : null;

  if (peerResults.some((result) => result.round.round < 0) || (selfReviewResult && selfReviewResult.round.round < 0)) {
    log(`Skipping stale multi-peer aggregation for task ${task.id} because a peer round was not committed.`);
    return textResult("Review was superseded by a newer request.", true);
  }

  if (!(await canFinalizeReview(task.id, expectedSignature))) {
    log(`Skipping stale multi-peer finalization for task ${task.id}.`);
    return textResult("Review was superseded by a newer request.", true);
  }

  if (availablePeers.length === 0 && selfReviewResult) {
    const selfReviewWarning = [selfReviewResult.review.warning, selfReviewFailureWarning].filter(Boolean).join("\n") || undefined;
    const committedStatus = await withReviewCommitLock(task.id, expectedSignature, async (current) => {
      const resolvedStatus = resolveMultiPeerTaskStatus({
        successfulPeerReviews: statusResults.filter((result) => result.review.exit_code === 0).length,
        failedPeerReviews: statusResults.filter((result) => result.review.exit_code !== 0).length,
        skippedPeers: skippedPeers.length,
        aggregateExitCode: selfReviewResult.review.exit_code,
      });
      current.review = {
        ...selfReviewResult.review,
        warning: selfReviewWarning,
      };
      current.status = resolvedStatus;
      current.updated_at = selfReviewResult.review.completed_at;
      await saveTask(current);
      return resolvedStatus;
    });
    if (!committedStatus) {
      log(`Skipping stale multi-peer self-review finalization for task ${task.id}.`);
      return textResult("Review was superseded by a newer request.", true);
    }

    const body = [
      `${task.host} self-review completed for task ${task.id}.`,
      `Requested peers: ${taskPeers.join(", ")}`,
      `Reviewed by: ${reviewResults.map((result) => result.label).join(", ")}`,
      skippedPeers.length ? `Skipped unavailable peers:\n${skippedPeers.map((item) => `- ${item.reviewer}: ${item.available.detail}`).join("\n")}` : "",
      `Self-review round: ${selfReviewResult.round.round} (${selfReviewResult.label}, exit ${selfReviewResult.review.exit_code}).`,
      `Aggregate round: skipped because no external peers were available.`,
      selfReviewFailureWarning ? `Self-review warning: ${selfReviewFailureWarning}` : "",
      selfReviewResult.review.stdout.trim()
        ? `Self-review output:\n${compactForToolResult(selfReviewResult.review.stdout, REVIEW_OUTPUT_BUDGET)}`
        : "",
      shouldIncludeStderr(selfReviewResult.review.exit_code, selfReviewResult.review.stderr)
        ? `Self-review stderr:\n${compactForToolResult(selfReviewResult.review.stderr, Math.min(REVIEW_OUTPUT_BUDGET, 3000))}`
        : "",
      `Task status: ${committedStatus}`,
    ].filter(Boolean).join("\n\n");

    return textResult(body, committedStatus === "review_failed");
  }

  const aggregatePromptResult = await buildMultiPeerAggregatePrompt(task, options, peerResults, skippedPeers, selfReviewResult, snapshot);
  const aggregatePrompt = aggregatePromptResult.prompt;
  const aggregateStartedAt = new Date().toISOString();
  // The aggregate pass runs as the HOST — for a claude host that spawns `claude -p` (credit
  // pool). liveHostReviewer optionally routes it through the host's live session instead.
  const aggregateReviewer = liveHostReviewer(task.host);
  const aggregateResult = await runReviewCommand(
    aggregateReviewer,
    task.cwd,
    aggregatePrompt,
    resolveReviewerModel(aggregateReviewer, options, buildReviewModelRoutingContext(options, snapshot)),
  );
  const aggregateCompletedAt = new Date().toISOString();
  const aggregateWarning = [aggregatePromptResult.warning, selfReviewFailureWarning].filter(Boolean).join("\n") || undefined;
  const aggregateReview: PeerReviewResult = {
    reviewer: task.host,
    command: aggregateResult.command,
    exit_code: aggregateResult.exitCode,
    stdout: aggregateResult.stdout,
    stderr: aggregateResult.stderr,
    started_at: aggregateStartedAt,
    completed_at: aggregateCompletedAt,
    warning: aggregateWarning,
  };
  const aggregateCommit = await withReviewCommitLock(task.id, expectedSignature, async (current) => {
    const resolvedStatus = resolveMultiPeerTaskStatus({
      successfulPeerReviews: statusResults.filter((result) => result.review.exit_code === 0).length,
      failedPeerReviews: statusResults.filter((result) => result.review.exit_code !== 0).length,
      skippedPeers: skippedPeers.length,
      aggregateExitCode: aggregateResult.exitCode,
    });
    current.review = aggregateReview;
    current.status = resolvedStatus;
    current.updated_at = aggregateCompletedAt;
    const aggregateRound = await appendReviewRoundAndSaveTask(current, aggregateReview, aggregatePrompt);
    return { round: aggregateRound, status: resolvedStatus };
  });
  if (!aggregateCommit) {
    log(`Skipping stale multi-peer aggregate finalization for task ${task.id}.`);
    return textResult("Review was superseded by a newer request.", true);
  }
  const aggregateRound = aggregateCommit.round;
  const aggregateStatus = aggregateCommit.status;

  const body = [
    `Multi-peer review completed for task ${task.id}.`,
    `Requested peers: ${taskPeers.join(", ")}`,
    `Reviewed by: ${reviewResults.map((result) => result.label).join(", ")}`,
    skippedPeers.length ? `Skipped unavailable peers:\n${skippedPeers.map((item) => `- ${item.reviewer}: ${item.available.detail}`).join("\n")}` : "",
    peerResults.length ? `Peer rounds: ${peerResults.map((result) => `${result.round.round} (${result.label}, exit ${result.review.exit_code})`).join(", ")}` : "",
    selfReviewResult ? `Self-review round: ${selfReviewResult.round.round} (${selfReviewResult.label}, exit ${selfReviewResult.review.exit_code}).` : "",
    selfReviewFailureWarning ? `Self-review warning: ${selfReviewFailureWarning}` : "",
    `Aggregate round: ${aggregateRound.round} (${task.host}, exit ${aggregateResult.exitCode}).`,
    aggregateWarning ? `Aggregate warning: ${aggregateWarning}` : "",
    aggregateResult.stdout.trim()
      ? `Aggregated review output:\n${compactForToolResult(aggregateResult.stdout, REVIEW_OUTPUT_BUDGET)}`
      : "",
    shouldIncludeStderr(aggregateResult.exitCode, aggregateResult.stderr)
      ? `Aggregate reviewer stderr:\n${compactForToolResult(aggregateResult.stderr, Math.min(REVIEW_OUTPUT_BUDGET, 3000))}`
      : "",
    `Task status: ${aggregateStatus}`,
  ].filter(Boolean).join("\n\n");

  return textResult(body, aggregateStatus === "review_failed");
}

async function runSinglePeerRound(
  task: PeerTask,
  options: ReviewRequestOptions,
  reviewer: AssistantHost,
  label = reviewer,
  promptSnapshot?: Awaited<ReturnType<typeof prepareReviewPromptSnapshot>>,
  expectedSignature?: string,
): Promise<ReviewRoundOutcome> {
  const roundTask = { ...task, peer: reviewer, peers: [reviewer] };
  const startedAt = new Date().toISOString();
  const snapshot = promptSnapshot ?? await prepareReviewPromptSnapshot(task, options);
  const { prompt, warning } = buildReviewPromptFromSnapshot(roundTask, options, snapshot);
  const result = await runReviewCommand(
    reviewer,
    task.cwd,
    prompt,
    resolveReviewerModel(reviewer, options, buildReviewModelRoutingContext(options, snapshot)),
  );
  const completedAt = new Date().toISOString();
  const review: PeerReviewResult = {
    reviewer,
    command: result.command,
    exit_code: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    started_at: startedAt,
    completed_at: completedAt,
    warning,
  };
  const round = await withReviewCommitLock(task.id, expectedSignature, async (current) => {
    return await appendReviewRound(current, review, prompt);
  });
  if (!round) {
    log(`Skipping stale peer round finalization for task ${task.id}.`);
    return { reviewer, label, review, round: { round: -1 }, prompt };
  }
  return { reviewer, label, review, round, prompt };
}

async function runCollaborativeReviewTool(
  task: PeerTask,
  options: ReviewRequestOptions,
  promptSnapshot: Awaited<ReturnType<typeof prepareReviewPromptSnapshot>>,
  expectedSignature?: string,
) {
  const peerStartedAt = new Date().toISOString();
  const peerPromptResult = buildReviewPromptFromSnapshot(task, {
    ...options,
    mode: "collaborative",
  }, promptSnapshot);
  const peerResult = await runReviewCommand(
    task.peer,
    task.cwd,
    peerPromptResult.prompt,
    resolveReviewerModel(task.peer, options, buildReviewModelRoutingContext({ ...options, mode: "collaborative" }, promptSnapshot)),
  );
  const peerCompletedAt = new Date().toISOString();
  const peerReview = {
    reviewer: task.peer,
    command: peerResult.command,
    exit_code: peerResult.exitCode,
    stdout: peerResult.stdout,
    stderr: peerResult.stderr,
    started_at: peerStartedAt,
    completed_at: peerCompletedAt,
    warning: peerPromptResult.warning,
  };
  const peerRound = await withReviewCommitLock(task.id, expectedSignature, async (current) => {
    return await appendReviewRound(current, peerReview, peerPromptResult.prompt);
  });
  if (!peerRound) {
    log(`Skipping stale collaborative peer-round finalization for task ${task.id}.`);
    return textResult("Review was superseded by a newer request.", true);
  }

  if (peerResult.exitCode !== 0 && !peerResult.stdout.trim()) {
    const failureCommitted = await withReviewCommitLock(task.id, expectedSignature, async (current) => {
      current.review = peerReview;
      current.status = "review_failed";
      current.updated_at = peerCompletedAt;
      await saveTask(current);
      return true;
    });
    if (!failureCommitted) {
      log(`Skipping stale collaborative peer-failure finalization for task ${task.id}.`);
      return textResult("Review was superseded by a newer request.", true);
    }
    const body = [
      `${task.peer}+${task.host} collaborative review failed during peer skeptical round for task ${task.id}.`,
      "Host comparison was skipped because the peer reviewer produced no usable review output.",
      shouldIncludeStderr(peerResult.exitCode, peerResult.stderr)
        ? `Peer reviewer stderr:\n${compactForToolResult(peerResult.stderr, Math.min(REVIEW_OUTPUT_BUDGET, 3000))}`
        : "",
      `Full peer log is stored as round ${peerRound.round}. Use peer_task_status, get_peer_review_round, or bun cli.ts show ${task.id} to inspect it.`,
    ].filter(Boolean).join("\n\n");
    return textResult(body, true);
  }

  const hostPrompt = buildHostComparisonPrompt(task, options, peerReview.stdout || peerReview.stderr, promptSnapshot);
  const hostStartedAt = new Date().toISOString();
  // Collaborative host comparison also runs as the HOST — route via the live session when
  // CODE_ASSISTANT_PEERS_LIVE_HOST_REVIEWS=1 (avoids `claude -p` for claude hosts).
  const hostComparisonReviewer = liveHostReviewer(task.host);
  const hostResult = await runReviewCommand(
    hostComparisonReviewer,
    task.cwd,
    hostPrompt,
    resolveReviewerModel(hostComparisonReviewer, options, buildReviewModelRoutingContext(options, promptSnapshot)),
  );
  const hostCompletedAt = new Date().toISOString();
  const hostReview = {
    reviewer: task.host,
    command: hostResult.command,
    exit_code: hostResult.exitCode,
    stdout: hostResult.stdout,
    stderr: hostResult.stderr,
    started_at: hostStartedAt,
    completed_at: hostCompletedAt,
    warning: peerPromptResult.warning,
  };
  const hostCommit = await withReviewCommitLock(task.id, expectedSignature, async (current) => {
    current.review = hostReview;
    current.status = peerResult.exitCode === 0 && hostResult.exitCode === 0 ? "reviewed" : "review_failed";
    current.updated_at = hostCompletedAt;
    const hostRound = await appendReviewRoundAndSaveTask(current, hostReview, hostPrompt);
    return hostRound;
  });
  if (!hostCommit) {
    log(`Skipping stale collaborative finalization for task ${task.id}.`);
    return textResult("Review was superseded by a newer request.", true);
  }
  const hostRound = hostCommit;

  const body = [
    `${task.peer}+${task.host} collaborative review completed for task ${task.id}.`,
    "Collaborative mode runs both CLI perspectives and costs more tokens than normal review; use it only when the extra confidence is worth it.",
    peerPromptResult.warning ? `Warning: ${peerPromptResult.warning}` : "",
    `Peer skeptical round: ${peerRound.round} (${task.peer}, exit ${peerResult.exitCode}).`,
    `Host comparison round: ${hostRound.round} (${task.host}, exit ${hostResult.exitCode}).`,
    hostResult.stdout.trim()
      ? `Combined review output:\n${compactForToolResult(hostResult.stdout, REVIEW_OUTPUT_BUDGET)}`
      : "",
    shouldIncludeStderr(hostResult.exitCode, hostResult.stderr)
      ? `Host reviewer stderr:\n${compactForToolResult(hostResult.stderr, Math.min(REVIEW_OUTPUT_BUDGET, 3000))}`
      : "",
    `Full logs are stored as rounds ${peerRound.round} and ${hostRound.round}. Use peer_task_status, get_peer_review_round, or bun cli.ts show ${task.id} to inspect them.`,
  ].filter(Boolean).join("\n\n");

  return textResult(body, peerResult.exitCode !== 0 || hostResult.exitCode !== 0);
}

function buildHostComparisonPrompt(
  task: PeerTask,
  options: ReviewRequestOptions,
  peerOutput: string,
  promptSnapshot: Awaited<ReturnType<typeof prepareReviewPromptSnapshot>>,
): string {
  const hostTask = { ...task, peer: task.host, peers: [task.host] };
  const base = buildReviewPromptFromSnapshot(hostTask, {
    ...options,
    mode: "normal",
  }, promptSnapshot);
  const taskContextStart = base.prompt.indexOf("\nTask id:");
  const taskContext = taskContextStart >= 0 ? base.prompt.slice(taskContextStart + 1) : base.prompt;
  const contextPrompt = taskContext.replace("Review mode: normal", "Review mode: collaborative host comparison");
  return `${COLLABORATIVE_REVIEW_PROMPT}

You are now the host-side comparison reviewer (${task.host}).

The peer reviewer (${task.peer}) has already produced a skeptical review. Your job:
- Defend implementation choices when the peer finding is a false positive or overstated.
- Accept peer findings that are well supported.
- Identify any important issue the peer missed.
- Produce the final combined review with findings first, ordered by severity.
- Keep the result compact. Do not repeat raw logs.

Peer review output:
${truncateForReview(peerOutput, REVIEW_OUTPUT_BUDGET)}

Repository/task context:
${contextPrompt}`;
}

async function buildMultiPeerAggregatePrompt(
  task: PeerTask,
  options: ReviewRequestOptions,
  peerResults: ReviewRoundOutcome[],
  skippedPeers: Array<{ reviewer: AssistantHost; available: { ok: boolean; detail: string } }>,
  selfReviewResult?: ReviewRoundOutcome | null,
  promptSnapshot?: Awaited<ReturnType<typeof prepareReviewPromptSnapshot>>,
): Promise<{ prompt: string; warning?: string }> {
  const snapshot = promptSnapshot ?? await prepareReviewPromptSnapshot(task, options);
  const aggregateTask = { ...task, peer: task.host, peers: [task.host] };
  const base = buildReviewPromptFromSnapshot(aggregateTask, {
    ...options,
    mode: options.mode === "collaborative" ? "normal" : options.mode,
  }, snapshot);
  const taskContextStart = base.prompt.indexOf("\nTask id:");
  const taskContext = taskContextStart >= 0 ? base.prompt.slice(taskContextStart + 1) : base.prompt;
  const aggregateMode = options.mode === "collaborative"
    ? "multi-peer aggregate collaborative"
    : `multi-peer aggregate ${options.mode ?? "normal"}`;
  const baseMode = options.mode === "collaborative" ? "normal" : options.mode ?? "normal";
  const contextPrompt = taskContext.replace(
    `Review mode: ${baseMode}`,
    `Review mode: ${aggregateMode}`,
  );
  return {
    warning: base.warning,
    prompt: `You are the aggregate reviewer for a multi-peer code review.

Your job is to merge multiple assistant reviews into the best final review:
- Deduplicate overlapping findings.
- Prefer concrete, well-supported findings over speculative ones.
- Preserve only issues the original author would likely fix.
- Drop findings that depend on unstated assumptions or do not identify a concrete affected path.
- Preserve severity and file/line references where useful.
- Mention reviewer failures or skipped unavailable reviewers separately.
- Return findings first, ordered by severity. If no material issues remain, say "No findings." clearly.
- End with an overall correctness verdict: "patch is correct" or "patch is incorrect".
- Keep the result compact and actionable.

Requested peer reviewers:
${task.peers?.join(", ") ?? task.peer}

Skipped unavailable reviewers:
${skippedPeers.length ? skippedPeers.map((item) => `- ${item.reviewer}: ${item.available.detail}`).join("\n") : "(none)"}

${formatMultiPeerReviewOutputs(peerResults, selfReviewResult)}

Repository/task context:
${contextPrompt}`,
  };
}

function parseReviewOptions(args: unknown): ReviewRequestOptions {
  const obj = args && typeof args === "object" ? args as Record<string, unknown> : {};
  return {
    mode: parseReviewMode(obj.mode),
    scope: parseReviewScope(obj.scope),
    base: obj.base === undefined || obj.base === null ? null : String(obj.base),
    change_summary: obj.change_summary === undefined || obj.change_summary === null
      ? null
      : String(obj.change_summary),
    files_changed: Array.isArray(obj.files_changed)
      ? obj.files_changed.map(String).filter(Boolean)
      : undefined,
    workflow: normalizeWorkflow(typeof obj.workflow === "string" ? obj.workflow : undefined),
    focus: obj.focus === undefined || obj.focus === null
      ? normalizeReviewFocus(process.env.CODE_ASSISTANT_PEERS_REVIEW_FOCUS)
      : normalizeReviewFocus(String(obj.focus)),
    semantic_context: obj.semantic_context === undefined || obj.semantic_context === null
      ? null
      : String(obj.semantic_context),
    // CODE_ASSISTANT_PEERS_REVIEW_MODEL is the operator-set default when the host omits
    // review_model — "auto" is the recommended value (routes small/low-risk diffs to the cheap
    // tier without host cooperation). An explicit host value always wins.
    review_model: normalizeReviewModel(obj.review_model ?? process.env.CODE_ASSISTANT_PEERS_REVIEW_MODEL),
    review_models: normalizeReviewModels(obj.review_models),
    force_review: obj.force_review === true,
  };
}

function normalizeReviewModel(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const model = String(value).trim();
  if (!model) return null;
  if (!/^[A-Za-z0-9._:[\]-]+$/.test(model)) {
    throw new Error("review_model may contain only letters, numbers, dot, underscore, hyphen, colon, and square brackets.");
  }
  return model;
}

function normalizeReviewModels(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("review_models must be an object mapping assistant id to model.");
  }
  const result: Record<string, string> = {};
  for (const [assistant, rawModel] of Object.entries(value as Record<string, unknown>)) {
    const id = String(assistant).trim().toLowerCase();
    const model = normalizeReviewModel(rawModel);
    if (!id || !model) continue;
    if (!assistantRegistry[id]) {
      const available = Object.keys(assistantRegistry).sort().join(", ");
      throw new Error(`review_models contains unknown assistant '${assistant}'. Available assistants: ${available}`);
    }
    result[id] = model;
  }
  return Object.keys(result).length ? result : undefined;
}

function parseReviewMode(value: unknown): ReviewMode | undefined {
  if (value === undefined || value === null) return DEFAULT_REVIEW_MODE;
  if (value === "normal" || value === "adversarial" || value === "gate" || value === "collaborative") return value;
  throw new Error("mode must be one of: normal, adversarial, gate, collaborative");
}

function parseReviewScope(value: unknown): ReviewScope | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "auto" || value === "working-tree" || value === "branch") return value;
  throw new Error("scope must be one of: auto, working-tree, branch");
}

function normalizeWorkflow(value: string | undefined): PeerWorkflow {
  return value === "peer_fix" ? "peer_fix" : "review_only";
}

function normalizeDefaultReviewMode(value: string | undefined): ReviewMode | undefined {
  return value === "normal" || value === "adversarial" || value === "gate" || value === "collaborative"
    ? value
    : undefined;
}

async function buildSetupStatus() {
  const assistants = Object.fromEntries(await Promise.all(Object.values(assistantRegistry).map(async (adapter) => {
    return [adapter.id, {
      ...adapter,
      available: await isAssistantAvailable(adapter.id),
      model_selection: await getAssistantModelSelectionStatus(adapter.id),
      command_preview: adapter.command,
    }];
  })));
  return {
    ready: areConfiguredAssistantsReady(assistants, host, peers),
    host,
    peer,
    peers,
    workflow: DEFAULT_WORKFLOW,
    default_review_mode: DEFAULT_REVIEW_MODE ?? "normal",
    default_review_model: process.env.CODE_ASSISTANT_PEERS_REVIEW_MODEL?.trim() || null,
    assistants,
    review_gate: {
      available_tool: "must_call_after_code_changes",
      note: "MCP cannot technically force every final response through review, but this required post-edit tool is exposed with strong schema and starts or reuses async peer review jobs.",
    },
    model_routing: {
      request_options: ["review_model", "review_models"],
      host_selection_policy: {
        selector: "host coding agent",
        default_behavior: "omit review_model/review_models to keep each reviewer CLI default model",
        explicit_selection: "set review_models for per-reviewer choices when the host can choose from assistants.*.model_selection.known_models",
        global_selection_warning: "use review_model with an explicit id only when every targeted reviewer CLI supports the same model id; otherwise use review_models",
        delegation: "set review_model or a per-reviewer review_models value to \"auto\" only when the host wants the MCP server to choose",
        precedence: ["review_models[reviewer]", "review_model", "reviewer CLI default"],
      },
      examples: {
        automatic: { review_model: "auto" },
        automatic_for_one_reviewer: { review_models: { claude: "auto", codex: "gpt-5.4" } },
        per_reviewer: { review_models: { claude: "opus", codex: "gpt-5.5" } },
      },
      auto_strategy: {
        fast: "small docs/tests/lint/copy/comment changes",
        balanced: "normal, gate, and self-review requests",
        deep: "adversarial/collaborative/peer_fix or high-risk focus areas",
        long_context: "truncated diffs, very large diffs, or many changed files",
      },
      host_selection_hints: {
        fast: "choose for small docs/tests/lint/copy/comment changes when low cost and latency matter",
        balanced: "choose for ordinary code review and compact gate checks",
        deep: "choose for adversarial, collaborative, peer_fix, security, auth, data loss, migration, release, database, privacy, race/concurrency, secrets, or performance risk",
        long_context: "choose for truncated diffs, very large diffs, or broad changes touching many files",
      },
      probe_note: "Known model candidates are listed at setup. Set CODE_ASSISTANT_PEERS_PROBE_MODELS=1 before starting the MCP server to verify candidate model access with live probe calls.",
    },
    next_steps: [
      assistants[host]?.available.ok ? null : `Install or fix host assistant CLI: ${host}.`,
      ...peers.map((reviewer) => assistants[reviewer]?.available.ok ? null : `Install or fix peer assistant CLI: ${reviewer}.`),
      "Use must_call_after_code_changes after edits, then call wait_for_peer_review until the task reaches a terminal state.",
    ].filter(Boolean),
  };
}

async function getAssistantModelSelectionStatus(reviewer: AssistantHost) {
  const adapter = getAssistantAdapter(reviewer, assistantRegistry);
  const supportsModelOption = adapter.model_arg ? await assistantHelpMentionsArg(adapter, adapter.model_arg) : false;
  const knownModels = adapter.models ?? [];
  const probeModels = process.env.CODE_ASSISTANT_PEERS_PROBE_MODELS === "1";
  const modelAvailability = probeModels && supportsModelOption && knownModels.length > 0
    ? Object.fromEntries(await Promise.all(knownModels.map(async (model) => {
      const result = await runModelProbeCommand(reviewer, model.id);
      return [model.id, {
        available: result.exitCode === 0,
        detail: result.exitCode === 0
          ? "probe succeeded"
          : compactForToolResult(result.stderr || result.stdout || "probe failed", 500),
      }];
    })))
    : null;

  return {
    supports_model_option: supportsModelOption,
    model_arg: adapter.model_arg ?? null,
    known_models: knownModels,
    availability_checked: Boolean(modelAvailability),
    availability: modelAvailability,
  };
}

async function runModelProbeCommand(
  reviewer: AssistantHost,
  model: string,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const adapter = getAssistantAdapter(reviewer, assistantRegistry);
  const command = buildReviewCommand(reviewer, model);
  const prompt = "Reply with exactly OK.";
  const finalCommand = adapter.prompt_transport === "argv" ? [...command, prompt] : command;
  let result: Awaited<ReturnType<typeof spawnWithTimeout>>;
  try {
    result = await spawnWithTimeout(finalCommand, {
      cwd: process.cwd(),
      env: buildReviewCommandEnv(adapter),
      stdin: adapter.prompt_transport === "stdin" ? prompt : null,
      timeoutMs: MODEL_PROBE_TIMEOUT_MS,
    });
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `model probe failed to start: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return {
    exitCode: result.timedOut ? 1 : result.exitCode,
    stdout: result.stdout,
    stderr: result.timedOut
      ? [result.stderr.trim(), `model probe timed out after ${MODEL_PROBE_TIMEOUT_MS}ms`].filter(Boolean).join("\n\n")
      : result.stderr,
  };
}

async function assistantHelpMentionsArg(adapter: ReturnType<typeof getAssistantAdapter>, arg: string): Promise<boolean> {
  const helpCommand = buildAssistantHelpCommand(adapter);
  if (!helpCommand) return false;
  try {
    const result = await spawnWithTimeout(helpCommand, {
      env: buildMinimalHelpEnv(),
      timeoutMs: MODEL_PROBE_TIMEOUT_MS,
    });
    return !result.timedOut && `${result.stdout}\n${result.stderr}`.includes(arg);
  } catch {
    return false;
  }
}

function buildAssistantHelpCommand(adapter: ReturnType<typeof getAssistantAdapter>): string[] | null {
  const command = adapter.command.find((part) => part !== "{system_prompt}");
  if (!command) return null;
  if (adapter.id === "codex") return [command, "exec", "--help"];
  return [command, "--help"];
}

function buildMinimalHelpEnv(): Record<string, string> {
  return Object.fromEntries([
    "PATH",
    "HOME",
    "USER",
    "SHELL",
    "TERM",
    "TMPDIR",
  ].map((key) => [key, process.env[key]]).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

async function isAssistantAvailable(reviewer: AssistantHost): Promise<{ ok: boolean; detail: string }> {
  const adapter = getAssistantAdapter(reviewer, assistantRegistry);
  const command = adapter.command.find((part) => part !== "{system_prompt}");
  if (!command) return { ok: false, detail: "missing command" };
  try {
    const proc = Bun.spawn(["/usr/bin/env", "which", command], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      return {
        ok: false,
        detail: (stdout || stderr).trim() || `command '${command}' not found`,
      };
    }
    if (reviewer === "gemini") {
      const geminiAuth = await getGeminiAuthReadiness(process.env);
      if (!geminiAuth.ok) return geminiAuth;
    }
    return {
      ok: true,
      detail: (stdout || stderr).trim() || `command '${command}' found`,
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function shouldIncludeStderr(exitCode: number | null, stderr: string): boolean {
  if (!stderr.trim()) return false;
  return exitCode !== 0 || INCLUDE_SUCCESS_STDERR;
}

async function buildReviewStatusJson(task: PeerTask): Promise<string> {
  const [rounds, openFindings] = await Promise.all([
    listReviewRounds(task.id),
    listFindings(task.id, "open"),
  ]);
  const latestRound = rounds.at(-1) ?? (task.review
    ? {
      round: 0,
      reviewer: task.review.reviewer,
      exit_code: task.review.exit_code,
      completed_at: task.review.completed_at,
      stdout: task.review.stdout,
      stderr: task.review.stderr,
    }
    : null);
  return JSON.stringify({
    task_id: task.id,
    status: task.status,
    host: task.host,
    peer: task.peer,
    peers: task.peers ?? [task.peer],
    updated_at: task.updated_at,
    review_rounds: rounds.length,
    latest_round: latestRound
      ? {
        round: latestRound.round,
        reviewer: latestRound.reviewer,
        exit_code: latestRound.exit_code,
        completed_at: latestRound.completed_at,
        output_preview: compactForToolResult(latestRound.stdout || latestRound.stderr, 2000),
      }
      : null,
    open_findings: openFindings,
    next_action: task.status === "queued" || task.status === "running"
      ? "Call wait_for_peer_review again before final response."
      : task.status === "reviewed"
        ? "Review completed. Report the latest round and any open findings."
        : task.status === "partial_failed"
          ? "Review partially completed. Report successful reviews and skipped/failed peers."
          : task.status === "review_failed"
            ? "Review failed. Inspect latest_round and stderr before final response."
            : "Start async review with must_call_after_code_changes, request_peer_review, or start_peer_review_async.",
  }, null, 2);
}

function compactForToolResult(value: string, budget: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= budget) return trimmed;
  return `${trimmed.slice(0, budget)}

	[Output truncated at ${budget} characters. Full output is stored in persistent review memory.]`;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTerminalReviewStatus(status: string): boolean {
  return status === "reviewed" || status === "partial_failed" || status === "review_failed";
}

function isStaleReviewState(task: PeerTask): boolean {
  const updatedAt = Date.parse(task.updated_at);
  if (!Number.isFinite(updatedAt)) return true;
  return Date.now() - updatedAt >= STALE_REVIEW_RECOVERY_MS;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function defaultStaleReviewRecoveryMs(): number {
  const reviewTimeout = parsePositiveInteger(process.env.CODE_ASSISTANT_PEERS_REVIEW_TIMEOUT_MS) ?? 600_000;
  return Math.max(900_000, reviewTimeout + 300_000);
}

function normalizeFinding(value: unknown): NewPeerReviewFinding {
  const obj = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const severity = String(obj.severity ?? "medium").trim();
  const message = String(obj.message ?? "").trim();
  if (!message) throw new Error("each finding requires a message");
  const line = obj.line === undefined || obj.line === null ? null : Number(obj.line);
  return {
    severity: severity || "medium",
    file: obj.file === undefined || obj.file === null ? null : String(obj.file),
    line: Number.isFinite(line) ? line : null,
    message,
    status: obj.status === "addressed" || obj.status === "dismissed" || obj.status === "unknown"
      ? obj.status
      : "open",
  };
}

await mcp.connect(new StdioServerTransport());
log(`MCP connected as ${host}; peer reviewer${peers.length > 1 ? "s" : ""}: ${peers.join(", ")}`);
