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
import { spawnWithTimeout } from "../shared/process.ts";

const DEFAULT_BROKER_URL = "http://127.0.0.1:7899";
const DEFAULT_POLL_INTERVAL_MS = 250; // reduced from 1000ms — all polling layers share this
const DEFAULT_DELIVER_TIMEOUT_MS = 600_000;
// A review's wall-clock cost scales with how much there is to review, so a single fixed deadline is
// either too short for a big diff or too long to detect a wedged reviewer. We bound a review by TWO
// clocks: an IDLE clock (below) that fires when the reviewer's pane stops changing — i.e. it
// crashed, exited to a shell prompt, or hung mid-task — and the existing deliverTimeoutMs HARD CAP
// that fires even while output is still streaming (catches an infinite-but-animated loop). Active
// reviewers (claude/codex/gemini TUIs) repaint a spinner/elapsed-timer sub-second, so a pane that is
// static for the idle window is genuinely stuck. This lets a large review run for as long as it
// keeps producing output (raise the hard cap via CODE_ASSISTANT_PEERS_REVIEW_TIMEOUT_MS) while a
// dead reviewer is reclaimed in minutes instead of holding its slot for the full hard cap.
const DEFAULT_REVIEW_IDLE_TIMEOUT_MS = 180_000;
// Fast "the reviewer finished but produced no review" detection. A working coding-agent TUI repaints
// its pane sub-second (a live elapsed-time counter / spinner), so a pane that FREEZES has returned to
// an idle prompt — the turn ended. If that happens with no review markers and no output file, the
// reviewer answered without delivering the artifact, and we can fail in seconds instead of waiting
// out the full idle timeout. Liveness is sampled from a bounded TAIL of the pane (the last
// TICK_TAIL_LINES lines, where the spinner/timer and newest output live) every TICK_SAMPLE_INTERVAL_MS
// — comparing a few dozen lines instead of the whole scrollback keeps the comparison cheap and avoids
// holding a huge capture in memory, while being far more robust than comparing only the last line. We
// only trust the freeze signal once we have OBSERVED this reviewer tick (>= TICK_CONFIRM_COUNT
// consecutive changed samples); a CLI that renders a static pane while thinking never gets the fast
// path and falls back to DEFAULT_REVIEW_IDLE_TIMEOUT_MS.
const QUIET_AFTER_TICKING_MS = 6_000;
const TICK_SAMPLE_INTERVAL_MS = 2_000;
const TICK_TAIL_LINES = 30;
const TICK_CONFIRM_COUNT = 3;
// tmux commands (has-session/send-keys/capture-pane/...) are local and normally return in
// milliseconds. The deliver loop only re-checks its deadline *between* polls, so a single tmux
// call that never returns (a wedged tmux server, a stuck pane) would block the loop forever and
// bypass deliverTimeoutMs entirely. Bound every tmux call so a wedged server degrades to a normal
// deliver timeout instead of an unbounded hang. Override with CODE_ASSISTANT_PEERS_TMUX_TIMEOUT_MS.
const TMUX_TIMEOUT_MS = envInt("CODE_ASSISTANT_PEERS_TMUX_TIMEOUT_MS", 20_000);
// How long a reviewer (kind × repo) is skipped after it reports a usage/rate limit, when the
// limit message gives no explicit reset time. Override with CODE_ASSISTANT_PEERS_RATE_LIMIT_COOLDOWN_MS.
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 15 * 60_000;

// Thrown when a reviewer's pane shows it has hit a usage/rate limit, so the worker can stop
// waiting for a marker that will never come and cool the reviewer down instead of retrying.
export class RateLimitError extends Error {
  constructor(message: string, readonly resetAtMs: number | null) {
    super(message);
    this.name = "RateLimitError";
  }
}

