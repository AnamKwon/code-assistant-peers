import type { AssistantAdapter, AssistantHost, AssistantModelInfo, GitStatusEntry, PeerReviewResult, PeerTask, ReviewModelRoutingTier, ReviewRequestOptions } from "./types.ts";
import { getAssistantAdapter, normalizeHost, peerFor } from "./assistants.ts";
import { formatStatus, getReviewDiff, getStatusEntries } from "./git.ts";
import { buildSemanticContext, parseSerenaCommand } from "./semantic.ts";
import { listFindings, listReviewRounds } from "./store.ts";
import { emptyWorkspaceSnapshot } from "./workspace-snapshot.ts";

const REVIEW_DIFF_BUDGET = parseInt(process.env.CODE_ASSISTANT_PEERS_DIFF_BUDGET ?? "12000", 10);
const ARGV_PROMPT_BUDGET = parseInt(process.env.CODE_ASSISTANT_PEERS_ARGV_PROMPT_BUDGET ?? "60000", 10);
const REVIEW_OUTPUT_BUDGET = parseInt(process.env.CODE_ASSISTANT_PEERS_REVIEW_OUTPUT_BUDGET ?? "6000", 10);
const REVIEW_FOCUS_BUDGET = 1000;
const DEFAULT_REVIEW_COMMAND_TIMEOUT_MS = 600000;
const DEFAULT_REVIEW_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "TERM",
  "TMPDIR",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
];

export const REVIEWER_SYSTEM_PROMPT = `You are a senior code reviewer working as a read-only peer reviewer.

Your job is to review the implementation, not to rewrite it. Inspect the repository when needed, but do not modify files. Prioritize concrete correctness bugs, behavioral regressions, missing tests, security issues, and maintainability risks that matter for the requested change.

Return findings first, ordered by severity. Each finding should include a file/line reference when possible, explain the user-visible or developer-visible impact, and avoid speculative style-only comments. If you find no issues, say that clearly and mention any residual test risk.`;

export const REVIEW_FINDING_GUIDELINES = `Finding selection rules:
- Flag only issues the original author would likely fix after seeing the review.
- The issue must be discrete, actionable, and introduced by the reviewed change or clearly made relevant by it.
- Do not flag pre-existing code unless the change depends on it in a newly broken way.
- Do not rely on unstated assumptions about intent, inputs, or deployment. State the exact scenario needed for the issue to occur.
- Ignore style, formatting, naming, or broad architecture preferences unless they hide a real correctness, security, performance, or maintainability problem.
- If you claim another area is affected, identify the concrete call path, file, API contract, or user flow that is affected.
- Use one finding per distinct issue. Keep line ranges as short as possible and prefer locations that overlap the reviewed diff.
- Use priority tags in titles when useful: [P0] release blocker, [P1] urgent next-cycle fix, [P2] normal fix, [P3] low priority.

Finding comment rules:
- Keep each finding body to one concise paragraph.
- Explain why the issue matters and when it occurs.
- Do not include replacement patches unless workflow is peer_fix; if you include code, keep it minimal.`;

export const REVIEW_OUTPUT_GUIDELINES = `Output guidelines:
- Start with findings. If there are no qualifying findings, say "No findings." first.
- For each finding include: priority/severity, file and line, scenario, impact, and why the change caused or exposed it.
- End with an overall correctness verdict: "patch is correct" or "patch is incorrect".
- Treat the patch as incorrect only when a blocking or material correctness issue remains. Non-blocking notes do not make the patch incorrect.
- Keep the review compact. Do not repeat raw diffs or long logs.`;

export interface ReviewRoundSummary {
  reviewer: AssistantHost;
  label?: string;
  review: PeerReviewResult;
  round: { round: number };
}

type ReviewDiffContext = Awaited<ReturnType<typeof getReviewDiff>>;

export interface ReviewPromptSnapshot {
  currentStatus: GitStatusEntry[];
  reviewContext: ReviewDiffContext;
  semanticContext: string;
  warning?: string;
  previousReviewMemory: string;
  diffWasTruncated: boolean;
}

export interface ReviewPromptSnapshotSeed {
  currentStatus: GitStatusEntry[];
  reviewContext: ReviewDiffContext;
}

export interface ReviewModelRoutingContext {
  mode?: ReviewRequestOptions["mode"];
  workflow?: ReviewRequestOptions["workflow"];
  focus?: string | null;
  diffLength?: number;
  changedFileCount?: number;
  diffWasTruncated?: boolean;
  selfReview?: boolean;
}

