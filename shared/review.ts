import type { AssistantHost, GitStatusEntry, PeerReviewResult, PeerTask, ReviewRequestOptions } from "./types.ts";
import { normalizeHost, peerFor } from "./assistants.ts";
import { formatStatus, getReviewDiff, getStatusEntries } from "./git.ts";
import { buildSemanticContext } from "./semantic.ts";
import { listFindings, listReviewRounds } from "./store.ts";
import { emptyWorkspaceSnapshot } from "./workspace-snapshot.ts";
import {
  ADVERSARIAL_REVIEW_PROMPT,
  COLLABORATIVE_REVIEW_PROMPT,
  GATE_REVIEW_PROMPT,
  PEER_FIX_PROMPT,
  REVIEWER_SYSTEM_PROMPT,
  REVIEW_FINDING_GUIDELINES,
  REVIEW_OUTPUT_GUIDELINES,
  SELF_REVIEW_PROMPT,
} from "./review-prompts.ts";
import { normalizeReviewFocus } from "./review-utils.ts";
export {
  ADVERSARIAL_REVIEW_PROMPT,
  COLLABORATIVE_REVIEW_PROMPT,
  GATE_REVIEW_PROMPT,
  PEER_FIX_PROMPT,
  REVIEWER_SYSTEM_PROMPT,
  REVIEW_FINDING_GUIDELINES,
  REVIEW_OUTPUT_GUIDELINES,
  SELF_REVIEW_PROMPT,
} from "./review-prompts.ts";
export { normalizeReviewFocus } from "./review-utils.ts";
export {
  buildReviewCommand,
  buildReviewCommandEnv,
  runReviewCommand,
} from "./reviewer-command.ts";
export {
  buildReviewModelRoutingContext,
  chooseReviewModelTier,
  resolveReviewerModel,
  selectAutoReviewerModel,
  type ReviewModelRoutingContext,
} from "./review-model-routing.ts";

const REVIEW_DIFF_BUDGET = parseInt(process.env.CODE_ASSISTANT_PEERS_DIFF_BUDGET ?? "12000", 10);
const REVIEW_OUTPUT_BUDGET = parseInt(process.env.CODE_ASSISTANT_PEERS_REVIEW_OUTPUT_BUDGET ?? "6000", 10);

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
    ? `\n\nHost self-review output:\n--- ${selfReviewResult.label ?? selfReviewResult.reviewer} round ${selfReviewResult.round.round} exit ${selfReviewResult.review.exit_code} ---\n${truncateForReview(selfReviewResult.review.stdout || selfReviewResult.review.stderr || "(no output)", REVIEW_OUTPUT_BUDGET)}`
    : "";
  return `Peer review outputs:\n${peerOutput}${selfReviewSection}`;
}

export { normalizeHost, peerFor };

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
    throw new Error("Self-review is only supported for normal and adversarial review modes");
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