// Best-effort detection of a usage/rate-limit notice in a captured pane. Patterns are broad and
// CLI-agnostic (claude "usage limit"/"plan limit", codex "rate limit", gemini "quota exceeded"/
// "resource exhausted"/429); a miss simply degrades to the normal deliver timeout, so a false
// negative is safe. Extra patterns via CODE_ASSISTANT_PEERS_RATE_LIMIT_PATTERNS (comma-separated,
// case-insensitive substrings). Returns the matched line (for the error message) or null.
const RATE_LIMIT_PATTERNS = [
  /\busage limit(?:s)? (?:reached|exceeded)\b/i,
  /\b(?:rate|usage) limit(?:ed)?\b.*\b(?:reached|exceeded|hit)\b/i,
  /\bplan limit(?:s)? (?:reached|exceeded)\b/i,
  // A usage gauge that pairs "limit" with a "resets …" clause on one line is a quota notice, not
  // review prose (which rarely says both) — covers codex's "5h limit … resets 19:08" style.
  /\blimit\b[^\n]*\bresets?\b/i,
  /\bquota exceeded\b/i,
  /\bresource exhausted\b/i,
  /\b(?:reached|hit) your .*\blimit\b/i,
  /\byou(?:'ve| have) (?:reached|hit|exceeded)\b.*\blimit\b/i,
  /\bout of (?:usage )?credits\b/i,
  /\b429\b.*\b(?:limit|quota|exhaust)/i,
  /\btoo many requests\b/i,
];

export function detectRateLimit(capture: string, extraPatterns: string[] = []): string | null {
  const lines = capture.split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    if (RATE_LIMIT_PATTERNS.some((re) => re.test(line))) return line.trim();
    const lower = line.toLowerCase();
    if (extraPatterns.some((p) => p && lower.includes(p.toLowerCase()))) return line.trim();
  }
  return null;
}

// Parse an explicit reset time from a limit notice ("resets 19:08", "resets at 21:05",
// "resets 16:05 on 19 Jun"). Returns epoch ms for the next occurrence of that HH:MM, or null.
export function parseResetAtMs(text: string, nowMs: number): number | null {
  const match = /\bresets?\b[^0-9]{0,8}(\d{1,2}):(\d{2})/i.exec(text);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  const now = new Date(nowMs);
  const reset = new Date(nowMs);
  reset.setHours(h, m, 0, 0);
  if (reset.getTime() <= now.getTime()) reset.setTime(reset.getTime() + 24 * 60 * 60_000); // next day
  return reset.getTime();
}

export interface ReviewJob {
  id: string;
  reviewer: string;
  prompt: string;
  cwd: string; // repo dir this review is for ("" => worker default); routes to a per-repo session
  // Model the review should run on (null = session default). When it differs from the session's
  // current model, the session is switched (restart + resume, conversation preserved).
  model: string | null;
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
  // Cooldown after a reviewer reports a usage/rate limit with no explicit reset time.
  rateLimitCooldownMs?: number;
  // Deliver timeout passed to session.deliver(); also used to set the periodic reclaim interval.
  deliverTimeoutMs?: number;
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
  const body = (await res.json().catch(() => ({}))) as { id?: string | null; reviewer?: string; prompt?: string; cwd?: string; model?: string | null };
  if (!body.id || !body.prompt) return null;
  return { id: body.id, reviewer: String(body.reviewer ?? "claude-live"), prompt: body.prompt, cwd: String(body.cwd ?? ""), model: body.model ? String(body.model) : null };
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

  // Reviewers (kind × repo) that hit a usage/rate limit are cooled down until this epoch-ms, so
  // we stop booting/poking a reviewer that can't answer instead of retrying every job.
  const cooldownMs = options.rateLimitCooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS;
  const blockedUntil = new Map<string, number>();
  const now = () => Date.now();

  // Reclaim jobs left in "claimed" by a crashed/replaced prior worker so they become visible
  // to GET /next again. Best-effort — ignore if broker is unreachable.
  await reclaimStaleClaims(brokerUrl);

  // Periodic reclaim: if the broker was restarted while the worker was running, the worker's
  // in-flight jobs were wiped from broker memory (claimed→gone). A periodic reclaim is a no-op
  // in steady state but recovers quickly when the broker restarts.
  // Interval = deliver timeout + 30s buffer so we don't reclaim jobs that are still active.
  const deliverTimeoutMs = options.deliverTimeoutMs ?? DEFAULT_DELIVER_TIMEOUT_MS;
  const reclaimIntervalMs = deliverTimeoutMs + 30_000;
  const reclaimTimer = setInterval(() => reclaimStaleClaims(brokerUrl).catch(() => {}), reclaimIntervalMs);
  reclaimTimer.unref?.();

