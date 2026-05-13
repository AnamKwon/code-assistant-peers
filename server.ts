#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { formatStatus, getGitRoot, getStatusEntries, getUncommittedDiff } from "./shared/git.ts";
import { COLLABORATIVE_REVIEW_PROMPT, buildReviewPrompt, normalizeHost, normalizeReviewFocus, peerFor, runReviewCommand, truncateForReview } from "./shared/review.ts";
import {
  addFindings,
  appendReviewRound,
  compactTaskHistory,
  gcStore,
  getReviewRound,
  listFindings,
  listReviewRounds,
  loadTask,
  saveTask,
} from "./shared/store.ts";
import { getAssistantAdapter, loadAssistantRegistry, peersFor } from "./shared/assistants.ts";
import { areConfiguredAssistantsReady, resolveMultiPeerTaskStatus } from "./shared/multi-peer.ts";
import type { AssistantHost, NewPeerReviewFinding, PeerReviewResult, PeerTask, PeerWorkflow, ReviewMode, ReviewRequestOptions, ReviewScope } from "./shared/types.ts";

const assistantRegistry = loadAssistantRegistry();
const host = normalizeHost(process.env.HOST_ASSISTANT, assistantRegistry);
const peers = peersFor(host, process.env.PEER_ASSISTANTS, process.env.PEER_ASSISTANT, assistantRegistry);
const peer = peers[0];
const REVIEW_OUTPUT_BUDGET = parseInt(process.env.CODE_ASSISTANT_PEERS_REVIEW_OUTPUT_BUDGET ?? "6000", 10);
const INCLUDE_SUCCESS_STDERR = process.env.CODE_ASSISTANT_PEERS_INCLUDE_SUCCESS_STDERR === "1";
const DEFAULT_WORKFLOW = normalizeWorkflow(process.env.CODE_ASSISTANT_PEERS_WORKFLOW);
const DEFAULT_REVIEW_MODE = normalizeDefaultReviewMode(process.env.CODE_ASSISTANT_PEERS_REVIEW_MODE);

function log(message: string): void {
  console.error(`[code-assistant-peers] ${message}`);
}