export const SELF_REVIEW_PROMPT = `You are performing a self-review of your own implementation.

Be stricter than usual. Look for blind spots you may have missed, edge cases you assumed away, incomplete error handling, and tests that still need to be added. Prefer concrete issues you would still fix before shipping.`;

export function formatMultiPeerReviewOutputs(
  peerResults: ReviewRoundSummary[],
  selfReviewResult?: ReviewRoundSummary | null,
): string {
  const peerOutput = peerResults.length > 0
    ? peerResults.map((result) => {
      const peerLabel = result.label ?? result.reviewer;
      return `--- ${peerLabel} round ${result.round.round} exit ${result.review.exit_code} ---\n${truncateForReview(result.review.stdout || result.review.stderr || "(no output)", REVIEW_OUTPUT_BUDGET)}`;
    }).join("\n\n")
    : "(none)";
  const selfReviewSection = selfReviewResult
    ? `\n\nCodex self-review output:\n--- ${selfReviewResult.label ?? selfReviewResult.reviewer} round ${selfReviewResult.round.round} exit ${selfReviewResult.review.exit_code} ---\n${truncateForReview(selfReviewResult.review.stdout || selfReviewResult.review.stderr || "(no output)", REVIEW_OUTPUT_BUDGET)}`
    : "";
  return `Peer review outputs:\n${peerOutput}${selfReviewSection}`;
}

export const ADVERSARIAL_REVIEW_PROMPT = `You are performing an adversarial software review.

Your job is to challenge whether this change should ship. Look for the strongest concrete reasons the implementation, design, or assumptions may fail under real-world use. Prioritize high-cost failure modes: data loss, auth or trust-boundary mistakes, race conditions, rollback risk, compatibility regressions, hidden state assumptions, and missing failure handling.

Stay grounded in the repository context. Do not invent unsupported issues. Prefer one strong finding over several weak ones.`;

export const GATE_REVIEW_PROMPT = `You are performing a stop-gate review.

Return a compact answer whose first line is exactly:
ALLOW: <short reason>
or
BLOCK: <short reason>

Use BLOCK only for material issues that should be fixed before the coding assistant gives a final answer. Use ALLOW if there are no blocking findings.

After the first line, include a compact JSON object with:
{
  "findings": [
    {
      "title": "[P1|P2|P3] short title",
      "body": "one concise paragraph explaining the issue",
      "priority": 1,
      "file": "path",
      "line": 123,
      "confidence": 0.8
    }
  ],
  "overall_correctness": "patch is correct",
  "overall_explanation": "1-3 sentences",
  "overall_confidence": 0.8
}

Use an empty findings array when there are no blocking findings.`;

export const PEER_FIX_PROMPT = `You are reviewing code and proposing fixes as a peer assistant.

Do not modify files. Instead, return concrete fix proposals for each material finding. When useful, include compact patch-style snippets or exact replacement guidance that the host assistant can apply. Keep proposals minimal and scoped to the reviewed change.`;

export const COLLABORATIVE_REVIEW_PROMPT = `You are participating in a collaborative two-assistant review.

This mode intentionally spends more tokens than normal review. It is not the default because it runs reviews from both assistant perspectives and asks them to compare conclusions. Use it when higher review confidence is worth the extra token cost.

Review stance:
- The peer reviewer should be skeptical and adversarial.
- The host-side reviewer should defend reasonable implementation choices, challenge false positives, and identify anything the peer missed.
- The final result should merge both perspectives into the best actionable review, not simply concatenate both outputs.`;

export { normalizeHost, peerFor };

export function buildReviewCommand(reviewer: AssistantHost, model?: string | null): string[] {
  const adapter = getAssistantAdapter(reviewer);
  let command = adapter.command.map((part) => part === "{system_prompt}" ? REVIEWER_SYSTEM_PROMPT : part);
  command = insertModelArg(command, adapter, model);
  if (reviewer !== "claude") return command;

  const serenaCommand = parseSerenaCommand(process.env.CODE_ASSISTANT_PEERS_SERENA_COMMAND);
  const mcpConfig = JSON.stringify({
    mcpServers: serenaCommand
      ? {
        serena: {
          command: serenaCommand.command,
          args: serenaCommand.args,
        },
      }
      : {},
  });
  const insertAt = command.indexOf("--system-prompt");
  const mcpConfigIndex = insertAt === -1 ? command.length : insertAt;
  return [...command.slice(0, mcpConfigIndex), "--strict-mcp-config", "--mcp-config", mcpConfig, ...command.slice(mcpConfigIndex)];
}