  // Per-(reviewer, cwd) promise chain: jobs for the SAME session run sequentially
  // (they share one tmux TUI), while jobs for DIFFERENT sessions run concurrently.
  // Each new job is appended to the tail of its session's chain and starts as soon
  // as the prior job for that session finishes — without blocking other sessions.
  const chainByKey = new Map<string, Promise<void>>();
  // runningCount: number of jobs CURRENTLY EXECUTING — jobs at the head of their chain.
  // Same-key queued jobs (waiting behind the head) are NOT counted; they queue internally
  // without consuming a running slot or blocking other pairs from being claimed.
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
        // Rate-limit cooldown check: if this reviewer+cwd is blocked, fail fast instead of
        // starting a session that will immediately reject jobs anyway.
        const blocked = blockedUntil.get(key);
        if (blocked && now() < blocked) {
          const mins = Math.ceil((blocked - now()) / 60_000);
          const msg = `reviewer ${job.reviewer} is rate-limited (cooling down ~${mins} min); skipped without retry — use another peer or wait`;
          await postError(brokerUrl, job.id, msg).catch(() => {});
          log(`job ${job.id} skipped: ${msg}`);
          return;
        }
        const review = await resolveSession(job.reviewer, job.cwd).deliver(job.prompt, job.id, signal, job.model);
        await postResult(brokerUrl, job.id, review);
        log(`job ${job.id} reviewed (${review.length} chars)`);
      } catch (error) {
        if (error instanceof RateLimitError) {
          const until = error.resetAtMs && error.resetAtMs > now() ? error.resetAtMs : now() + cooldownMs;
          blockedUntil.set(key, until);
          log(`job ${job.id} failed (rate limit); cooling down ${job.reviewer} until ${new Date(until).toISOString()}`);
          await postError(brokerUrl, job.id, error.message).catch(() => {});
          return;
        }
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
// ---------------------------------------------------------------------------

// Plain hyphenated tokens only — NO angle brackets, backticks, or markdown-special chars.
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
    const writeRule = writeMethod === "shell"
      ? "- Use a bash shell command (e.g. cat/tee/printf) to write the file. Do NOT use MCP tools."
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
  if (lastBegin === firstBegin || lastDone === firstDone) return null;
  if (lastDone <= lastBegin) return null;

  const between = capture.slice(lastBegin + begin.length, lastDone);
  return stripRenderedLineNumbers(cleanCapturedReview(between));
}

// The last `lines` lines of a pane capture (after trimming trailing blank lines so a flickering
// trailing newline never counts as a change). This is the "live" region — the spinner/elapsed-timer
// and the newest output — used to tell "still working" from "frozen" without storing or comparing
// the entire scrollback.
export function paneTail(capture: string, lines: number): string {
  const trimmed = capture.replace(/\s+$/, "");
  const all = trimmed.split("\n");
  return all.slice(Math.max(0, all.length - lines)).join("\n");
}

// The Gemini TUI renders responses with leading line numbers. Strip them only under a conservative
// signature so genuine content is never mangled.
export function stripRenderedLineNumbers(text: string): string {
  const lines = text.split("\n");
  const numbered = lines
    .map((line) => /^\s*(\d+)(\s|$)/.exec(line))
    .map((match, index) => ({ match, index, blank: lines[index].trim() === "" }));
  const nonBlank = numbered.filter((entry) => !entry.blank);
  if (nonBlank.length < 2 || nonBlank.some((entry) => !entry.match)) return text;
  for (let i = 1; i < nonBlank.length; i++) {
    if (Number(nonBlank[i].match![1]) <= Number(nonBlank[i - 1].match![1])) return text;
  }
  return lines
    .map((line) => line.replace(/^\s*\d+(\s|$)/, ""))
    .join("\n")
    .trim();
}

// Strip TUI chrome from scraped pane text.
function cleanCapturedReview(text: string): string {
  const lines = text
    .split("\n")
    .map((line) =>
      line
        .replace(/[│┃|]\s?/g, "")
        .replace(/[─━╭╮╰╯┌┐└┘]/g, "")
        .replace(/^\s*[⏺●○•]\s?/, "")
        .replace(/\s+$/g, ""),
    )
    .filter((line) => !/\(ctrl\+o to expand\)/.test(line) && !/^\s*Read \d+ file\b/.test(line));
  while (lines.length && lines[0].trim() === "") lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.join("\n").trim();
}