const mcp = new Server(
  { name: "code-assistant-peers", version: "0.1.0" },
  {
    capabilities: { tools: {} },
    instructions: `You are connected to the code-assistant-peers workflow as ${host}.

	When the user asks for a code change:
	1. Call begin_peer_task before editing.
	2. Implement the change yourself.
	3. Call must_call_after_code_changes before your final answer. This is required after any code edit, generated file, patch, format, refactor, or content change.
		4. Report the ${peers.length > 1 ? peers.join(", ") : peer} review result to the user, including any actionable findings.
	
	If a review may exceed the host MCP timeout, call start_peer_review_async, then call wait_for_peer_review or get_peer_review_status until the task is reviewed, partial_failed, or review_failed before your final answer.
	When the user asks to review, verify, validate, gate, or check code changes, prefer must_call_after_code_changes, finalize_code_changes_with_peer_review, verify_code_changes_after_edit, or request_peer_review over built-in slash review commands.
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
    description: `MANDATORY PEER REVIEW after code changes. Ask configured peer assistant(s) (${peers.join(", ")}) to review changes made for a task before final response. Use this whenever files were edited, created, deleted, generated, formatted, or refactored. Do not use built-in /review as a substitute.`,
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
      },
      required: ["task_id"],
    },
  },
  {
    name: "verify_code_changes_after_edit",
    description: "MANDATORY AFTER EDITING CODE. Call this after modifying, adding, deleting, generating, formatting, or refactoring files and before final response. Creates a task if needed, runs peer review on current changes, and returns a compact result. Prefer must_call_after_code_changes for final answers.",
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
      },
    },
  },
  {
    name: "finalize_code_changes_with_peer_review",
    description: "MANDATORY FINALIZATION GATE after editing files. Call this before the final response whenever code was modified, added, deleted, generated, formatted, or refactored. It verifies current changes with the opposite assistant and returns the peer review result. Do not use built-in /review instead.",
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
      },
    },
  },
  {
    name: "must_call_after_code_changes",
    description: "ABSOLUTE REQUIRED POST-EDIT MCP GATE. If you changed, created, deleted, generated, formatted, or refactored any code or project file, you must call this tool before final response. This runs peer review and verification through code-assistant-peers. Never substitute built-in /review for this required MCP call.",
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
      },
    },
  },
  {
    name: "start_peer_review_async",
    description: "ASYNC POST-EDIT REVIEW START. Use this when a peer review may exceed the MCP host timeout. Starts peer review in the background, stores queued/running/reviewed/partial_failed/review_failed state in SQLite, and returns immediately with a task id. After calling this, you MUST call wait_for_peer_review or get_peer_review_status before final response.",
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
      return await runPeerReviewTool(task, parseReviewOptions(args));
    }

    case "verify_code_changes_after_edit": {
      return await runAutoReviewTool(args, "Code changes require peer review");
    }

    case "finalize_code_changes_with_peer_review": {
      return await runAutoReviewTool(args, "Code changes require final peer review");
    }

    case "must_call_after_code_changes": {
      return await runAutoReviewTool(args, "Code changes require mandatory peer review");
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
      return textResult(JSON.stringify({ task, rounds, findings }, null, 2));
    }

    case "get_peer_task_context": {
      const taskId = String((args as { task_id?: unknown }).task_id ?? "").trim();
      const task = await loadTask(taskId);
      if (!task) return textResult(`Task not found: ${taskId}`, true);
      const [currentStatus, currentDiff, rounds, openFindings] = await Promise.all([
        getStatusEntries(task.cwd),
        getUncommittedDiff(task.cwd),
        listReviewRounds(taskId),
        listFindings(taskId, "open"),
      ]);
      return textResult(JSON.stringify({
        task,
        baseline_status: formatStatus(task.baseline_status),
        current_status: formatStatus(currentStatus),
        current_diff: truncateForReview(currentDiff, 30_000),
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

async function createPeerTask(prompt: string): Promise<PeerTask> {
  const cwd = process.cwd();
  const gitRoot = await getGitRoot(cwd);
  const baselineStatus = await getStatusEntries(cwd);
  const baselineDiff = await getUncommittedDiff(cwd);
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
    created_at: now,
    updated_at: now,
    status: "open",
  };
  await saveTask(task);
  return task;
}

async function runAutoReviewTool(args: unknown, defaultPrompt: string) {
  const parsed = args as { task_id?: unknown; prompt?: unknown };
  const taskId = String(parsed.task_id ?? "").trim();
  const task = taskId
    ? await loadTask(taskId)
    : await createPeerTask(String(parsed.prompt ?? defaultPrompt).trim());
  if (!task) return textResult(`Task not found: ${taskId}`, true);
  return await runPeerReviewTool(task, parseReviewOptions(args));
}

async function startAsyncReviewTool(args: unknown, defaultPrompt: string) {
  const parsed = args as { task_id?: unknown; prompt?: unknown };
  const taskId = String(parsed.task_id ?? "").trim();
  const task = taskId
    ? await loadTask(taskId)
    : await createPeerTask(String(parsed.prompt ?? defaultPrompt).trim());
  if (!task) return textResult(`Task not found: ${taskId}`, true);
  if (task.status === "queued" || task.status === "running") {
    return textResult(`Peer review is already ${task.status} for task ${task.id}. Call wait_for_peer_review or get_peer_review_status.`);
  }

  task.status = "queued";
  task.updated_at = new Date().toISOString();
  await saveTask(task);
  const options = parseReviewOptions(args);
  void runAsyncPeerReview(task, options);

  return textResult([
    `Started async peer review for task ${task.id}.`,
    "Status is stored in SQLite as queued/running/reviewed/partial_failed/review_failed.",
    "Call wait_for_peer_review with this task_id before your final response.",
  ].join("\n"));
}

async function runAsyncPeerReview(initialTask: PeerTask, options: ReviewRequestOptions): Promise<void> {
  let task = initialTask;
  try {
    task = await loadTask(initialTask.id) ?? initialTask;
    task.status = "running";
    task.updated_at = new Date().toISOString();
    await saveTask(task);
    await runPeerReviewTool(task, options);
  } catch (error) {
    const now = new Date().toISOString();
    let failedTask = task;
    try {
      failedTask = await loadTask(initialTask.id) ?? task;
    } catch {
      failedTask = task;
    }
    const message = error instanceof Error ? error.stack || error.message : String(error);
    failedTask.review = {
      reviewer: failedTask.peers && failedTask.peers.length > 1 ? "async-multi-peer-review" : failedTask.peer,
      command: ["async-peer-review"],
      exit_code: 1,
      stdout: "",
      stderr: message,
      started_at: now,
      completed_at: now,
    };
    failedTask.status = "review_failed";
    failedTask.updated_at = now;
    try {
      await saveTask(failedTask);
      await appendReviewRound(failedTask, failedTask.review, "(async review failed before reviewer completed)");
    } catch (saveError) {
      const saveMessage = saveError instanceof Error ? saveError.stack || saveError.message : String(saveError);
      log(`Async review failed and could not persist failure for task ${initialTask.id}: ${saveMessage}`);
    }
    log(`Async review failed for task ${initialTask.id}: ${message}`);
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

async function runPeerReviewTool(task: PeerTask, options: ReviewRequestOptions) {
  const taskPeers = task.peers?.length ? task.peers : [task.peer];
  if (taskPeers.length > 1) {
    return await runMultiPeerReviewTool(task, options, taskPeers);
  }

  if (options.mode === "collaborative") {
    return await runCollaborativeReviewTool(task, options);
  }

  const startedAt = new Date().toISOString();
  const { prompt, warning } = await buildReviewPrompt(task, options);
  const result = await runReviewCommand(task.peer, task.cwd, prompt);
  const completedAt = new Date().toISOString();

  task.review = {
    reviewer: task.peer,
    command: result.command,
    exit_code: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    started_at: startedAt,
    completed_at: completedAt,
    warning,
  };
  task.status = result.exitCode === 0 ? "reviewed" : "review_failed";
  task.updated_at = completedAt;
  await saveTask(task);
  const round = await appendReviewRound(task, task.review, prompt);

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

async function runMultiPeerReviewTool(task: PeerTask, options: ReviewRequestOptions, taskPeers: AssistantHost[]) {
  const availability = await Promise.all(taskPeers.map(async (reviewer) => ({
    reviewer,
    available: await isAssistantAvailable(reviewer),
  })));
  const availablePeers = availability.filter((item) => item.available.ok).map((item) => item.reviewer);
  const skippedPeers = availability.filter((item) => !item.available.ok);

  if (availablePeers.length === 0) {
    task.status = "review_failed";
    task.updated_at = new Date().toISOString();
    await saveTask(task);
    return textResult([
      `No configured peer assistants are available for task ${task.id}.`,
      ...skippedPeers.map((item) => `Skipped ${item.reviewer}: ${item.available.detail}`),
    ].join("\n"), true);
  }

  const peerResults = await Promise.all(availablePeers.map((reviewer) => runSinglePeerRound(task, options, reviewer)));
  const successResults = peerResults.filter((result) => result.review.exit_code === 0);
  const failedResults = peerResults.filter((result) => result.review.exit_code !== 0);

  const aggregatePrompt = await buildMultiPeerAggregatePrompt(task, options, peerResults, skippedPeers);
  const aggregateStartedAt = new Date().toISOString();
  const aggregateResult = await runReviewCommand(task.host, task.cwd, aggregatePrompt);
  const aggregateCompletedAt = new Date().toISOString();
  const aggregateReview: PeerReviewResult = {
    reviewer: task.host,
    command: aggregateResult.command,
    exit_code: aggregateResult.exitCode,
    stdout: aggregateResult.stdout,
    stderr: aggregateResult.stderr,
    started_at: aggregateStartedAt,
    completed_at: aggregateCompletedAt,
  };
  const aggregateRound = await appendReviewRound(task, aggregateReview, aggregatePrompt);

  task.review = aggregateReview;
  task.status = resolveMultiPeerTaskStatus({
    successfulPeerReviews: successResults.length,
    failedPeerReviews: failedResults.length,
    skippedPeers: skippedPeers.length,
    aggregateExitCode: aggregateResult.exitCode,
  });
  task.updated_at = aggregateCompletedAt;
  await saveTask(task);

  const body = [
    `Multi-peer review completed for task ${task.id}.`,
    `Requested peers: ${taskPeers.join(", ")}`,
    `Reviewed by: ${availablePeers.join(", ")}`,
    skippedPeers.length ? `Skipped unavailable peers:\n${skippedPeers.map((item) => `- ${item.reviewer}: ${item.available.detail}`).join("\n")}` : "",
    `Peer rounds: ${peerResults.map((result) => `${result.round.round} (${result.reviewer}, exit ${result.review.exit_code})`).join(", ")}`,
    `Aggregate round: ${aggregateRound.round} (${task.host}, exit ${aggregateResult.exitCode}).`,
    aggregateResult.stdout.trim()
      ? `Aggregated review output:\n${compactForToolResult(aggregateResult.stdout, REVIEW_OUTPUT_BUDGET)}`
      : "",
    shouldIncludeStderr(aggregateResult.exitCode, aggregateResult.stderr)
      ? `Aggregate reviewer stderr:\n${compactForToolResult(aggregateResult.stderr, Math.min(REVIEW_OUTPUT_BUDGET, 3000))}`
      : "",
    `Task status: ${task.status}`,
  ].filter(Boolean).join("\n\n");

  return textResult(body, task.status === "review_failed");
}

async function runSinglePeerRound(task: PeerTask, options: ReviewRequestOptions, reviewer: AssistantHost) {
  const roundTask = { ...task, peer: reviewer, peers: [reviewer] };
  const startedAt = new Date().toISOString();
  const { prompt, warning } = await buildReviewPrompt(roundTask, options);
  const result = await runReviewCommand(reviewer, task.cwd, prompt);
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
  const round = await appendReviewRound(task, review, prompt);
  return { reviewer, review, round, prompt };
}

async function runCollaborativeReviewTool(task: PeerTask, options: ReviewRequestOptions) {
  const peerStartedAt = new Date().toISOString();
  const peerPromptResult = await buildReviewPrompt(task, {
    ...options,
    mode: "collaborative",
  });
  const peerResult = await runReviewCommand(task.peer, task.cwd, peerPromptResult.prompt);
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
  const peerRound = await appendReviewRound(task, peerReview, peerPromptResult.prompt);

  if (peerResult.exitCode !== 0 && !peerResult.stdout.trim()) {
    task.review = peerReview;
    task.status = "review_failed";
    task.updated_at = peerCompletedAt;
    await saveTask(task);
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

  const hostPrompt = await buildHostComparisonPrompt(task, options, peerReview.stdout || peerReview.stderr);
  const hostStartedAt = new Date().toISOString();
  const hostResult = await runReviewCommand(task.host, task.cwd, hostPrompt);
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
  const hostRound = await appendReviewRound(task, hostReview, hostPrompt);

  task.review = hostReview;
  task.status = peerResult.exitCode === 0 && hostResult.exitCode === 0 ? "reviewed" : "review_failed";
  task.updated_at = hostCompletedAt;
  await saveTask(task);

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

async function buildHostComparisonPrompt(
  task: PeerTask,
  options: ReviewRequestOptions,
  peerOutput: string,
): Promise<string> {
  const base = await buildReviewPrompt(task, {
    ...options,
    mode: "normal",
  });
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
  peerResults: Array<{ reviewer: AssistantHost; review: PeerReviewResult; round: { round: number } }>,
  skippedPeers: Array<{ reviewer: AssistantHost; available: { ok: boolean; detail: string } }>,
): Promise<string> {
  const base = await buildReviewPrompt(task, {
    ...options,
    mode: options.mode === "collaborative" ? "normal" : options.mode,
  });
  const taskContextStart = base.prompt.indexOf("\nTask id:");
  const taskContext = taskContextStart >= 0 ? base.prompt.slice(taskContextStart + 1) : base.prompt;
  const contextPrompt = taskContext.replace(
    `Review mode: ${options.mode ?? "normal"}`,
    `Review mode: multi-peer aggregate ${options.mode ?? "normal"}`,
  );
  return `You are the aggregate reviewer for a multi-peer code review.

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

Peer review outputs:
${peerResults.map((result) => `--- ${result.reviewer} round ${result.round.round} exit ${result.review.exit_code} ---
${truncateForReview(result.review.stdout || result.review.stderr || "(no output)", REVIEW_OUTPUT_BUDGET)}`).join("\n\n")}

Repository/task context:
${contextPrompt}`;
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
  };
}

function parseReviewMode(value: unknown): ReviewMode | undefined {
  return value === "normal" || value === "adversarial" || value === "gate" || value === "collaborative"
    ? value
    : DEFAULT_REVIEW_MODE;
}

function parseReviewScope(value: unknown): ReviewScope | undefined {
  return value === "auto" || value === "working-tree" || value === "branch" ? value : undefined;
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
    assistants,
    review_gate: {
      available_tool: "must_call_after_code_changes",
      note: "MCP cannot technically force every final response through review, but this required post-edit tool is exposed with strong schema and server instructions.",
    },
    next_steps: [
      assistants[host]?.available.ok ? null : `Install or fix host assistant CLI: ${host}.`,
      ...peers.map((reviewer) => assistants[reviewer]?.available.ok ? null : `Install or fix peer assistant CLI: ${reviewer}.`),
      "Use must_call_after_code_changes after edits, or request_peer_review for an existing task id.",
    ].filter(Boolean),
  };
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
    return {
      ok: exitCode === 0,
      detail: (stdout || stderr).trim() || `command '${command}' ${exitCode === 0 ? "found" : "not found"}`,
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
  const latestRound = rounds.at(-1);
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
          : "Start review with request_peer_review, must_call_after_code_changes, or start_peer_review_async.",
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