function insertModelArg(command: string[], adapter: AssistantAdapter, model?: string | null): string[] {
  const normalized = model?.trim();
  if (!normalized || !adapter.model_arg) return command;
  const insertAt = findModelArgInsertIndex(command);
  return [...command.slice(0, insertAt), adapter.model_arg, normalized, ...command.slice(insertAt)];
}

function findModelArgInsertIndex(command: string[]): number {
  const systemPromptIndex = command.indexOf("--system-prompt");
  if (systemPromptIndex !== -1) return systemPromptIndex;
  const promptFlagIndex = command.findIndex((part) => part === "-p" || part === "--prompt");
  if (promptFlagIndex !== -1) return promptFlagIndex;
  const promptIndex = command.findIndex((part) => part === "-" || part === "");
  return promptIndex === -1 ? command.length : promptIndex;
}

export function buildSerenaReviewerGuidance(
  reviewer: AssistantHost,
  changedFiles: string[],
  diffWasTruncated: boolean,
): string {
  if (reviewer !== "claude" || !process.env.CODE_ASSISTANT_PEERS_SERENA_COMMAND?.trim()) return "";

  const sourceFiles = changedFiles.filter(isLikelyReviewerSourceFile).slice(0, 8);
  if (sourceFiles.length === 0) return "";

  const trigger = diffWasTruncated
    ? "- The included diff is truncated, so use Serena before making final findings about omitted or surrounding code."
    : "- Use Serena when the diff alone is not enough to understand symbol boundaries, references, implementations, or diagnostics.";

  return [
    "Serena reviewer tools:",
    "- Read-only Serena MCP tools are mounted for this Claude reviewer subprocess.",
    trigger,
    "- Start with `mcp__serena__get_symbols_overview` on changed source files, then use `mcp__serena__find_symbol`, `mcp__serena__find_referencing_symbols`, `mcp__serena__find_implementations`, and `mcp__serena__get_diagnostics_for_file` only when they can validate a concrete review concern.",
    "- Do not call Serena write/edit/onboarding/project-activation tools.",
    "Changed source files to consider:",
    sourceFiles.map((file) => `- ${file}`).join("\n"),
  ].join("\n");
}