// Reads the output file written by Claude's Write tool.
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
  return body.replace(/^\n+/, "").replace(/\n+$/, "").trim();
}

// Deletes output files older than maxAgeMs from promptDir.
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
// tmux-driven interactive CLI session
// ---------------------------------------------------------------------------

export interface TmuxSessionConfig {
  sessionName: string;
  cwd: string;
  launchCommand: string[];
  launchCommandForModel?: (model: string | null, sessionId: string | null) => string[];
  resumeCommandForModel?: (sessionId: string, model: string | null) => string[];
  initialSessionId?: string | null;
  initialModel?: string | null;
  hasPersistedSessionId: boolean;
  stateKey: string;
  discoverSessionId?: (cwd: string) => Promise<string | null>;
  promptDir: string;
  clearCommand: string | null;
  clearBetweenReviews: boolean;
  startupTimeoutMs: number;
  deliverTimeoutMs: number;
  // Abort if the reviewer pane stops changing for this long (no streaming output) — catches a
  // crashed/hung reviewer well before the deliverTimeoutMs hard cap. 0 disables the idle clock.
  idleTimeoutMs: number;
  pollIntervalMs: number;
  useOutputFile: boolean;
  policyFile?: { path: string; content: string };
  freshSessionId?: () => string;
  outputFileWriteMethod: "write_file_tool" | "shell";
  // Extra case-insensitive substrings that mark a usage/rate-limit notice in the pane.
  rateLimitPatterns?: string[];
  devLog?: DevLogger;
}

type DevLogger = (event: string, data?: Record<string, unknown>) => void;

export const DEFAULT_REVIEWER_CLAUDE_ARGS = [
  "--permission-mode",
  "plan",
  "--allowedTools",
  "Read,Grep,Glob,Bash(git status:*),Bash(git diff:*),Bash(git show:*),Bash(git log:*),Bash(git ls-files:*)",
  "--disallowedTools",
  "Edit,Write,MultiEdit,NotebookEdit",
];

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

export function resolveReviewerWorkflow(env: NodeJS.ProcessEnv = process.env): "review_only" | "peer_fix" {
  const val = env.CODE_ASSISTANT_PEERS_REVIEWER_WORKFLOW ?? env.CODE_ASSISTANT_PEERS_WORKFLOW;
  return val === "peer_fix" ? "peer_fix" : "review_only";
}

export const REVIEWER_CODEX_HOME = join(tmpdir(), "peer-reviewer-codex-home");

