#!/usr/bin/env bun
// Reviewer worker for the "channel" review transport — the half that actually keeps reviews
// on the SUBSCRIPTION pool instead of `claude -p`.
//
//   broker (localhost) ──GET /next──▶ reviewer worker (this file)
//                                       │  drives a backgrounded INTERACTIVE `claude` TUI
//                                       │  (tmux send-keys → capture-pane), read-only
//                                       ◀──POST /jobs/:id/result── reviewer worker
//
// Why interactive (not `claude -p`): per Anthropic's billing model, interactive Claude Code in
// a terminal draws from the Pro/Max SUBSCRIPTION, while `claude -p` / the Agent SDK draw from a
// separate credit pool (separated 2026-06-15). Driving the live TUI via tmux keeps it
// interactive. IMPORTANT: `ANTHROPIC_API_KEY` in the environment forces API-key billing
// regardless of mode — it must be UNSET for this session, and `claude` must be logged in via
// claude.ai (OAuth). See broker/REVIEWER.md.
//
// Run:  bun broker/reviewer.ts            # ensures the tmux session + processes jobs forever
//       bun broker/reviewer.ts --once     # process at most one job then exit (verification)
//       bun broker/reviewer.ts --echo     # fake session that echoes the prompt (no claude; dev)

import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { codexReviewerInstructionsFor, liveReviewerSystemPromptFor, toTomlBasicString } from "../shared/review-prompts.ts";

const DEFAULT_BROKER_URL = "http://127.0.0.1:7899";
const DEFAULT_POLL_INTERVAL_MS = 250; // reduced from 1000ms — all polling layers share this
const DEFAULT_DELIVER_TIMEOUT_MS = 600_000;

export interface ReviewJob {
  id: string;
  reviewer: string;
  prompt: string;
  cwd: string; // repo dir this review is for ("" => worker default); routes to a per-repo session
  model: string;
}

// A reviewer backend. The real one drives a live `claude` TUI; tests/dev inject fakes.
export interface ReviewerSession {
  deliver(prompt: string, jobId: string, signal: AbortSignal, model?: string | null): Promise<string>;
  close?(): Promise<void>;
}

export interface ReviewerWorkerOptions {
  brokerUrl: string;
  // Build (or look up) the reviewer session for a given reviewer kind + repo cwd. The worker
  // caches one session per distinct (reviewer, cwd) pair, so each CLI kind and each repo gets
  // its own backgrounded session, and concurrent reviews never share a working directory or a
  // TUI. May throw for an unsupported reviewer — the worker reports that as a job error.
  sessionFor: (reviewer: string, cwd: string) => ReviewerSession;
  signal: AbortSignal;
  pollIntervalMs?: number;
  once?: boolean;
  log?: (message: string) => void;
  // Maximum number of (reviewer, cwd) sessions running concurrently. Default 8. Lower values
  // reduce the number of jobs that would be permanently lost if the worker crashes; higher values
  // allow more parallelism. Must be >= 1.
  maxConcurrentSessions?: number;
}

// Claim the next pending job from the broker. Returns null when there is nothing to do or the
// broker is briefly unreachable (the loop just retries) — never throws for transport hiccups.
export async function claimNextJob(brokerUrl: string, signal: AbortSignal): Promise<ReviewJob | null> {
  let res: Response;
  try {
    res = await fetch(`${brokerUrl}/next`, { signal });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const body = (await res.json().catch(() => ({}))) as { id?: string | null; reviewer?: string; prompt?: string; cwd?: string; model?: string };
  if (!body.id || !body.prompt) return null;
  return { id: body.id, reviewer: String(body.reviewer ?? "claude-live"), prompt: body.prompt, cwd: String(body.cwd ?? ""), model: String(body.model ?? "") };
}

async function postResult(brokerUrl: string, jobId: string, result: string): Promise<void> {
  await fetch(`${brokerUrl}/jobs/${encodeURIComponent(jobId)}/result`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ result }),
  });
}

async function postError(brokerUrl: string, jobId: string, error: string): Promise<void> {
  await fetch(`${brokerUrl}/jobs/${encodeURIComponent(jobId)}/error`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ error }),
  });
}

// Reclaim jobs left in "claimed" state by a previous worker instance (crash/restart).
// Called at worker startup so stale claimed jobs become visible to GET /next again.
async function reclaimStaleClaims(brokerUrl: string): Promise<void> {
  const res = await fetch(`${brokerUrl}/reclaim`, { method: "POST" }).catch(() => null);
  if (res?.ok) {
    const body = (await res.json().catch(() => ({}))) as { reclaimed?: number };
    if (body.reclaimed) console.error(`[reviewer] reclaimed ${body.reclaimed} stale claimed job(s) from prior worker`);
  }
}