export async function prepareReviewPromptSnapshot(
  task: PeerTask,
  options: ReviewRequestOptions = {},
  seed?: ReviewPromptSnapshotSeed,
): Promise<ReviewPromptSnapshot> {
  const [currentStatus, reviewContext] = seed
    ? [seed.currentStatus, seed.reviewContext]
    : await Promise.all([
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
  const warning = buildDirtyBaselineWarning(task.baseline_status, currentStatus);
  const [semanticContext, previousReviewMemory] = await Promise.all([
    buildSemanticContext(task.cwd, reviewContext.changedFiles, options.semantic_context, {
      diffLength: reviewContext.diff.length,
      diffBudget: REVIEW_DIFF_BUDGET,
    }),
    buildPreviousReviewMemory(task.id),
  ]);

  return {
    currentStatus,
    reviewContext,
    semanticContext,
    warning,
    previousReviewMemory,
    diffWasTruncated: reviewContext.diff.trim().length > REVIEW_DIFF_BUDGET,
  };
}

export async function buildReviewPrompt(
  task: PeerTask,
  options: ReviewRequestOptions = {},
): Promise<{ prompt: string; warning?: string }> {
  const snapshot = await prepareReviewPromptSnapshot(task, options);
  return buildReviewPromptFromSnapshot(task, options, snapshot);
}

export function buildReviewPromptFromSnapshot(
  task: PeerTask,
  options: ReviewRequestOptions,
  snapshot: ReviewPromptSnapshot,
): { prompt: string; warning?: string } {
  const mode = options.mode ?? "normal";
  const selfReview = options.self_review ?? false;
  const workflow = selfReview ? "review_only" : options.workflow ?? "review_only";
  if (selfReview && (mode === "gate" || mode === "collaborative")) {
    throw new Error("Codex self-review is only supported for normal and adversarial review modes");
  }
  const focus = normalizeReviewFocus(options.focus ?? process.env.CODE_ASSISTANT_PEERS_REVIEW_FOCUS);
  const reviewContext = snapshot.reviewContext;
  const serenaReviewerGuidance = buildSerenaReviewerGuidance(task.peer, reviewContext.changedFiles, snapshot.diffWasTruncated);
  const diff = truncateForReview(reviewContext.diff, REVIEW_DIFF_BUDGET);
  const warning = [snapshot.warning, reviewContext.warning].filter(Boolean).join("\n") || undefined;
  const modePrompt = selfReview
    ? mode === "adversarial"
      ? `${SELF_REVIEW_PROMPT}\n\n${ADVERSARIAL_REVIEW_PROMPT}`
      : SELF_REVIEW_PROMPT
    : mode === "adversarial"
      ? ADVERSARIAL_REVIEW_PROMPT
      : mode === "collaborative"
        ? `${ADVERSARIAL_REVIEW_PROMPT}\n\n${COLLABORATIVE_REVIEW_PROMPT}`
        : mode === "gate"
          ? GATE_REVIEW_PROMPT
          : REVIEWER_SYSTEM_PROMPT;
  const workflowPrompt = workflow === "peer_fix" ? `\n\n${PEER_FIX_PROMPT}` : "";
  const outputGuidelines = mode === "gate" ? "" : `\n\n${REVIEW_OUTPUT_GUIDELINES}`;

  const prompt = `${modePrompt}

${REVIEW_FINDING_GUIDELINES}

${outputGuidelines}${workflowPrompt}

Task id: ${task.id}
Original user request:
${task.prompt}

Review mode: ${mode}
${selfReview ? "Review perspective: self-review\n" : ""}
Workflow: ${workflow}
Review target: ${reviewContext.label}
${options.change_summary ? `Host change summary:\n${options.change_summary}\n` : ""}
${options.files_changed?.length ? `Host-reported files changed:\n${options.files_changed.join("\n")}\n` : ""}
${focus ? `Review focus:\n${focus}\n` : ""}

Review scope:
- Review only the implementation changes made for this task after ${task.created_at}.
- Do not modify files.
- If workflow is peer_fix, propose fixes only. The host assistant will decide whether to apply them.
- If review mode is collaborative, produce the peer-side skeptical review first. A host-side comparison pass will run after this.
- You are running in the repository cwd and may inspect files directly when the included diff is insufficient.
- Use the included status and diff as a starting point, not as a complete substitute for reading relevant surrounding code.
- Reviewer CLI processes are launched as separate subprocesses and do not inherit the host assistant's active MCP tool session. Do not call code-assistant-peers MCP tools from inside this reviewer subprocess.
- Treat any Semantic context section as advisory impact context. It may include host-collected Serena-derived symbols, references, implementations, or diagnostics, but it may also be absent or partial. Use the git status, diff, and repository reads as the source of truth.
- If read-only Serena MCP tools are explicitly mounted in this reviewer subprocess, you may use them to inspect symbols, references, implementations, and diagnostics.

${warning ? `Important warning:\n${warning}\n\n` : ""}Baseline git status when task began:
${formatStatus(task.baseline_status)}

Current git status:
${formatStatus(snapshot.currentStatus)}

Changed files:
${reviewContext.changedFiles.length ? reviewContext.changedFiles.join("\n") : "(none detected)"}

${serenaReviewerGuidance ? `${serenaReviewerGuidance}\n\n` : ""}
Semantic context:
${snapshot.semanticContext || "(semantic context provider disabled or no source symbols detected)"}

Previous review memory:
${snapshot.previousReviewMemory}

Included uncommitted diff for review:
${diff || "(no uncommitted diff detected)"}
`;

  return { prompt, warning };
}

async function buildPreviousReviewMemory(taskId: string): Promise<string> {
  const [rounds, openFindings] = await Promise.all([
    listReviewRounds(taskId),
    listFindings(taskId, "open"),
  ]);

  if (rounds.length === 0 && openFindings.length === 0) {
    return "(no previous review rounds recorded)";
  }

  const parts: string[] = [];
  if (openFindings.length > 0) {
    parts.push(`Open findings to verify:\n${openFindings.map((finding) => {
      const location = finding.file
        ? finding.line
          ? `${finding.file}:${finding.line}`
          : finding.file
        : "no file";
      return `- #${finding.id} [${finding.severity}] ${location}: ${finding.message}`;
    }).join("\n")}`);
  }

  if (rounds.length > 0) {
    parts.push(`Prior rounds:\n${rounds.map((round) => {
      const output = compactText(round.stdout || round.stderr || "(no output)", 1200);
      return `Round ${round.round} by ${round.reviewer} at ${round.completed_at}:\n${output}`;
    }).join("\n\n")}`);
  }

  return parts.join("\n\n");
}

function compactText(value: string, budget: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= budget) return trimmed;
  return `${trimmed.slice(0, budget)}\n[truncated]`;
}

export function truncateForReview(diff: string, budget: number): string {
  const trimmed = diff.trim();
  if (!trimmed) return "";
  if (trimmed.length <= budget) return trimmed;

  return `${trimmed.slice(0, budget)}

[Diff truncated at ${budget} characters. Inspect the repository directly for omitted hunks before making final findings.]`;
}

export function normalizeReviewFocus(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed.length <= REVIEW_FOCUS_BUDGET) return trimmed;
  return `${trimmed.slice(0, REVIEW_FOCUS_BUDGET)}\n[Review focus truncated at ${REVIEW_FOCUS_BUDGET} characters.]`;
}

function buildDirtyBaselineWarning(baseline: GitStatusEntry[], current: GitStatusEntry[]): string | undefined {
  if (baseline.length === 0) return undefined;
  const baselinePaths = new Set(baseline.map((entry) => entry.path));
  const stillPresent = current.filter((entry) => baselinePaths.has(entry.path));
  if (stillPresent.length === 0) {
    return "The working tree had pre-existing changes when this task began, but those paths no longer appear dirty.";
  }
  return "The working tree already had uncommitted changes when this task began. Treat baseline paths as pre-existing unless the diff clearly shows new task-related edits.";
}

function isLikelyReviewerSourceFile(file: string): boolean {
  return /\.(cjs|cts|js|jsx|mjs|mts|ts|tsx)$/.test(file);
}

export async function runReviewCommand(
  reviewer: AssistantHost,
  cwd: string,
  prompt: string,
  model?: string | null,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; command: string[] }> {
  const command = buildReviewCommand(reviewer, model);
  const adapter = getAssistantAdapter(reviewer);
  const recordedCommand = adapter.prompt_transport === "argv" ? [...command, "<prompt>"] : command;
  if (model?.trim() && !adapter.model_arg) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Reviewer '${reviewer}' does not declare a model_arg, so review_model cannot be applied to this adapter.`,
      command: recordedCommand,
    };
  }
  const env = buildReviewCommandEnv(adapter);
  const argvPromptBytes = byteLength(prompt);
  if (adapter.prompt_transport === "argv" && argvPromptBytes > ARGV_PROMPT_BUDGET) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Review prompt is ${argvPromptBytes} bytes, which exceeds CODE_ASSISTANT_PEERS_ARGV_PROMPT_BUDGET=${ARGV_PROMPT_BUDGET} for argv transport. Use stdin transport for large review prompts or lower CODE_ASSISTANT_PEERS_DIFF_BUDGET.`,
      command: recordedCommand,
    };
  }
  const finalCommand = adapter.prompt_transport === "argv" ? [...command, prompt] : command;
  const timeoutMs = resolveReviewCommandTimeoutMs(adapter);
  let proc: any;
  try {
    proc = Bun.spawn(finalCommand, {
      cwd,
      stdin: adapter.prompt_transport === "stdin" ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Review command failed to start: ${error instanceof Error ? error.message : String(error)}`,
      command: recordedCommand,
    };
  }

  if (adapter.prompt_transport === "stdin") {
    proc.stdin?.write(prompt);
    proc.stdin?.end();
  }

  let timedOut = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGTERM");
    forceKillTimer = setTimeout(() => proc.kill("SIGKILL"), 5000);
  }, timeoutMs);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (!timedOut) return { exitCode, stdout, stderr, command: recordedCommand };

    const timeoutMessage = `Review command timed out after ${timeoutMs}ms and was terminated. Set CODE_ASSISTANT_PEERS_REVIEW_TIMEOUT_MS to adjust this limit.`;
    return {
      exitCode: 1,
      stdout,
      stderr: stderr.trim() ? `${stderr.trim()}\n\n${timeoutMessage}` : timeoutMessage,
      command: recordedCommand,
    };
  } finally {
    clearTimeout(timeoutTimer);
    if (forceKillTimer) clearTimeout(forceKillTimer);
  }
}