function setupReviewerCodexHome(workspaceCwd: string): void {
  mkdirSync(REVIEWER_CODEX_HOME, { recursive: true });

  for (const name of ["auth.json", "installation_id"] as const) {
    const dst = join(REVIEWER_CODEX_HOME, name);
    try {
      if (!require("node:fs").existsSync(dst)) {
        require("node:fs").copyFileSync(join(homedir(), ".codex", name), dst);
      }
    } catch { /* source may not exist */ }
  }

  const userConfigPath = join(homedir(), ".codex", "config.toml");
  let userConfig = "";
  try { userConfig = readFileSync(userConfigPath, "utf8"); } catch { /* ok */ }

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

  const configPath = join(REVIEWER_CODEX_HOME, "config.toml");
  let existing = "";
  try { existing = readFileSync(configPath, "utf8"); } catch { /* first run */ }

  const configLines = [
    "# reviewer session: no MCP servers, workspace trusted",
    'model = "gpt-5.5"',
    'model_reasoning_effort = "medium"',
    'service_tier = "fast"',
    "",
  ];

  const projectMatches = [...existing.matchAll(/\[projects\."([^"]+)"\][^\[]+/g)];
  const trustedCwds = new Set<string>(projectMatches.map((m) => m[1]));
  trustedCwds.add(workspaceCwd);
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

export function buildGeminiReviewerPolicy(promptDir: string): string {
  const regexEscaped = promptDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tomlEscaped = regexEscaped.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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
    "# Deny shell execution.",
    "[[rule]]",
    `toolName = "run_shell_command"`,
    `decision = "deny"`,
    `priority = 600`,
    `denyMessage = "Reviewer session: shell execution is disabled for security."`,
    "",
    "# Deny serena MCP write/modify tools.",
    "[[rule]]",
    `toolName = ["mcp__serena__create_text_file", "mcp__serena__replace_content", "mcp__serena__replace_symbol_body", "mcp__serena__insert_after_symbol", "mcp__serena__insert_before_symbol", "mcp__serena__safe_delete_symbol", "mcp__serena__rename_symbol", "mcp__serena__write_memory", "mcp__serena__edit_memory", "mcp__serena__delete_memory"]`,
    `decision = "deny"`,
    `priority = 600`,
    `denyMessage = "Reviewer session: MCP write tools are disabled."`,
  ].join("\n");
}

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
    const { sessionName, promptDir, deliverTimeoutMs, idleTimeoutMs, pollIntervalMs } = this.config;

    await mkdir(promptDir, { recursive: true });
    const promptFile = join(promptDir, `${jobId}.md`);
    const outputFile = join(promptDir, `${jobId}-output.md`);
    await writeFile(promptFile, wrapLiveReviewPrompt(prompt, begin, done, this.config.useOutputFile ? outputFile : undefined, this.config.outputFileWriteMethod), "utf8");
    const writeInstruction = this.config.outputFileWriteMethod === "shell"
      ? `Write your complete review to ${outputFile} using a bash shell command (e.g. cat/tee). `
      : `Write your complete review to ${outputFile} using the native write_file tool. `;
    const instruction = this.config.useOutputFile
      ? `Read the file ${promptFile} and perform the code review it describes. ` +
        writeInstruction +
        `Also print exactly ${begin}, then the full review, then exactly ${done} to the terminal.`
      : `Read the file ${promptFile} and perform the code review it describes. ` +
        `Print exactly ${begin} on a line by itself, then the full review as plain text, ` +
        `then exactly ${done} on the final line.`;

    try {
      if (this.config.clearBetweenReviews && this.config.clearCommand) {
        await tmux(["send-keys", "-t", sessionName, "-l", "--", this.config.clearCommand]);
        await sleep(150, signal);
        await tmux(["send-keys", "-t", sessionName, "Enter"]);
        await sleep(600, signal);
      }
      await tmux(["clear-history", "-t", sessionName]);
      await tmux(["send-keys", "-t", sessionName, "-l", "--", instruction]);
      await sleep(150, signal);
      await tmux(["send-keys", "-t", sessionName, "Enter"]);

      const start = Date.now();
      const hardDeadline = start + deliverTimeoutMs;
      // Idle clock: reset whenever the pane tail changes (the reviewer is streaming output). A static
      // tail for idleTimeoutMs means the reviewer crashed/exited/hung. 0 disables the idle clock.
      let lastProgressAt = start;
      // Liveness is sampled from the pane TAIL every TICK_SAMPLE_INTERVAL_MS (see above), not from the
      // full capture on every fast poll — so we compare a bounded slice on a coarse cadence.
      let lastTail = "";
      let lastTailCheckAt = 0;
      let tickCount = 0;
      let tickingConfirmed = false;
      let adaptivePoll = 50;
      while (Date.now() < hardDeadline) {
        if (signal.aborted) throw new Error("reviewer worker is shutting down");

        if (this.config.useOutputFile) {
          const fileReview = await extractReviewFromFile(outputFile, jobId);
          if (fileReview !== null) {
            await this.refreshSessionId();
            this.devLog("review_extracted", { jobId, chars: fileReview.length, source: "file", requestedModel, usedModel: this.usedModelForLog(), currentModel: this.currentModel, sessionId: this.sessionId });
            return fileReview;
          }
        }

        const capture = await this.capture();
        const review = extractReviewFromCapture(capture, jobId);
        if (review !== null) {
          await this.refreshSessionId();
          this.devLog("review_extracted", { jobId, chars: review.length, source: "capture", requestedModel, usedModel: this.usedModelForLog(), currentModel: this.currentModel, sessionId: this.sessionId });
          return review;
        }

        // Stop early if the reviewer reports a usage/rate limit
        const limited = detectRateLimit(capture, this.config.rateLimitPatterns ?? []);
        if (limited) {
          throw new RateLimitError(`reviewer hit its usage/rate limit: ${limited}`, parseResetAtMs(limited, Date.now()));
        }

        const now = Date.now();
        // Classify thinking-vs-finished only on the sampling cadence, comparing the bounded pane tail
        // rather than the whole capture. Marker/file/rate-limit checks above still run every fast poll.
        if (now - lastTailCheckAt >= TICK_SAMPLE_INTERVAL_MS) {
          lastTailCheckAt = now;
          const tail = paneTail(capture, TICK_TAIL_LINES);
          if (tail !== lastTail) {
            // The pane tail repainted between samples — the reviewer is streaming output. A run of
            // consecutive changed samples confirms this is a ticking TUI, so a later freeze can be
            // trusted as "turn ended".
            lastTail = tail;
            lastProgressAt = now;
            if (++tickCount >= TICK_CONFIRM_COUNT) tickingConfirmed = true;
          } else {
            tickCount = 0;
            const idleFor = now - lastProgressAt;
            // Fast path: a confirmed-ticking reviewer whose tail has frozen has returned to its idle
            // prompt. No markers (checked above) and no output file means it finished without
            // delivering the review — fail now with a distinct diagnosis instead of waiting out the
            // full idle timeout.
            if (tickingConfirmed && idleFor >= QUIET_AFTER_TICKING_MS) {
              this.devLog("deliver_finished_no_artifact", { jobId, quietMs: idleFor, elapsedMs: now - start, requestedModel, usedModel: this.usedModelForLog(), currentModel: this.currentModel, sessionId: this.sessionId });
              throw new Error(
                `reviewer returned to an idle prompt after producing output but never wrote the review ` +
                  `markers${this.config.useOutputFile ? " or the output file" : ""}; the turn finished without delivering a review`,
              );
            }
            if (idleTimeoutMs > 0 && idleFor >= idleTimeoutMs) {
              this.devLog("deliver_idle_timeout", { jobId, idleTimeoutMs, elapsedMs: now - start, requestedModel, usedModel: this.usedModelForLog(), currentModel: this.currentModel, sessionId: this.sessionId });
              throw new Error(`reviewer produced no output for ${idleTimeoutMs}ms (idle timeout); the live session appears stuck or crashed`);
            }
          }
        }

        await sleep(Math.min(adaptivePoll, Math.max(0, hardDeadline - Date.now())), signal);
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
      if (this.config.useOutputFile) await sweepOrphanedOutputFiles(promptDir);
      if (this.config.policyFile) {
        await writeFile(this.config.policyFile.path, this.config.policyFile.content, "utf8");
      }
      const freshSessionId = this.config.freshSessionId?.() ?? null;
      const launchId = freshSessionId ?? this.sessionId;
      this.sessionId = freshSessionId;
      this.currentModel = null;
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

  private async waitUntilReady(timeoutMs: number, signal: AbortSignal): Promise<void> {
    const { sessionName } = this.config;
    const deadline = Date.now() + timeoutMs;
    let previous = "";
    let stableReads = 0;
    while (Date.now() < deadline) {
      if (signal.aborted) return;
      await sleep(700, signal);
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
    this.devLog("session_startup_timeout", { sessionName, timeoutMs });
    console.error(
      `[reviewer] WARNING: session '${sessionName}' pane was empty/unstable for ${timeoutMs}ms; ` +
        `the CLI may have stalled on startup. Proceeding — the deliver timeout will catch it.`,
    );
  }

  private async capture(): Promise<string> {
    const result = await tmux(["capture-pane", "-t", this.config.sessionName, "-p", "-J", "-S", "-"]);
    return result.stdout;
  }
}

async function tmux(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await spawnWithTimeout(["tmux", ...args], { timeoutMs: TMUX_TIMEOUT_MS });
  // On timeout the child is SIGTERM/SIGKILL'd; surface a non-zero code so callers treat a wedged
  // tmux as a failed command (capture returns empty, has-session reports "missing", etc.) and the
  // deliver loop falls through to its own deadline instead of waiting on a call that never returns.
  const code = result.exitCode ?? (result.timedOut ? 124 : 1);
  const stderr = result.timedOut
    ? [result.stderr.trim(), `tmux ${args[0] ?? ""} timed out after ${TMUX_TIMEOUT_MS}ms`].filter(Boolean).join("\n")
    : result.stderr;
  return { code, stdout: result.stdout, stderr };
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
      clearBetweenReviews: process.env.CODE_ASSISTANT_PEERS_REVIEWER_CLEAR === "always",
      startupTimeoutMs: envInt("CODE_ASSISTANT_PEERS_REVIEWER_STARTUP_MS", 30_000),
      deliverTimeoutMs: envInt("CODE_ASSISTANT_PEERS_REVIEW_TIMEOUT_MS", DEFAULT_DELIVER_TIMEOUT_MS),
      idleTimeoutMs: envInt("CODE_ASSISTANT_PEERS_REVIEW_IDLE_TIMEOUT_MS", DEFAULT_REVIEW_IDLE_TIMEOUT_MS),
      pollIntervalMs: envInt("CODE_ASSISTANT_PEERS_REVIEWER_POLL_MS", DEFAULT_POLL_INTERVAL_MS),
      useOutputFile: (kind.useOutputFile ?? false) &&
        !process.env[`CODE_ASSISTANT_PEERS_REVIEWER_${kind.slug.toUpperCase()}_ARGS`],
      policyFile: kind.policyContent && !process.env[`CODE_ASSISTANT_PEERS_REVIEWER_${kind.slug.toUpperCase()}_ARGS`]
        ? { path: join(kindPromptDir, "reviewer-policy.toml"), content: kind.policyContent(kindPromptDir) }
        : undefined,
      freshSessionId: kind.initialSessionId,
      outputFileWriteMethod: kind.slug === "codex" ? "shell" : "write_file_tool",
      rateLimitPatterns: (process.env.CODE_ASSISTANT_PEERS_RATE_LIMIT_PATTERNS ?? "").split(",").map((p) => p.trim()).filter(Boolean),
      devLog: (event, data) => devLog(event, { reviewer, cwd: repoCwd, ...data }),
    });
  };

  console.error(`[reviewer] worker started (broker=${brokerUrl}, session=${echo ? "echo" : "tmux per reviewer kind + repo"}${once ? ", once" : ""})`);
  await runReviewerWorker({
    brokerUrl,
    sessionFor,
    signal: controller.signal,
    once,
    rateLimitCooldownMs: envInt("CODE_ASSISTANT_PEERS_RATE_LIMIT_COOLDOWN_MS", DEFAULT_RATE_LIMIT_COOLDOWN_MS),
    deliverTimeoutMs: envInt("CODE_ASSISTANT_PEERS_REVIEW_TIMEOUT_MS", DEFAULT_DELIVER_TIMEOUT_MS),
    log: (message) => {
      console.error(`[reviewer] ${message}`);
      devLog("worker_log", { message });
    },
  });
  devLog("worker_stop", { brokerUrl });
  releaseLock?.();
}