// The worker loop: claim → deliver to the live session → report result/error. Bounded only by
// the abort signal. A failed delivery is reported as a job error (not a crash) so one bad review
// never takes the worker down.
export async function runReviewerWorker(options: ReviewerWorkerOptions): Promise<void> {
  const { brokerUrl, sessionFor, signal } = options;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const log = options.log ?? (() => {});

  // One session per distinct (reviewer kind, repo cwd) pair, created lazily and reused.
  const sessions = new Map<string, ReviewerSession>();
  const resolveSession = (reviewer: string, cwd: string): ReviewerSession => {
    const key = `${reviewer}|${cwd}`;
    let session = sessions.get(key);
    if (!session) {
      session = sessionFor(reviewer, cwd);
      sessions.set(key, session);
    }
    return session;
  };

  // Reclaim jobs left in "claimed" by a crashed/replaced prior worker so they become visible
  // to GET /next again. Best-effort — ignore if broker is unreachable.
  await reclaimStaleClaims(brokerUrl);

  // Per-(reviewer, cwd) promise chain: jobs for the SAME session run sequentially
  // (they share one tmux TUI), while jobs for DIFFERENT sessions run concurrently.
  // Each new job is appended to the tail of its session's chain and starts as soon
  // as the prior job for that session finishes — without blocking other sessions.
  const chainByKey = new Map<string, Promise<void>>();
  // Total number of jobs currently claimed but not yet completed (running or queued in a chain).
  // This is the true bound on crash-loss: at most MAX_CONCURRENT_CLAIMS jobs will be "claimed"
  // in the broker at any time. chainByKey.size only counts distinct session pairs, not queued
  // jobs for the same pair, so it would not enforce the limit for hot keys.
  // runningCount: number of jobs CURRENTLY EXECUTING — jobs at the head of their chain.
  // Same-key queued jobs (waiting behind the head) are NOT counted; they queue internally
  // without consuming a running slot or blocking other pairs from being claimed.
  // Note: a single hot (reviewer, cwd) pair can still claim and queue an unbounded number of
  // jobs from the broker. If the worker crashes, those claimed-but-queued jobs are recovered
  // by POST /reclaim at startup (which resets them from "claimed" back to "pending").
  let runningCount = 0;
  // Max active sessions (heads of chains actually executing). Enforce >= 1 so the loop can
  // always make progress; a value of 0 would deadlock the gate immediately.
  const MAX_CONCURRENT_RUNNING = Math.max(1, options.maxConcurrentSessions ?? 8);

  const enqueueJob = (job: ReviewJob): void => {
    const key = `${job.reviewer}|${job.cwd || ""}`;
    // A job for a key with no existing chain starts immediately (head-of-chain = running now).
    // Count it synchronously so the gate in the main loop sees the correct running count
    // before the next await. A queued job (key already has an active chain) defers its
    // increment until it actually starts executing — its chain predecessor is the running job.
    const isNewKey = !chainByKey.has(key);
    if (isNewKey) runningCount++;

    const previous = chainByKey.get(key) ?? Promise.resolve();
    const jobPromise: Promise<void> = previous.then(async () => {
      if (!isNewKey) runningCount++; // same-key queued job: increment when predecessor finishes
      try {
        const review = await resolveSession(job.reviewer, job.cwd).deliver(job.prompt, job.id, signal, job.model);
        await postResult(brokerUrl, job.id, review);
        log(`job ${job.id} reviewed (${review.length} chars)`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await postError(brokerUrl, job.id, `reviewer worker failed: ${message}`).catch(() => {});
        log(`job ${job.id} failed: ${message}`);
      } finally {
        runningCount--;
      }
    }).finally(() => {
      if (chainByKey.get(key) === jobPromise) chainByKey.delete(key);
    });

    chainByKey.set(key, jobPromise);
  };

  try {
    while (!signal.aborted) {
      // Back-pressure: gate on currently RUNNING jobs, not total claimed.
      // A same-key backlog queues internally without counting against this limit,
      // so unrelated pairs can always start running in their own sessions.
      if (runningCount >= MAX_CONCURRENT_RUNNING) {
        await sleep(pollIntervalMs, signal);
        continue;
      }

      const job = await claimNextJob(brokerUrl, signal);
      if (!job) {
        if (options.once) {
          // Drain: wait for all in-flight chains before returning.
          await Promise.all([...chainByKey.values()]);
          return;
        }
        await sleep(pollIntervalMs, signal);
        continue;
      }

      log(`claimed job ${job.id} (${job.reviewer}, cwd=${job.cwd || "(default)"})`);
      enqueueJob(job);
      // Do NOT await — immediately loop back to claim the next job.
    }
  } finally {
    // On shutdown, wait for in-flight jobs to complete so results are posted before exit.
    await Promise.all([...chainByKey.values()]).catch(() => {});
    for (const session of sessions.values()) await session.close?.();
  }
}

// ---------------------------------------------------------------------------
// Output extraction (pure, unit-tested)
//
// We instruct the live session to WRAP its review between two unique-per-job markers: a BEGIN
// marker printed immediately before the review body and a DONE marker on the final line. Each
// marker also appears once where our instruction is echoed into the input, so the review is
// complete only when each marker appears at least twice (echo + emitted). We take the text
// between the LAST BEGIN and the LAST DONE occurrence — this structurally excludes the echoed
// instruction, any preamble narration, and tool-status chrome printed before the body (which the
// old single-end-marker scheme could only filter heuristically). Per-job-unique markers mean
// stale markers from prior jobs in the scrollback never match.
// ---------------------------------------------------------------------------

// Plain hyphenated tokens only — NO angle brackets, backticks, or markdown-special chars. The
// Claude TUI/markdown renderer mangles bracketed markers (e.g. `<<<x>>>` renders as `<<x>>`),
// which broke marker matching. Letters/digits/hyphens/underscores survive rendering intact.
export function beginMarkerFor(jobId: string): string {
  return `PEER-REVIEW-BEGIN-${jobId}`;
}

export function doneMarkerFor(jobId: string): string {
  return `PEER-REVIEW-DONE-${jobId}-END`;
}

// outputFile: when provided, Claude is instructed to write the review to this file (primary
// transport). When absent, falls back to the terminal-print protocol (capture-pane extraction).
export function wrapLiveReviewPrompt(
  prompt: string,
  begin: string,
  done: string,
  outputFile?: string,
  writeMethod: "write_file_tool" | "shell" = "write_file_tool",
): string {
  if (outputFile) {
    // Markers are described as concatenated parts (not full literals) so reading this file does
    // not place the full marker strings in the pane, avoiding false-positive extractReviewFromCapture
    // matches. The same technique is used for the terminal-print protocol below.
    const writeRule = writeMethod === "shell"
      // Codex TUI: no native write_file; use bash shell commands (auto-approved with -a never)
      ? "- Use a bash shell command (e.g. cat/tee/printf) to write the file. Do NOT use MCP tools."
      // Gemini/Claude: use native write_file (auto-approved in auto_edit / plan+allowedTools mode)
      : "- Use the native write_file tool to create the file. Do NOT use shell run_shell_command or MCP tools.";
    return [
      "LIVE REVIEW FILE OUTPUT REQUIREMENTS",
      "",
      `Write your complete review to this file: ${outputFile}`,
      "",
      "The file content must begin with the BEGIN marker line and end with the DONE marker line.",
      "The BEGIN marker is formed by concatenating these parts with no separator:",
      ...markerParts(begin).map((part) => `- ${part}`),
      "The DONE marker is formed by concatenating these parts with no separator:",
      ...markerParts(done).map((part) => `- ${part}`),
      "",
      "Rules:",
      writeRule,
      "- Write the BEGIN and DONE marker lines as plain text with no indentation, markdown fencing, or quoting.",
      "- Do not omit the marker lines even if the review instructions below specify another output format.",
      "- ALSO print the BEGIN marker, the full review, and the DONE marker to the terminal (in addition",
      "  to writing the file). This ensures the worker can extract the review if the file write fails.",
      "",
      "REVIEW INSTRUCTIONS",
      "",
      prompt,
    ].join("\n");
  }
  return [
    "LIVE REVIEW TRANSPORT REQUIREMENTS",
    "",
    "Before writing any review content, print the BEGIN marker line formed by concatenating these parts with no separator:",
    ...markerParts(begin).map((part) => `- ${part}`),
    "After the full review, print the DONE marker line formed by concatenating these parts with no separator:",
    ...markerParts(done).map((part) => `- ${part}`),
    "Do not omit these marker lines, even if the review instructions below specify another output format.",
    "Do not quote, indent, wrap, or put markdown around the marker lines.",
    "",
    "REVIEW INSTRUCTIONS",
    "",
    prompt,
  ].join("\n");
}

function markerParts(marker: string): string[] {
  const match = marker.match(/^(PEER-REVIEW-(?:BEGIN|DONE)-)(.+?)(-END)?$/);
  if (!match) return [marker];
  return [match[1], match[2], match[3] ?? ""].filter(Boolean);
}

// Returns the review text if the capture shows a completed review (both markers EMITTED by the
// session, i.e. each present at least twice — echo + emitted), otherwise null (still running).
export function extractReviewFromCapture(capture: string, jobId: string): string | null {
  const begin = beginMarkerFor(jobId);
  const done = doneMarkerFor(jobId);
  const firstBegin = capture.indexOf(begin);
  const firstDone = capture.indexOf(done);
  if (firstBegin === -1 || firstDone === -1) return null;
  const lastBegin = capture.lastIndexOf(begin);
  const lastDone = capture.lastIndexOf(done);
  // Each marker appears once in the echoed instruction; require a second (emitted) occurrence of
  // both, in order, so the echo alone (which contains BEGIN then DONE) never matches.
  if (lastBegin === firstBegin || lastDone === firstDone) return null;
  if (lastDone <= lastBegin) return null; // mid-repaint / out-of-order — keep polling

  const between = capture.slice(lastBegin + begin.length, lastDone);
  return cleanCapturedReview(between);
}

// Strip TUI chrome from scraped pane text: box-drawing borders, the leading "> " input echo,
// and blank padding. Best-effort — the pane is a rendered screen, not a clean stream.
function cleanCapturedReview(text: string): string {
  const lines = text
    .split("\n")
    .map((line) =>
      line
        // Drop tmux/Claude TUI box-drawing border characters and trailing whitespace.
        .replace(/[│┃|]\s?/g, "")
        .replace(/[─━╭╮╰╯┌┐└┘]/g, "")
        // Strip the leading response bullet glyph Claude prints before assistant text.
        .replace(/^\s*[⏺●○•]\s?/, "")
        .replace(/\s+$/g, ""),
    )
    // Drop Claude tool-call status chrome (never review content), e.g. "Read 1 file (ctrl+o to
    // expand)" or other "(ctrl+o to expand)" affordances captured from the rendered pane.
    .filter((line) => !/\(ctrl\+o to expand\)/.test(line) && !/^\s*Read \d+ file\b/.test(line));
  // Trim leading/trailing blank lines.
  while (lines.length && lines[0].trim() === "") lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.join("\n").trim();
}

// Reads the output file written by Claude's Write tool. Returns the review body (text between
// the BEGIN and DONE markers) if both are present, null otherwise (file absent or incomplete).
// Unlike capture-pane output, the file is a clean text stream with no TUI chrome.
export async function extractReviewFromFile(outputFile: string, jobId: string): Promise<string | null> {
  let content: string;
  try {
    content = await readFile(outputFile, "utf8");
  } catch {
    return null;
  }
  const begin = beginMarkerFor(jobId);
  const done = doneMarkerFor(jobId);
  const beginIdx = content.indexOf(begin);
  const doneIdx = content.indexOf(done);
  if (beginIdx === -1 || doneIdx === -1 || doneIdx <= beginIdx) return null;
  const body = content.slice(beginIdx + begin.length, doneIdx);
  // Trim leading/trailing blank lines only (file content has no TUI chrome).
  // Return empty string (not null) so a completed-but-empty review is accepted rather than
  // treated as "file not ready yet" — which would cause polling until deliverTimeoutMs.
  return body.replace(/^\n+/, "").replace(/\n+$/, "").trim();
}

// Deletes output files older than maxAgeMs from promptDir. Called once at session init to
// recover from prior worker crashes that left output files behind (the finally block normally
// handles cleanup, but is skipped on SIGKILL or hard crash).
export async function sweepOrphanedOutputFiles(promptDir: string, maxAgeMs = 2 * 60 * 60 * 1000): Promise<void> {
  try {
    const files = await readdir(promptDir);
    const now = Date.now();
    await Promise.all(
      files
        .filter((f) => f.endsWith("-output.md"))
        .map(async (f) => {
          const filePath = join(promptDir, f);
          const s = await stat(filePath).catch(() => null);
          if (s && now - s.mtimeMs > maxAgeMs) await rm(filePath, { force: true }).catch(() => {});
        }),
    );
  } catch {
    // promptDir may not exist yet; that is fine.
  }
}

// ---------------------------------------------------------------------------
// tmux-driven interactive CLI session (the real backend) — generic over the reviewer CLI
// (claude / gemini / codex), parameterized by launch command and conversation-reset command.
// ---------------------------------------------------------------------------

export interface TmuxSessionConfig {
  sessionName: string;
  cwd: string;
  // Full argv launched inside the tmux session (CLI binary + read-only flags + any prompt-dir
  // access grant such as claude's --add-dir or gemini's --include-directories).
  launchCommand: string[];
  launchCommandForModel?: (model: string | null, sessionId: string | null) => string[];
  resumeCommandForModel?: (sessionId: string, model: string | null) => string[];
  initialSessionId?: string | null;
  initialModel?: string | null;
  hasPersistedSessionId: boolean;
  stateKey: string;
  discoverSessionId?: (cwd: string) => Promise<string | null>;
  // Dir the per-job prompt files are written to. Must be readable by the session (see above).
  promptDir: string;
  // Slash command that resets the TUI's conversation (claude/gemini: "/clear", codex: "/new").
  // null = the CLI has no known reset command; reviews then share the conversation.
  clearCommand: string | null;
  // Send the clear command before each review (default true). False keeps the live session's
  // conversation memory across reviews of this repo — richer follow-up context at the cost of
  // cross-task bleed and unbounded context growth.
  clearBetweenReviews: boolean;
  startupTimeoutMs: number;
  deliverTimeoutMs: number;
  pollIntervalMs: number;
  // When true, Claude is instructed to write the review to an output file via the Write tool
  // (primary extraction path). Requires Write(promptDir:*) in --allowedTools. Falls back to
  // capture-pane extraction if the file is absent. Set for claude-live; not for gemini/codex.
  useOutputFile: boolean;
  // If set, written to promptDir before the session is launched. Used to supply a per-session
  // policy file that restricts write access (e.g. gemini --admin-policy).
  policyFile?: { path: string; content: string };
  // Generates a fresh session ID for NEW session launches. When provided, this is called instead
  // of reusing this.sessionId (which may be a persisted ID from an old session whose history would
  // be loaded by the CLI on startup, slowing things down or causing crashes).
  freshSessionId?: () => string;
  // How the output file should be written. "write_file_tool" = use the native write_file tool
  // (gemini); "shell" = use bash/cat shell commands (codex; write_file not available in TUI mode).
  outputFileWriteMethod: "write_file_tool" | "shell";
  devLog?: DevLogger;
}

type DevLogger = (event: string, data?: Record<string, unknown>) => void;

// Read-only launch: plan mode + edit tools disallowed so a reviewed diff containing injected
// instructions still cannot modify files (same safety model as the `claude -p` reviewer).
// Keep this constant for backward compatibility with CODE_ASSISTANT_PEERS_REVIEWER_CLAUDE_ARGS
// overrides that reference it, and as the fallback when promptDir is unavailable.
export const DEFAULT_REVIEWER_CLAUDE_ARGS = [
  "--permission-mode",
  "plan",
  "--allowedTools",
  "Read,Grep,Glob,Bash(git status:*),Bash(git diff:*),Bash(git show:*),Bash(git log:*),Bash(git ls-files:*)",
  "--disallowedTools",
  "Edit,Write,MultiEdit,NotebookEdit",
];

// Builds the default claude-live launch args with:
//   - system prompt reflecting the workflow mode (review_only vs peer_fix)
//   - Write tool scoped to promptDir so Claude can write the output file
// The env var override CODE_ASSISTANT_PEERS_REVIEWER_CLAUDE_ARGS bypasses this.
export function buildDefaultReviewerClaudeArgs(promptDir: string, workflow: "review_only" | "peer_fix"): string[] {
  return [
    "--permission-mode",
    "plan",
    "--append-system-prompt",
    liveReviewerSystemPromptFor(workflow),
    "--allowedTools",
    [
      "Read",
      "Grep",
      "Glob",
      "Bash(git status:*)",
      "Bash(git diff:*)",
      "Bash(git show:*)",
      "Bash(git log:*)",
      "Bash(git ls-files:*)",
      `Write(${promptDir}:*)`,
    ].join(","),
    "--disallowedTools",
    "Edit,MultiEdit,NotebookEdit",
  ];
}

// Reads the workflow mode from env vars.
// Checks CODE_ASSISTANT_PEERS_REVIEWER_WORKFLOW first (reviewer-specific override), then falls
// back to CODE_ASSISTANT_PEERS_WORKFLOW (the product-wide var set by setup/install paths so a
// standard `--workflow=peer_fix` install automatically enables the peer-fix system prompt).
export function resolveReviewerWorkflow(env: NodeJS.ProcessEnv = process.env): "review_only" | "peer_fix" {
  const val = env.CODE_ASSISTANT_PEERS_REVIEWER_WORKFLOW ?? env.CODE_ASSISTANT_PEERS_WORKFLOW;
  return val === "peer_fix" ? "peer_fix" : "review_only";
}

// Builds the default codex-live launch args with:
//   - system prompt via -c instructions=... (TOML basic string, codex's system prompt mechanism)
//   - --sandbox workspace-write so codex can write the output file to .peer-review/
//   - -a never so no approval dialogs block the headless tmux session
//
// NOTE: codex --sandbox read-only + --add-dir does NOT work — codex ignores --add-dir when the
// effective sandbox is read-only ("Ignoring --add-dir because the effective permissions do not
// allow additional writable roots"). workspace-write is therefore the only option that enables
// file output. The behavioral constraint ("do NOT modify project source files") in the injected
// instructions is the write-safety mechanism for codex; it is advisory, not a hard sandbox.
// Users who need a hard read-only guarantee can set CODE_ASSISTANT_PEERS_REVIEWER_CODEX_ARGS to
// "--sandbox read-only" (disabling file output) and use the capture-pane fallback instead.
// Path to the minimal CODEX_HOME used by reviewer sessions. This dir is created lazily with
// a minimal config.toml that: trusts the workspace, disables MCP servers, and carries over
// auth + model NUX state so codex starts without trust/model-change dialogs.
export const REVIEWER_CODEX_HOME = join(tmpdir(), "peer-reviewer-codex-home");

// Sets up REVIEWER_CODEX_HOME with auth credentials and a minimal config for the given workspace.
// Merges the workspace trust entry into existing config (does NOT wipe other repos' trust).
// Copies NUX/migration state from ~/.codex/config.toml so model dialogs are pre-dismissed.
function setupReviewerCodexHome(workspaceCwd: string): void {
  mkdirSync(REVIEWER_CODEX_HOME, { recursive: true });

  // Copy auth only if not yet present (one-time setup).
  for (const name of ["auth.json", "installation_id"] as const) {
    const dst = join(REVIEWER_CODEX_HOME, name);
    try {
      if (!require("node:fs").existsSync(dst)) {
        require("node:fs").copyFileSync(join(homedir(), ".codex", name), dst);
      }
    } catch { /* source may not exist */ }
  }

  // Build config.toml: pull NUX/migration state from the user's real config, add workspace trust,
  // and empty-out mcp_servers so no MCP dialogs appear.
  const userConfigPath = join(homedir(), ".codex", "config.toml");
  let userConfig = "";
  try { userConfig = readFileSync(userConfigPath, "utf8"); } catch { /* ok */ }

  // Extract tui.model_availability_nux and notice.model_migrations sections from user config.
  const extractSection = (src: string, header: string): string => {
    const start = src.indexOf(`[${header}]`);
    if (start === -1) return "";
    const end = src.indexOf("\n[", start + 1);
    return src.slice(start, end === -1 ? undefined : end).trimEnd();
  };
  const nuxSection = extractSection(userConfig, "tui.model_availability_nux") ||
    `[tui.model_availability_nux]\n"gpt-5.5" = 4`;
  const migrationsSection = extractSection(userConfig, "notice.model_migrations") ||
    `[notice.model_migrations]\n"gpt-5.4" = "gpt-5.5"`;

  // Read existing reviewer config to preserve trust entries for other repos.
  const configPath = join(REVIEWER_CODEX_HOME, "config.toml");
  let existing = "";
  try { existing = readFileSync(configPath, "utf8"); } catch { /* first run */ }
  const trustHeader = `[projects."${workspaceCwd}"]`;
  const trustEntry = `${trustHeader}\ntrust_level = "trusted"`;

  const configLines = [
    "# reviewer session: no MCP servers, workspace trusted",
    'model = "gpt-5.5"',
    'model_reasoning_effort = "medium"',
    'service_tier = "fast"',
    "",
  ];

  // Include all existing project trust entries from the current reviewer config.
  const projectMatches = [...existing.matchAll(/\[projects\."([^"]+)"\][^\[]+/g)];
  const trustedCwds = new Set<string>(projectMatches.map((m) => m[1]));
  trustedCwds.add(workspaceCwd); // ensure current workspace is trusted
  for (const cwd of trustedCwds) {
    configLines.push(`[projects."${cwd}"]`, 'trust_level = "trusted"', "");
  }

  configLines.push(nuxSection, "", migrationsSection, "", "[mcp_servers]", "");

  require("node:fs").writeFileSync(configPath, configLines.join("\n"), "utf8");
}

export function buildDefaultReviewerCodexArgs(promptDir: string, workflow: "review_only" | "peer_fix"): string[] {
  const instructions = toTomlBasicString(codexReviewerInstructionsFor(workflow));
  return [
    "-c", `instructions="${instructions}"`,
    "--sandbox", "workspace-write",
    "-a", "never",
  ];
}

// Builds a gemini admin-policy TOML that hard-restricts write_file and replace to promptDir.
// Loaded via --admin-policy so it runs at tier 5 (highest), overriding approval-mode defaults.
// This allows writes to .peer-review/ (auto-approved via ALLOW rule, priority 500) while
// denying all other file writes (DENY rule, priority 100), giving the same hard boundary as
// --disallowedTools for claude. (Codex uses --sandbox workspace-write with advisory instructions;
// codex --sandbox read-only ignores --add-dir so a hard file-level boundary is unavailable there.)
export function buildGeminiReviewerPolicy(promptDir: string): string {
  // The argsPattern is a regex matched against the full JSON args string.
  // Defense strategy:
  //   1. ^ anchor: ensures "file_path" is the first key — blocks content-injection bypass
  //      ({"file_path":".env","content":"... /repo/.peer-review/ ..."} fails at ^ because
  //      the embedded path appears in content, not at position 0).
  //   2. [a-zA-Z0-9._-]* after the prefix: only flat filenames (no slashes) — blocks ALL
  //      path traversal variants (direct "../", nested "sub/../../", etc.) because "/" is
  //      not in the character class, so the match fails before the closing '"'.
  //   3. Trailing \" in the pattern: requires the file_path JSON value to end after the
  //      filename — a traversal attempt cannot satisfy both the char class and the closing '"'.
  //
  // This blocks: content injection, sibling paths (.peer-review.ts), direct ../,
  //              nested traversal (sub/../../), and any additional subdirectory writes.
  // Accepted: output files must be flat in promptDir (no subdirs) — our UUID filenames satisfy this.
  const regexEscaped = promptDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Additionally TOML-escape the regex string (only \ and " need escaping in TOML basic strings).
  const tomlEscaped = regexEscaped.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  // Allow optional whitespace around the colon and after the opening brace so the pattern is
  // robust to JSON serialization variants (e.g. {"file_path" : "..." } or { "file_path":"..."}).
  // The ^ anchor still prevents content-injection; [a-zA-Z0-9._-]* still blocks traversal.
  const filePathPattern = `^{\\s*\\"file_path\\"\\s*:\\s*\\"${tomlEscaped}/[a-zA-Z0-9._-]*\\"`;
  return [
    "# Reviewer session policy: restricts file writes to .peer-review/ and blocks MCP write tools.",
    "",
    "# Allow write_file/replace ONLY to the review output directory (flat filenames, no traversal).",
    "[[rule]]",
    `toolName = ["write_file", "replace"]`,
    `argsPattern = "${filePathPattern}"`,
    `decision = "allow"`,
    `priority = 500`,
    "",
    "# Deny write_file/replace to any other path.",
    "[[rule]]",
    `toolName = ["write_file", "replace"]`,
    `decision = "deny"`,
    `priority = 100`,
    `denyMessage = "Reviewer session: file writes are restricted to the .peer-review/ output directory."`,
    "",
    "# Deny shell execution — hard boundary preventing prompt-injection from running arbitrary",
    "# shell commands (sed -i, tee, python scripts, etc.) against project files.",
    "# Priority 5.600 > auto_edit ask_user (1.010) so shell is blocked without a dialog.",
    "[[rule]]",
    `toolName = "run_shell_command"`,
    `decision = "deny"`,
    `priority = 600`,
    `denyMessage = "Reviewer session: shell execution is disabled for security."`,
    "",
    "# Deny serena MCP write/modify tools — belt-and-suspenders in case --allowed-mcp-server-names",
    "# is ineffective and serena loads anyway.",
    "[[rule]]",
    `toolName = ["mcp__serena__create_text_file", "mcp__serena__replace_content", "mcp__serena__replace_symbol_body", "mcp__serena__insert_after_symbol", "mcp__serena__insert_before_symbol", "mcp__serena__safe_delete_symbol", "mcp__serena__rename_symbol", "mcp__serena__write_memory", "mcp__serena__edit_memory", "mcp__serena__delete_memory"]`,
    `decision = "deny"`,
    `priority = 600`,
    `denyMessage = "Reviewer session: MCP write tools are disabled."`,
  ].join("\n");
}

// Default gemini-live launch args.
// --approval-mode auto_edit: auto-approves file-edit tools (write_file, replace) without dialogs.
// run_shell_command is NOT auto-approved in auto_edit mode — it would normally show ask_user
// dialogs. The admin-policy adds a hard DENY for run_shell_command (priority 5.600) so shell
// is blocked entirely (no dialog, no execution), giving a read-only shell boundary:
//   - write_file to .peer-review/ → admin ALLOW (5.500) wins → allowed
//   - write_file to other paths   → admin DENY (5.100) wins over auto_edit ALLOW (1.015) → denied
//   - run_shell_command            → admin DENY (5.600) wins over ask_user (1.010) → denied
// --allowed-mcp-server-names: blocks MCP servers (e.g. serena) from loading and causing MCP dialogs.
export const DEFAULT_REVIEWER_GEMINI_ARGS = [
  "--skip-trust",
  "--approval-mode", "auto_edit",
  "--allowed-mcp-server-names", "reviewer-session-no-mcp",
];

export class TmuxCliSession implements ReviewerSession {
  private ready = false;
  private currentModel: string | null = null;
  private sessionId: string | null;
  private untrackedExistingSession = false;
  constructor(private readonly config: TmuxSessionConfig) {
    this.sessionId = config.initialSessionId ?? null;
    this.currentModel = config.initialModel ?? null;
  }

  async deliver(prompt: string, jobId: string, signal: AbortSignal, model?: string | null): Promise<string> {
    const requestedModel = normalizedModel(model);
    this.devLog("deliver_start", { jobId, requestedModel, promptChars: prompt.length });
    await this.ensureSession(signal, requestedModel);
    this.devLog("deliver_ready", { jobId, requestedModel, usedModel: this.usedModelForLog(), currentModel: this.currentModel, sessionId: this.sessionId });
    const begin = beginMarkerFor(jobId);
    const done = doneMarkerFor(jobId);
    const { sessionName, promptDir, deliverTimeoutMs, pollIntervalMs } = this.config;

    // Hand the (large) review prompt to the session via a file — typing it through send-keys is
    // fragile. The instruction itself stays short to avoid input-line wrapping in the pane.
    // promptDir is granted via `--add-dir` at launch so the read-only session can Read it.
    await mkdir(promptDir, { recursive: true });
    const promptFile = join(promptDir, `${jobId}.md`);
    // outputFile is the file the reviewer writes via its Write tool (primary extraction path).
    // The session also prints the review to the terminal as a fallback: if the file write fails
    // (policy mismatch, tool refusal, unexpected model behavior), capture-pane extraction can
    // still succeed. Both channels carry the same BEGIN/DONE markers.
    const outputFile = join(promptDir, `${jobId}-output.md`);
    await writeFile(promptFile, wrapLiveReviewPrompt(prompt, begin, done, this.config.useOutputFile ? outputFile : undefined, this.config.outputFileWriteMethod), "utf8");
    // Security note: Write permission is scoped to promptDir (repo-specific subdir).
    // Each job's output file uses its UUID-based jobId, making it unpredictable to injections
    // targeting other jobs. The system prompt further constrains the reviewer to this file only.
    // IMPORTANT: each marker must appear only ONCE in this instruction text. The instruction
    // is echoed in the TUI pane; if a marker appears twice in the echo, extractReviewFromCapture
    // mistakes the echo for a completed review and extracts a garbage 20-char fragment.
    const writeInstruction = this.config.outputFileWriteMethod === "shell"
      // Codex TUI: no native write_file tool; use bash shell commands (-a never auto-approves them)
      ? `Write your complete review to ${outputFile} using a bash shell command (e.g. cat/tee). `
      // Gemini/Claude TUI: use the native write_file tool (auto-approved in auto_edit mode)
      : `Write your complete review to ${outputFile} using the native write_file tool. `;
    const instruction = this.config.useOutputFile
      ? `Read the file ${promptFile} and perform the code review it describes. ` +
        writeInstruction +
        `Also print exactly ${begin}, then the full review, then exactly ${done} to the terminal.`
      : `Read the file ${promptFile} and perform the code review it describes. ` +
        `Print exactly ${begin} on a line by itself, then the full review as plain text, ` +
        `then exactly ${done} on the final line.`;

    try {
      // Reset the reused session's CONVERSATION before each review (default): this single live
      // session serves every review, so without a reset its context grows unbounded and earlier
      // reviews bleed into later ones. Opt out (CODE_ASSISTANT_PEERS_REVIEWER_CLEAR=never) to
      // keep the session's memory across reviews — e.g. follow-up rounds that benefit from what
      // the reviewer already read. NOTE the session is per-REPO, not per-task, so without a
      // reset history from other tasks in the same repo accumulates too.
      if (this.config.clearBetweenReviews && this.config.clearCommand) {
        await tmux(["send-keys", "-t", sessionName, "-l", "--", this.config.clearCommand]);
        await sleep(150, signal);
        await tmux(["send-keys", "-t", sessionName, "Enter"]);
        await sleep(600, signal); // let the reset settle before we wipe scrollback
      }
      // Always drop prior tmux scrollback so the capture is bounded to this job. This wipes the
      // rendered pane history only — NOT the session's conversation memory — so it is safe (and
      // required for clean extraction) regardless of clearBetweenReviews.
      await tmux(["clear-history", "-t", sessionName]);
      await tmux(["send-keys", "-t", sessionName, "-l", "--", instruction]);
      await sleep(150, signal); // let the TUI register the paste before submitting
      await tmux(["send-keys", "-t", sessionName, "Enter"]);

      const deadline = Date.now() + deliverTimeoutMs;
      // Check-before-sleep with adaptive backoff: check immediately on each iteration, then sleep.
      // Starting at 50ms and doubling up to pollIntervalMs eliminates the worst-case idle time
      // when the reviewer has already written its output. The pattern mirrors reviewViaBroker:
      // always check first, then decide how long to wait before the next check.
      let adaptivePoll = 50;
      while (Date.now() < deadline) {
        // Bail out promptly on worker shutdown (SIGINT/SIGTERM) instead of polling until the
        // deliver timeout — the job is reported as an error and the worker loop can exit.
        if (signal.aborted) throw new Error("reviewer worker is shutting down");

        // Primary: poll output file (claude-live with system-prompt injection + Write permission).
        // File output avoids tmux rendering artifacts, pane-scroll truncation, and TUI chrome.
        if (this.config.useOutputFile) {
          const fileReview = await extractReviewFromFile(outputFile, jobId);
          if (fileReview !== null) {
            await this.refreshSessionId();
            this.devLog("review_extracted", { jobId, chars: fileReview.length, source: "file", requestedModel, usedModel: this.usedModelForLog(), currentModel: this.currentModel, sessionId: this.sessionId });
            return fileReview;
          }
        }

        // Fallback: capture-pane extraction (gemini-live/codex-live, or claude-live without
        // Write permission, or when the output file is not yet written).
        const capture = await this.capture();
        const review = extractReviewFromCapture(capture, jobId);
        if (review !== null) {
          await this.refreshSessionId();
          this.devLog("review_extracted", { jobId, chars: review.length, source: "capture", requestedModel, usedModel: this.usedModelForLog(), currentModel: this.currentModel, sessionId: this.sessionId });
          return review;
        }

        // Sleep after check (not before) — adaptive backoff: 50ms → 100ms → … → pollIntervalMs.
        await sleep(Math.min(adaptivePoll, Math.max(0, deadline - Date.now())), signal);
        adaptivePoll = Math.min(adaptivePoll * 2, pollIntervalMs);
      }
      this.devLog("deliver_timeout", { jobId, timeoutMs: deliverTimeoutMs, requestedModel, usedModel: this.usedModelForLog(), currentModel: this.currentModel, sessionId: this.sessionId });
      throw new Error(`timed out after ${deliverTimeoutMs}ms waiting for the review marker in the live session`);
    } finally {
      await rm(promptFile, { force: true }).catch(() => {});
      await rm(outputFile, { force: true }).catch(() => {});
    }
  }

  async close(): Promise<void> {
    await tmux(["kill-session", "-t", this.config.sessionName]).catch(() => {});
  }

  // Ensure a tmux session running the interactive reviewer TUI exists and is ready for input.
  // If the session already exists we reuse it (the user may have launched it themselves).
  private async ensureSession(signal: AbortSignal, requestedModel: string | null): Promise<void> {
    const { sessionName, cwd, launchCommand, promptDir, startupTimeoutMs } = this.config;

    const exists = (await tmux(["has-session", "-t", sessionName])).code === 0;
    const attachedUnknownExistingSession = isUnknownExistingSession(exists, this.ready, this.config.hasPersistedSessionId);
    this.untrackedExistingSession = liveSessionUntrackedState(this.untrackedExistingSession, attachedUnknownExistingSession);
    const mustRelaunchForModel = Boolean(exists && requestedModel && requestedModel !== this.currentModel);
    this.devLog("ensure_session", {
      sessionName,
      exists,
      ready: this.ready,
      requestedModel,
      currentModel: this.currentModel,
      sessionId: this.sessionId,
      untrackedExistingSession: this.untrackedExistingSession,
      mustRelaunchForModel,
    });
    if (this.ready && !mustRelaunchForModel) return;
    if (shouldRejectUnknownExistingSession(this.untrackedExistingSession, requestedModel)) {
      this.devLog("reject_unknown_existing_session", { sessionName, requestedModel });
      throw new Error(
        `live session '${sessionName}' already exists but has no persisted session id/model state; ` +
          `restart that tmux session so the worker can create a tracked session before model switching`,
      );
    }
    if (mustRelaunchForModel) {
      await this.refreshSessionId();
      const resumeCommand = this.sessionId && this.config.resumeCommandForModel?.(this.sessionId, requestedModel);
      if (!resumeCommand) {
        this.devLog("model_switch_missing_resume_id", { sessionName, requestedModel, sessionId: this.sessionId });
        throw new Error(`live session '${sessionName}' cannot switch to model '${requestedModel}' because no resumable session id is available`);
      }
      await tmux(["kill-session", "-t", sessionName]).catch(() => {});
      this.ready = false;
      this.devLog("model_switch_resume", { sessionName, requestedModel, sessionId: this.sessionId, command: scrubCommand(resumeCommand) });
      const resumed = await tmux([
        "new-session", "-d", "-s", sessionName, "-c", cwd, "-x", "400", "-y", "120",
        "--", ...resumeCommand,
      ]);
      if (resumed.code !== 0) {
        throw new Error(`failed to resume tmux session '${sessionName}' with model '${requestedModel}': ${resumed.stderr.trim() || `exit ${resumed.code}`}`);
      }
      this.currentModel = requestedModel;
      await this.persistState();
      await this.waitUntilReady(startupTimeoutMs, signal);
      this.ready = true;
      this.devLog("model_switch_ready", { sessionName, requestedModel, sessionId: this.sessionId });
      return;
    }

    if (!exists) {
      await mkdir(promptDir, { recursive: true });
      // Clean up orphaned output files from prior worker crashes before starting the session.
      if (this.config.useOutputFile) await sweepOrphanedOutputFiles(promptDir);
      // Write policy file (e.g. gemini --admin-policy) before launching the session.
      if (this.config.policyFile) {
        await writeFile(this.config.policyFile.path, this.config.policyFile.content, "utf8");
      }
      // Always launch with a FRESH session ID, not the persisted one. The persisted ID is used
      // only for model-switch resumes (resumeCommandForModel). Reusing the old session ID here
      // can cause Claude to reload large conversation histories from previous sessions, making
      // startup very slow or causing the process to crash before the pane becomes ready.
      const freshSessionId = this.config.freshSessionId?.() ?? null;
      const launchId = freshSessionId ?? this.sessionId;
      // Reset sessionId and currentModel so the new session is not treated as a continuation
      // of the old one. Without resetting:
      //   - refreshSessionId() bails early (this.sessionId non-null) → stale session ID kept
      //   - mustRelaunchForModel skips relaunching if requestedModel === old currentModel, even
      //     though the fresh session actually started on the CLI default model
      this.sessionId = freshSessionId; // null for codex (no --session-id), fresh UUID for claude/gemini
      this.currentModel = null; // unknown until the CLI confirms or a model arg is passed
      // Wide window => less line wrapping => cleaner capture. `--` ends tmux option parsing so
      // the rest is the command run inside the session. launchCommand must already include the
      // CLI's prompt-dir access grant (e.g. --add-dir / --include-directories).
      const created = await tmux([
        "new-session", "-d", "-s", sessionName, "-c", cwd, "-x", "400", "-y", "120",
        "--", ...(this.config.launchCommandForModel?.(requestedModel, launchId) ?? launchCommand),
      ]);
      if (created.code !== 0) {
        throw new Error(`failed to start tmux session '${sessionName}': ${created.stderr.trim() || `exit ${created.code}`}`);
      }
      this.untrackedExistingSession = liveSessionUntrackedState(this.untrackedExistingSession, false, true);
      this.devLog("session_created", { sessionName, requestedModel, sessionId: launchId });
      await this.waitUntilReady(startupTimeoutMs, signal);
    }
    if (requestedModel) this.currentModel = requestedModel;
    if (shouldPersistLiveSessionState(this.untrackedExistingSession)) await this.persistState();
    this.ready = true;
  }

  private async refreshSessionId(): Promise<void> {
    if (this.sessionId) return;
    this.sessionId = await this.config.discoverSessionId?.(this.config.cwd) ?? null;
    if (this.sessionId) {
      this.untrackedExistingSession = liveSessionUntrackedState(this.untrackedExistingSession, false, true);
      await this.persistState();
      this.devLog("session_id_discovered", { sessionId: this.sessionId });
    }
  }

  private async persistState(): Promise<void> {
    await saveLiveSessionState(this.config.stateKey, {
      sessionId: this.sessionId,
      currentModel: this.currentModel,
    }).catch(() => {});
    this.devLog("session_state_persisted", { stateKey: this.config.stateKey, sessionId: this.sessionId, currentModel: this.currentModel });
  }

  private devLog(event: string, data?: Record<string, unknown>): void {
    this.config.devLog?.(event, data);
  }

  private usedModelForLog(): string {
    return this.currentModel ?? "cli-default";
  }

  // The TUI takes a moment to boot. We don't know an exact "ready" string across versions, so we
  // wait until the captured pane is non-empty and stable across two consecutive reads.
  private async waitUntilReady(timeoutMs: number, signal: AbortSignal): Promise<void> {
    const { sessionName } = this.config;
    const deadline = Date.now() + timeoutMs;
    let previous = "";
    let stableReads = 0;
    while (Date.now() < deadline) {
      // Bail out promptly on shutdown.
      if (signal.aborted) return;
      await sleep(700, signal);
      // Detect early startup failure: if the tmux session no longer exists, the CLI crashed.
      const sessionExists = (await tmux(["has-session", "-t", sessionName])).code === 0;
      if (!sessionExists) {
        this.devLog("session_startup_crash", { sessionName, elapsed: timeoutMs - (deadline - Date.now()) });
        throw new Error(
          `session '${sessionName}' died during startup — the CLI likely crashed or exited immediately. ` +
            `Check that the reviewer CLI is installed, authenticated, and that the launch args are valid.`,
        );
      }
      const current = await this.capture();
      if (current.trim().length > 0 && current === previous) {
        if (++stableReads >= 2) return;
      } else {
        stableReads = 0;
      }
      previous = current;
    }
    // Pane was consistently empty but session is alive — possibly still booting.
    // Log a warning; deliver() will handle the timeout if it never becomes usable.
    this.devLog("session_startup_timeout", { sessionName, timeoutMs });
    console.error(
      `[reviewer] WARNING: session '${sessionName}' pane was empty/unstable for ${timeoutMs}ms; ` +
        `the CLI may have stalled on startup. Proceeding — the deliver timeout will catch it.`,
    );
  }

  private async capture(): Promise<string> {
    // -p prints to stdout, -S - includes the full scrollback (post clear-history it is just this
    // job), -J joins wrapped lines so a soft-wrapped marker still matches.
    const result = await tmux(["capture-pane", "-t", this.config.sessionName, "-p", "-J", "-S", "-"]);
    return result.stdout;
  }
}

async function tmux(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

// A fake session for local testing without claude/tmux: echoes a canned review.
export class EchoSession implements ReviewerSession {
  async deliver(prompt: string, jobId: string, _signal?: AbortSignal, model?: string | null): Promise<string> {
    const modelText = model?.trim() ? `; model ${model.trim()}` : "";
    return `No findings. (echo reviewer for job ${jobId}; prompt was ${prompt.length} chars${modelText})\npatch is correct`;
  }
}

function normalizedModel(model?: string | null): string | null {
  const trimmed = model?.trim();
  return trimmed ? trimmed : null;
}

export function isUnknownExistingSession(exists: boolean, ready: boolean, hasPersistedSessionId: boolean): boolean {
  return exists && !ready && !hasPersistedSessionId;
}

export function shouldRejectUnknownExistingSession(attachedUnknownExistingSession: boolean, requestedModel: string | null): boolean {
  return attachedUnknownExistingSession && Boolean(requestedModel);
}

export function shouldPersistLiveSessionState(attachedUnknownExistingSession: boolean): boolean {
  return !attachedUnknownExistingSession;
}

export function liveSessionUntrackedState(previouslyUntracked: boolean, attachedUnknownExistingSession: boolean, createdTrackedSession = false): boolean {
  if (createdTrackedSession) return false;
  return previouslyUntracked || attachedUnknownExistingSession;
}

export function devLoggingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.CODE_ASSISTANT_PEERS_DEV_LOG?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export function defaultDevLogPath(scope: string, cwd = process.cwd()): string {
  return join(cwd, ".code-assistant-peers-dev", `${scope}.jsonl`);
}

export function createDevLogger(scope: string, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): DevLogger {
  if (!devLoggingEnabled(env)) return () => {};
  const path = env.CODE_ASSISTANT_PEERS_DEV_LOG_PATH?.trim() || defaultDevLogPath(scope, cwd);
  try {
    mkdirSyncForLog(dirname(path));
  } catch {
    return () => {};
  }
  return (event, data = {}) => {
    try {
      appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), scope, event, ...data }) + "\n", "utf8");
    } catch {
      // Dev logging must never affect reviewer behavior.
    }
  };
}

