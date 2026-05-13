import type { AssistantHost, GitStatusEntry, PeerTask, ReviewRequestOptions } from "./types.ts";
import { getAssistantAdapter, normalizeHost, peerFor } from "./assistants.ts";
import { formatStatus, getReviewDiff, getStatusEntries } from "./git.ts";
import { listFindings, listReviewRounds } from "./store.ts";

const REVIEW_DIFF_BUDGET = parseInt(process.env.CODE_ASSISTANT_PEERS_DIFF_BUDGET ?? "12000", 10);
const ARGV_PROMPT_BUDGET = parseInt(process.env.CODE_ASSISTANT_PEERS_ARGV_PROMPT_BUDGET ?? "60000", 10);
const REVIEW_FOCUS_BUDGET = 1000;

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

export function buildReviewCommand(reviewer: AssistantHost): string[] {
  return getAssistantAdapter(reviewer).command.map((part) => part === "{system_prompt}" ? REVIEWER_SYSTEM_PROMPT : part);
}

export async function buildReviewPrompt(
  task: PeerTask,
  options: ReviewRequestOptions = {},
): Promise<{ prompt: string; warning?: string }> {
  const mode = options.mode ?? "normal";
  const workflow = options.workflow ?? "review_only";
  const currentStatus = await getStatusEntries(task.cwd);
  const reviewContext = await getReviewDiff(task.cwd, {
    scope: options.scope,
    base: options.base,
  });
  const focus = normalizeReviewFocus(options.focus ?? process.env.CODE_ASSISTANT_PEERS_REVIEW_FOCUS);
  const diff = truncateForReview(reviewContext.diff, REVIEW_DIFF_BUDGET);
  const warning = buildDirtyBaselineWarning(task.baseline_status, currentStatus);
  const modePrompt = mode === "adversarial"
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
- If MCP tools are available, call get_peer_task_context and get_open_findings for this task id before finalizing the review.
- If MCP tools are available, call record_peer_review before your final response to persist a concise summary and structured findings.

${warning || reviewContext.warning ? `Important warning:\n${[warning, reviewContext.warning].filter(Boolean).join("\n")}\n\n` : ""}Baseline git status when task began:
${formatStatus(task.baseline_status)}

Current git status:
${formatStatus(currentStatus)}

Changed files:
${reviewContext.changedFiles.length ? reviewContext.changedFiles.join("\n") : "(none detected)"}

Previous review memory:
${await buildPreviousReviewMemory(task.id)}

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

export async function runReviewCommand(
  reviewer: AssistantHost,
  cwd: string,
  prompt: string,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; command: string[] }> {
  const command = buildReviewCommand(reviewer);
  const adapter = getAssistantAdapter(reviewer);
  if (adapter.prompt_transport === "argv" && prompt.length > ARGV_PROMPT_BUDGET) {
    throw new Error(
      `Review prompt is ${prompt.length} characters, which exceeds CODE_ASSISTANT_PEERS_ARGV_PROMPT_BUDGET=${ARGV_PROMPT_BUDGET} for argv transport. Use stdin transport for large review prompts or lower CODE_ASSISTANT_PEERS_DIFF_BUDGET.`,
    );
  }
  const finalCommand = adapter.prompt_transport === "argv" ? [...command, prompt] : command;
  const recordedCommand = adapter.prompt_transport === "argv" ? [...command, "<prompt>"] : command;
  const proc = Bun.spawn(finalCommand, {
    cwd,
    stdin: adapter.prompt_transport === "stdin" ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  if (adapter.prompt_transport === "stdin") {
    proc.stdin?.write(prompt);
    proc.stdin?.end();
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stdout, stderr, command: recordedCommand };
}