function resolveReviewCommandTimeoutMs(adapter: AssistantAdapter): number {
  const configured = parsePositiveInteger(process.env.CODE_ASSISTANT_PEERS_REVIEW_TIMEOUT_MS);
  return configured ?? adapter.timeout_ms ?? DEFAULT_REVIEW_COMMAND_TIMEOUT_MS;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

export function buildReviewCommandEnv(adapter: AssistantAdapter, sourceEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (sourceEnv.CODE_ASSISTANT_PEERS_PASS_FULL_ENV === "1") {
    return {
      ...Object.fromEntries(Object.entries(sourceEnv).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      CODE_ASSISTANT_PEERS_REVIEWER_SUBPROCESS: "1",
    };
  }
  const allowlist = adapter.env_allowlist ?? DEFAULT_REVIEW_ENV_ALLOWLIST;
  const result: Record<string, string> = {};
  for (const key of allowlist) {
    const value = sourceEnv[key];
    if (value !== undefined) result[key] = value;
  }
  result.CODE_ASSISTANT_PEERS_REVIEWER_SUBPROCESS = "1";
  return result;
}

export function resolveReviewerModel(
  reviewer: AssistantHost,
  options: Pick<ReviewRequestOptions, "review_model" | "review_models">,
  context: ReviewModelRoutingContext = {},
): string | null {
  const explicit = options.review_models?.[reviewer]?.trim();
  if (explicit) {
    return explicit === "auto" ? selectAutoReviewerModel(reviewer, context) : explicit;
  }
  const global = options.review_model?.trim();
  if (global && global !== "auto") return global;
  if (global !== "auto") return null;
  return selectAutoReviewerModel(reviewer, context);
}

export function buildReviewModelRoutingContext(
  options: ReviewRequestOptions,
  snapshot: Pick<ReviewPromptSnapshot, "reviewContext" | "diffWasTruncated">,
): ReviewModelRoutingContext {
  return {
    mode: options.mode ?? "normal",
    workflow: options.workflow ?? "review_only",
    focus: normalizeReviewFocus(options.focus ?? process.env.CODE_ASSISTANT_PEERS_REVIEW_FOCUS),
    diffLength: snapshot.reviewContext.diff.length,
    changedFileCount: snapshot.reviewContext.changedFiles.length,
    diffWasTruncated: snapshot.diffWasTruncated,
    selfReview: options.self_review ?? false,
  };
}

export function selectAutoReviewerModel(
  reviewer: AssistantHost,
  context: ReviewModelRoutingContext = {},
): string | null {
  const adapter = getAssistantAdapter(reviewer);
  if (!adapter.model_arg || !adapter.models?.length) return null;
  return selectModelForTier(adapter.models, chooseReviewModelTier(context))?.id ?? null;
}

export function chooseReviewModelTier(context: ReviewModelRoutingContext = {}): ReviewModelRoutingTier {
  const focus = context.focus?.toLowerCase() ?? "";
  const changedFileCount = context.changedFileCount ?? 0;
  const diffLength = context.diffLength ?? 0;
  const highRisk = /\b(security|auth|permission|data loss|migration|rollback|payment|billing|secret|privacy|race|concurrency|database|schema|production|release|performance)\b/.test(focus);
  if (context.diffWasTruncated || diffLength > 30000 || changedFileCount > 20) return "long_context";
  if (highRisk || context.mode === "adversarial" || context.mode === "collaborative" || context.workflow === "peer_fix") return "deep";
  if (context.mode === "gate" || context.selfReview) return "balanced";
  if (diffLength > 0 && diffLength <= 4000 && changedFileCount <= 3 && isLowRiskFocus(focus)) return "fast";
  return "balanced";
}

function selectModelForTier(models: AssistantModelInfo[], tier: ReviewModelRoutingTier): AssistantModelInfo | null {
  const direct = models.find((model) => model.routing?.includes(tier));
  if (direct) return direct;
  if (tier === "long_context") {
    return models.find((model) => model.routing?.includes("deep")) ?? models.find((model) => model.quality === "highest") ?? null;
  }
  if (tier === "deep") {
    return models.find((model) => model.quality === "highest") ?? models.find((model) => model.quality === "high") ?? null;
  }
  if (tier === "fast") {
    return models.find((model) => model.latency === "low" || model.cost === "low") ?? null;
  }
  return models.find((model) => model.quality === "high") ?? models[0] ?? null;
}

function isLowRiskFocus(focus: string): boolean {
  if (!focus) return true;
  return /\b(docs?|documentation|readme|tests?|format|lint|typo|copy|comment)\b/.test(focus);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