function mkdirSyncForLog(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function scrubCommand(command: string[]): string[] {
  return command.map((part) => (looksSensitive(part) ? "<redacted>" : part));
}

function looksSensitive(value: string): boolean {
  return /(api[_-]?key|token|secret|password|bearer)/i.test(value);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function envInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const once = argv.includes("--once");
  const echo = argv.includes("--echo");

  const brokerUrl = process.env.CODE_ASSISTANT_PEERS_BROKER_URL ?? DEFAULT_BROKER_URL;

  // Singleton guard: at most one real worker per broker (echo/dev workers are exempt). Prevents
  // two workers from driving the same per-repo tmux session concurrently.
  let releaseLock: (() => void) | null = null;
  if (!echo) {
    releaseLock = acquireWorkerLock(brokerUrl);
    if (!releaseLock) {
      console.error(`[reviewer] another reviewer worker already owns ${brokerUrl}; exiting.`);
      return;
    }
    process.on("exit", () => releaseLock?.());
  }

  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  process.on("SIGTERM", () => controller.abort());

  if (process.env.ANTHROPIC_API_KEY && !echo) {
    console.error(
      "[reviewer] WARNING: ANTHROPIC_API_KEY is set — Claude Code will bill to the API key, NOT your subscription. " +
        "Unset it (and log in via claude.ai) for subscription billing.",
    );
  }

  const baseCwd = process.env.CODE_ASSISTANT_PEERS_REVIEWER_CWD ?? process.cwd();
  const sessionBaseName = process.env.CODE_ASSISTANT_PEERS_TMUX_SESSION ?? "peer-reviewer";
  const devLog = createDevLogger("reviewer", process.env, baseCwd);
  devLog("worker_start", { brokerUrl, baseCwd, once, echo, sessionBaseName });

  // One session per (reviewer kind, repo cwd): a job's reviewer picks the CLI, its cwd pins the
  // session to that repo, and the worker caches/reuses the pair.
  const sessionFor = (reviewer: string, cwd: string): ReviewerSession => {
    if (echo) return new EchoSession();
    const kind = liveCliKindFor(reviewer);
    if (!kind) {
      throw new Error(`reviewer '${reviewer}' has no live CLI mapping (known: ${Object.keys(LIVE_CLI_KINDS).join(", ")})`);
    }
    const repoCwd = cwd || baseCwd;
    const kindPromptDir = process.env.CODE_ASSISTANT_PEERS_REVIEWER_PROMPT_DIR ?? kind.promptDir(repoCwd);
    const stateKey = liveSessionStateKey(reviewer, repoCwd);
    const persistedState = loadLiveSessionState(stateKey);
    const initialSessionId = persistedState?.sessionId ?? kind.initialSessionId?.() ?? null;
    return new TmuxCliSession({
      sessionName: sessionNameFor(sessionBaseName, kind.slug, repoCwd),
      cwd: repoCwd,
      launchCommand: kind.launchCommand(repoCwd, kindPromptDir),
      launchCommandForModel: (model, sessionId) => kind.launchCommand(repoCwd, kindPromptDir, model, sessionId),
      resumeCommandForModel: kind.resumeCommand ? (sessionId, model) => kind.resumeCommand!(repoCwd, kindPromptDir, sessionId, model) : undefined,
      initialSessionId,
      initialModel: persistedState?.currentModel ?? null,
      hasPersistedSessionId: Boolean(persistedState?.sessionId),
      stateKey,
      discoverSessionId: kind.discoverSessionId,
      promptDir: kindPromptDir,
      clearCommand: kind.clearCommand,
      // Default: keep conversation history across reviews so the reviewer accumulates context
      // about the repo and can give richer, more consistent feedback over time.
      // Set CODE_ASSISTANT_PEERS_REVIEWER_CLEAR=always to reset before each review instead.
      clearBetweenReviews: process.env.CODE_ASSISTANT_PEERS_REVIEWER_CLEAR === "always",
      startupTimeoutMs: envInt("CODE_ASSISTANT_PEERS_REVIEWER_STARTUP_MS", 30_000),
      deliverTimeoutMs: envInt("CODE_ASSISTANT_PEERS_REVIEW_TIMEOUT_MS", DEFAULT_DELIVER_TIMEOUT_MS),
      pollIntervalMs: envInt("CODE_ASSISTANT_PEERS_REVIEWER_POLL_MS", DEFAULT_POLL_INTERVAL_MS),
      // Enable file output when the kind declares useOutputFile AND the user has not overridden
      // the launch args via the kind-specific env var (custom args may omit the write permission
      // or sandbox relaxation that file output requires).
      useOutputFile: (kind.useOutputFile ?? false) &&
        !process.env[`CODE_ASSISTANT_PEERS_REVIEWER_${kind.slug.toUpperCase()}_ARGS`],
      // Pre-compute the policy file for gemini-live (written before session launch).
      // Skip when args are overridden — custom args may not include --admin-policy.
      policyFile: kind.policyContent && !process.env[`CODE_ASSISTANT_PEERS_REVIEWER_${kind.slug.toUpperCase()}_ARGS`]
        ? { path: join(kindPromptDir, "reviewer-policy.toml"), content: kind.policyContent(kindPromptDir) }
        : undefined,
      // For CLIs that support --session-id (claude, gemini), always start new sessions with a
      // fresh UUID. Reusing the persisted session ID (intended for model-switch resumes) causes
      // the CLI to reload old conversation history, making startup slow or causing crashes.
      freshSessionId: kind.initialSessionId,
      // codex TUI has no native write_file tool; gemini/claude use write_file (auto-approved).
      outputFileWriteMethod: kind.slug === "codex" ? "shell" : "write_file_tool",
      devLog: (event, data) => devLog(event, { reviewer, cwd: repoCwd, ...data }),
    });
  };

  console.error(`[reviewer] worker started (broker=${brokerUrl}, session=${echo ? "echo" : "tmux per reviewer kind + repo"}${once ? ", once" : ""})`);
  await runReviewerWorker({
    brokerUrl,
    sessionFor,
    signal: controller.signal,
    once,
    log: (message) => {
      console.error(`[reviewer] ${message}`);
      devLog("worker_log", { message });
    },
  });
  devLog("worker_stop", { brokerUrl });
  releaseLock?.();
}

// ---------------------------------------------------------------------------
// Live CLI kinds — which interactive TUI a channel reviewer id maps to, how to launch it
// read-only with access to the prompt dir, and how to reset its conversation between reviews.
// Generic: any `<cli>-live` adapter routes here; unknown ids surface as a job error so the host
// falls back to spawning that adapter's headless CLI.
// ---------------------------------------------------------------------------

export interface LiveCliKind {
  slug: string; // session-name segment, e.g. peer-reviewer-<slug>-<repo>-<hash>
  // Parent dir for the per-job prompt file. The session must be able to Read AND Write it.
  // claude/codex: repo-specific subdir of SHARED_PROMPT_DIR (--add-dir grants claude access);
  // gemini: join(cwd, ".peer-review") inside the trusted repo cwd (no extra trust prompt).
  promptDir: (cwd: string) => string;
  launchCommand: (cwd: string, promptDir: string, model?: string | null, sessionId?: string | null) => string[];
  resumeCommand?: (cwd: string, promptDir: string, sessionId: string, model?: string | null) => string[];
  initialSessionId?: () => string;
  discoverSessionId?: (cwd: string) => Promise<string | null>;
  clearCommand: string | null;
  // When true the session is launched in interactive mode with file-write access to promptDir,
  // and deliver() polls promptDir for the per-job output file as the primary extraction path.
  // Requires the launchCommand to grant write access (--admin-policy for gemini,
  // --sandbox workspace-write for codex, Write(promptDir:*) in --allowedTools for claude).
  useOutputFile?: boolean;
  // Optional function to generate a policy file written to promptDir before session launch.
  // Used by gemini-live to create a per-session --admin-policy that restricts write_file/replace
  // to promptDir only (hard boundary via policy engine allow/deny rules).
  policyContent?: (promptDir: string) => string;
}

const SHARED_PROMPT_DIR = join(tmpdir(), "peer-reviewer-prompts");
const LIVE_SESSION_STATE_PATH = join(homedir(), ".code-assistant-peers", "live-sessions.json");

interface LiveSessionState {
  sessionId: string | null;
  currentModel: string | null;
}

function liveSessionStateKey(reviewer: string, cwd: string): string {
  return `${reviewer}|${cwd}`;
}

function loadLiveSessionState(key: string): LiveSessionState | null {
  try {
    const parsed = JSON.parse(readFileSync(LIVE_SESSION_STATE_PATH, "utf8")) as Record<string, LiveSessionState>;
    const state = parsed[key];
    if (!state || typeof state !== "object") return null;
    return {
      sessionId: typeof state.sessionId === "string" && state.sessionId.trim() ? state.sessionId : null,
      currentModel: typeof state.currentModel === "string" && state.currentModel.trim() ? state.currentModel : null,
    };
  } catch {
    return null;
  }
}

async function saveLiveSessionState(key: string, state: LiveSessionState): Promise<void> {
  let parsed: Record<string, LiveSessionState> = {};
  try {
    parsed = JSON.parse(await readFile(LIVE_SESSION_STATE_PATH, "utf8")) as Record<string, LiveSessionState>;
  } catch {
    parsed = {};
  }
  parsed[key] = state;
  await mkdir(dirname(LIVE_SESSION_STATE_PATH), { recursive: true });
  await writeFile(LIVE_SESSION_STATE_PATH, JSON.stringify(parsed, null, 2), "utf8");
}

export const LIVE_CLI_KINDS: Record<string, LiveCliKind> = {
  "claude-live": {
    slug: "claude",
    // Use a repo-specific subdir of SHARED_PROMPT_DIR so the Write(promptDir:*) permission
    // granted to the reviewer session is scoped to that repo's files only. Without this, a
    // prompt-injection in a reviewed diff could instruct the reviewer to overwrite prompt/output
    // files belonging to other repos sharing the global SHARED_PROMPT_DIR.
    promptDir: (cwd) => join(SHARED_PROMPT_DIR, shortHash(cwd)),
    // When the user has not overridden CODE_ASSISTANT_PEERS_REVIEWER_CLAUDE_ARGS, use
    // buildDefaultReviewerClaudeArgs to inject the system prompt and scoped Write permission.
    // The custom args path keeps the legacy behavior (no system-prompt, Write disallowed) so
    // existing manual overrides are not silently broken.
    launchCommand: (_cwd, promptDir, model, sessionId) => [
      "claude",
      ...(sessionId ? ["--session-id", sessionId] : []),
      ...(model ? ["--model", model] : []),
      ...(parseArgsEnv(process.env.CODE_ASSISTANT_PEERS_REVIEWER_CLAUDE_ARGS) ??
        buildDefaultReviewerClaudeArgs(promptDir, resolveReviewerWorkflow())),
      "--add-dir",
      promptDir,
    ],
    resumeCommand: (_cwd, promptDir, sessionId, model) => [
      "claude",
      "--resume",
      sessionId,
      ...(model ? ["--model", model] : []),
      ...(parseArgsEnv(process.env.CODE_ASSISTANT_PEERS_REVIEWER_CLAUDE_ARGS) ??
        buildDefaultReviewerClaudeArgs(promptDir, resolveReviewerWorkflow())),
      "--add-dir",
      promptDir,
    ],
    initialSessionId: randomUUID,
    clearCommand: "/clear",
    useOutputFile: true,
  },
  "gemini-live": {
    slug: "gemini",
    // Inside the repo cwd (already trusted via --skip-trust) so gemini can Read it without the
    // separate `--include-directories` trust prompt that stalls a detached session.
    // policyContent writes a per-session --admin-policy that restricts write_file/replace to
    // .peer-review/ only (ALLOW priority 500 for promptDir, DENY priority 100 for everything
    // else). This is the hard write boundary equivalent to claude's --disallowedTools.
    // (Codex uses --sandbox workspace-write + advisory instructions; no codex equivalent exists.)
    promptDir: (cwd) => join(cwd, ".peer-review"),
    policyContent: (promptDir) => buildGeminiReviewerPolicy(promptDir),
    launchCommand: (_cwd, promptDir, model, sessionId) => {
      const customArgs = parseArgsEnv(process.env.CODE_ASSISTANT_PEERS_REVIEWER_GEMINI_ARGS);
      return [
        "gemini",
        ...(sessionId ? ["--session-id", sessionId] : []),
        ...(model ? ["--model", model] : []),
        ...(customArgs ?? [
          ...DEFAULT_REVIEWER_GEMINI_ARGS,
          "--admin-policy", join(promptDir, "reviewer-policy.toml"),
        ]),
      ];
    },
    resumeCommand: (_cwd, promptDir, sessionId, model) => {
      const customArgs = parseArgsEnv(process.env.CODE_ASSISTANT_PEERS_REVIEWER_GEMINI_ARGS);
      return [
        "gemini",
        "--resume",
        sessionId,
        ...(model ? ["--model", model] : []),
        ...(customArgs ?? [
          ...DEFAULT_REVIEWER_GEMINI_ARGS,
          "--admin-policy", join(promptDir, "reviewer-policy.toml"),
        ]),
      ];
    },
    initialSessionId: randomUUID,
    clearCommand: "/clear",
    useOutputFile: true,
  },
  "codex-live": {
    slug: "codex",
    // Use .peer-review/ inside the repo cwd so codex can write the output file there.
    // --sandbox workspace-write is required: --sandbox read-only ignores --add-dir ("effective
    // permissions do not allow additional writable roots"), so there is no way to restrict writes
    // to .peer-review/ only at the sandbox level. The behavioral constraint in the injected
    // -c instructions is advisory. Users needing a hard read-only guarantee can set
    // CODE_ASSISTANT_PEERS_REVIEWER_CODEX_ARGS="--sandbox read-only" (disables file output).
    promptDir: (cwd) => join(cwd, ".peer-review"),
    launchCommand: (cwd, promptDir, model) => {
      const customArgs = parseArgsEnv(process.env.CODE_ASSISTANT_PEERS_REVIEWER_CODEX_ARGS);
      if (customArgs) return ["codex", ...(model ? ["-m", model] : []), ...customArgs];
      setupReviewerCodexHome(cwd);
      return [
        "env", `CODEX_HOME=${REVIEWER_CODEX_HOME}`,
        "codex",
        ...(model ? ["-m", model] : []),
        ...buildDefaultReviewerCodexArgs(promptDir, resolveReviewerWorkflow()),
      ];
    },
    resumeCommand: (cwd, promptDir, sessionId, model) => {
      const customArgs = parseArgsEnv(process.env.CODE_ASSISTANT_PEERS_REVIEWER_CODEX_ARGS);
      if (customArgs) return ["codex", "resume", sessionId, ...(model ? ["-m", model] : []), ...customArgs];
      setupReviewerCodexHome(cwd);
      return [
        "env", `CODEX_HOME=${REVIEWER_CODEX_HOME}`,
        "codex", "resume", sessionId,
        ...(model ? ["-m", model] : []),
        ...buildDefaultReviewerCodexArgs(promptDir, resolveReviewerWorkflow()),
      ];
    },
    discoverSessionId: latestCodexSessionIdForCwd,
    clearCommand: "/new",
    useOutputFile: true,
  },
};

export async function latestCodexSessionIdForCwd(cwd: string): Promise<string | null> {
  // When CODE_ASSISTANT_PEERS_REVIEWER_CODEX_ARGS is set, the session is NOT under
  // REVIEWER_CODEX_HOME (that override is bypassed in launchCommand). Only scan
  // REVIEWER_CODEX_HOME when we actually launched with it to avoid picking up stale sessions.
  const useReviewerHome = !process.env.CODE_ASSISTANT_PEERS_REVIEWER_CODEX_ARGS;
  // When using REVIEWER_CODEX_HOME, only scan that directory — never fall back to ~/.codex.
  // The ~/.codex fallback can pick up unrelated personal sessions for the same repo and cause
  // model switches to resume the wrong conversation history.
  const roots = useReviewerHome
    ? [join(REVIEWER_CODEX_HOME, "sessions")]
    : [join(homedir(), ".codex", "sessions")];
  const files = (
    await Promise.all(roots.map((r) => recentFiles(r, 100).catch(() => [] as string[])))
  ).flat();
  for (const file of files) {
    const firstLine = (await readFile(file, "utf8").catch(() => "")).split("\n", 1)[0];
    if (!firstLine) continue;
    try {
      const parsed = JSON.parse(firstLine) as { type?: string; payload?: { id?: string; cwd?: string; originator?: string } };
      if (parsed.type === "session_meta" && parsed.payload?.cwd === cwd && parsed.payload.originator === "codex-tui" && parsed.payload.id) {
        return parsed.payload.id;
      }
    } catch {
      // Ignore unrelated/corrupt session files.
    }
  }
  return null;
}

async function recentFiles(dir: string, limit: number): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: { path: string; mtimeMs: number }[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const child of await recentFiles(path, limit)) {
        const info = await stat(child);
        files.push({ path: child, mtimeMs: info.mtimeMs });
      }
    } else if (entry.isFile()) {
      const info = await stat(path);
      files.push({ path, mtimeMs: info.mtimeMs });
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit).map((file) => file.path);
}