// ---------------------------------------------------------------------------
// Live CLI kinds
// ---------------------------------------------------------------------------

export interface LiveCliKind {
  slug: string;
  promptDir: (cwd: string) => string;
  launchCommand: (cwd: string, promptDir: string, model?: string | null, sessionId?: string | null) => string[];
  resumeCommand?: (cwd: string, promptDir: string, sessionId: string, model?: string | null) => string[];
  initialSessionId?: () => string;
  discoverSessionId?: (cwd: string) => Promise<string | null>;
  clearCommand: string | null;
  useOutputFile?: boolean;
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
    promptDir: (cwd) => join(SHARED_PROMPT_DIR, shortHash(cwd)),
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
  const useReviewerHome = !process.env.CODE_ASSISTANT_PEERS_REVIEWER_CODEX_ARGS;
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

export function sessionNameFor(base: string, kind: string, cwd: string): string {
  const slug = (cwd.split("/").filter(Boolean).pop() ?? "repo").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || "repo";
  return `${base}-${kind}-${slug}-${shortHash(cwd)}`;
}

function shortHash(value: string): string {
  let h = 5381;
  for (let i = 0; i < value.length; i++) h = ((h << 5) + h + value.charCodeAt(i)) >>> 0; // djb2
  return h.toString(36);
}

export function acquireWorkerLock(brokerUrl: string): (() => void) | null {
  const lockPath = join(tmpdir(), `code-assistant-peers-reviewer-${shortHash(brokerUrl)}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx");
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
      if (lockHolderAlive(lockPath)) return null;
      try {
        unlinkSync(lockPath);
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
    process.kill(pid, 0);
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