export function liveCliKindFor(reviewer: string): LiveCliKind | null {
  return LIVE_CLI_KINDS[reviewer] ?? null;
}

// Stable, tmux-safe session name per CLI kind + repo cwd: "<base>-<kind>-<repo-slug>-<hash>".
// The hash disambiguates same-named repos in different paths; the slug keeps it human-readable
// in `tmux ls`.
export function sessionNameFor(base: string, kind: string, cwd: string): string {
  const slug = (cwd.split("/").filter(Boolean).pop() ?? "repo").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || "repo";
  return `${base}-${kind}-${slug}-${shortHash(cwd)}`;
}

function shortHash(value: string): string {
  let h = 5381;
  for (let i = 0; i < value.length; i++) h = ((h << 5) + h + value.charCodeAt(i)) >>> 0; // djb2
  return h.toString(36);
}

// Ensure only ONE reviewer worker runs per broker. Without this, an autostart race (two MCP
// servers both seeing "no broker" at once) could leave two workers polling the same broker and
// driving the same per-repo tmux session concurrently — interleaved send-keys/capture corrupts
// both. The lock is keyed by broker URL so distinct brokers get independent workers. Returns a
// release fn, or null if another LIVE worker already holds the lock (caller should exit).
export function acquireWorkerLock(brokerUrl: string): (() => void) | null {
  const lockPath = join(tmpdir(), `code-assistant-peers-reviewer-${shortHash(brokerUrl)}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx"); // exclusive create — fails if the lock already exists
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          unlinkSync(lockPath);
        } catch {
          // already gone
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      if (lockHolderAlive(lockPath)) return null; // a live worker owns it
      try {
        unlinkSync(lockPath); // stale lock (holder died) — drop it and retry once
      } catch {
        // raced with another reclaimer; loop will retry
      }
    }
  }
  return null;
}

function lockHolderAlive(lockPath: string): boolean {
  try {
    const pid = Number(readFileSync(lockPath, "utf8").trim());
    if (!Number.isFinite(pid) || pid <= 0) return false;
    process.kill(pid, 0); // throws if the process does not exist
    return true;
  } catch {
    return false;
  }
}

function parseArgsEnv(value: string | undefined): string[] | undefined {
  if (!value?.trim()) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) return parsed as string[];
  } catch {
    // not JSON — fall through to whitespace split
  }
  return value.trim().split(/\s+/);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`[reviewer] fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
