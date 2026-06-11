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

import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_BROKER_URL = "http://127.0.0.1:7899";
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_DELIVER_TIMEOUT_MS = 600_000;

export interface ReviewJob {
  id: string;
  reviewer: string;
  prompt: string;
  cwd: string; // repo dir this review is for ("" => worker default); routes to a per-repo session
}

// A reviewer backend. The real one drives a live `claude` TUI; tests/dev inject fakes.
export interface ReviewerSession {
  deliver(prompt: string, jobId: string, signal: AbortSignal): Promise<string>;
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
  const body = (await res.json().catch(() => ({}))) as { id?: string | null; reviewer?: string; prompt?: string; cwd?: string };
  if (!body.id || !body.prompt) return null;
  return { id: body.id, reviewer: String(body.reviewer ?? "claude-live"), prompt: body.prompt, cwd: String(body.cwd ?? "") };
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

  try {
    while (!signal.aborted) {
      const job = await claimNextJob(brokerUrl, signal);
      if (!job) {
        if (options.once) return;
        await sleep(pollIntervalMs, signal);
        continue;
      }

      log(`claimed job ${job.id} (${job.reviewer}, cwd=${job.cwd || "(default)"})`);
      try {
        const review = await resolveSession(job.reviewer, job.cwd).deliver(job.prompt, job.id, signal);
        await postResult(brokerUrl, job.id, review);
        log(`job ${job.id} reviewed (${review.length} chars)`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await postError(brokerUrl, job.id, `reviewer worker failed: ${message}`).catch(() => {});
        log(`job ${job.id} failed: ${message}`);
      }

      if (options.once) return;
    }
  } finally {
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
}

// Read-only launch: plan mode + edit tools disallowed so a reviewed diff containing injected
// instructions still cannot modify files (same safety model as the `claude -p` reviewer).
export const DEFAULT_REVIEWER_CLAUDE_ARGS = [
  "--permission-mode",
  "plan",
  "--allowedTools",
  "Read,Grep,Glob,Bash(git status:*),Bash(git diff:*),Bash(git show:*),Bash(git log:*),Bash(git ls-files:*)",
  "--disallowedTools",
  "Edit,Write,MultiEdit,NotebookEdit",
];

export class TmuxCliSession implements ReviewerSession {
  private ready = false;
  constructor(private readonly config: TmuxSessionConfig) {}

  async deliver(prompt: string, jobId: string, signal: AbortSignal): Promise<string> {
    await this.ensureSession(signal);
    const begin = beginMarkerFor(jobId);
    const done = doneMarkerFor(jobId);
    const { sessionName, promptDir, deliverTimeoutMs, pollIntervalMs } = this.config;

    // Hand the (large) review prompt to the session via a file — typing it through send-keys is
    // fragile. The instruction itself stays short to avoid input-line wrapping in the pane.
    // promptDir is granted via `--add-dir` at launch so the read-only session can Read it.
    await mkdir(promptDir, { recursive: true });
    const promptFile = join(promptDir, `${jobId}.md`);
    await writeFile(promptFile, prompt, "utf8");
    const instruction =
      `Read the file ${promptFile} and perform the code review it describes. ` +
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
      while (Date.now() < deadline) {
        // Bail out promptly on worker shutdown (SIGINT/SIGTERM) instead of polling until the
        // deliver timeout — the job is reported as an error and the worker loop can exit.
        if (signal.aborted) throw new Error("reviewer worker is shutting down");
        await sleep(pollIntervalMs, signal);
        const capture = await this.capture();
        const review = extractReviewFromCapture(capture, jobId);
        if (review !== null) return review;
      }
      throw new Error(`timed out after ${deliverTimeoutMs}ms waiting for the review marker in the live session`);
    } finally {
      await rm(promptFile, { force: true }).catch(() => {});
    }
  }

  async close(): Promise<void> {
    await tmux(["kill-session", "-t", this.config.sessionName]).catch(() => {});
  }

  // Ensure a tmux session running the interactive reviewer TUI exists and is ready for input.
  // If the session already exists we reuse it (the user may have launched it themselves).
  private async ensureSession(signal: AbortSignal): Promise<void> {
    if (this.ready) return;
    const { sessionName, cwd, launchCommand, promptDir, startupTimeoutMs } = this.config;

    const exists = (await tmux(["has-session", "-t", sessionName])).code === 0;
    if (!exists) {
      await mkdir(promptDir, { recursive: true });
      // Wide window => less line wrapping => cleaner capture. `--` ends tmux option parsing so
      // the rest is the command run inside the session. launchCommand must already include the
      // CLI's prompt-dir access grant (e.g. --add-dir / --include-directories).
      const created = await tmux([
        "new-session", "-d", "-s", sessionName, "-c", cwd, "-x", "400", "-y", "120",
        "--", ...launchCommand,
      ]);
      if (created.code !== 0) {
        throw new Error(`failed to start tmux session '${sessionName}': ${created.stderr.trim() || `exit ${created.code}`}`);
      }
      await this.waitUntilReady(startupTimeoutMs, signal);
    }
    this.ready = true;
  }

  // The TUI takes a moment to boot. We don't know an exact "ready" string across versions, so we
  // wait until the captured pane is non-empty and stable across two consecutive reads.
  private async waitUntilReady(timeoutMs: number, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let previous = "";
    let stableReads = 0;
    while (Date.now() < deadline) {
      await sleep(700, signal);
      const current = await this.capture();
      if (current.trim().length > 0 && current === previous) {
        if (++stableReads >= 2) return;
      } else {
        stableReads = 0;
      }
      previous = current;
    }
    // Don't hard-fail: proceed and let the deliver timeout catch a truly dead session.
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
  async deliver(prompt: string, jobId: string): Promise<string> {
    return `No findings. (echo reviewer for job ${jobId}; prompt was ${prompt.length} chars)\npatch is correct`;
  }
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
  const promptDir = process.env.CODE_ASSISTANT_PEERS_REVIEWER_PROMPT_DIR ?? join(tmpdir(), "peer-reviewer-prompts");

  // One session per (reviewer kind, repo cwd): a job's reviewer picks the CLI, its cwd pins the
  // session to that repo, and the worker caches/reuses the pair.
  const sessionFor = (reviewer: string, cwd: string): ReviewerSession => {
    if (echo) return new EchoSession();
    const kind = liveCliKindFor(reviewer);
    if (!kind) {
      throw new Error(`reviewer '${reviewer}' has no live CLI mapping (known: ${Object.keys(LIVE_CLI_KINDS).join(", ")})`);
    }
    const repoCwd = cwd || baseCwd;
    return new TmuxCliSession({
      sessionName: sessionNameFor(sessionBaseName, kind.slug, repoCwd),
      cwd: repoCwd,
      launchCommand: kind.launchCommand(promptDir),
      promptDir,
      clearCommand: kind.clearCommand,
      // "never" keeps the session's conversation memory across reviews; anything else clears.
      clearBetweenReviews: process.env.CODE_ASSISTANT_PEERS_REVIEWER_CLEAR !== "never",
      startupTimeoutMs: envInt("CODE_ASSISTANT_PEERS_REVIEWER_STARTUP_MS", 30_000),
      deliverTimeoutMs: envInt("CODE_ASSISTANT_PEERS_REVIEW_TIMEOUT_MS", DEFAULT_DELIVER_TIMEOUT_MS),
      pollIntervalMs: envInt("CODE_ASSISTANT_PEERS_REVIEWER_POLL_MS", DEFAULT_POLL_INTERVAL_MS),
    });
  };

  console.error(`[reviewer] worker started (broker=${brokerUrl}, session=${echo ? "echo" : "tmux per reviewer kind + repo"}${once ? ", once" : ""})`);
  await runReviewerWorker({
    brokerUrl,
    sessionFor,
    signal: controller.signal,
    once,
    log: (message) => console.error(`[reviewer] ${message}`),
  });
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
  launchCommand: (promptDir: string) => string[];
  clearCommand: string | null;
}

export const LIVE_CLI_KINDS: Record<string, LiveCliKind> = {
  "claude-live": {
    slug: "claude",
    launchCommand: (promptDir) => [
      "claude",
      ...(parseArgsEnv(process.env.CODE_ASSISTANT_PEERS_REVIEWER_CLAUDE_ARGS) ?? DEFAULT_REVIEWER_CLAUDE_ARGS),
      "--add-dir",
      promptDir,
    ],
    clearCommand: "/clear",
  },
  "gemini-live": {
    slug: "gemini",
    launchCommand: (promptDir) => [
      "gemini",
      ...(parseArgsEnv(process.env.CODE_ASSISTANT_PEERS_REVIEWER_GEMINI_ARGS) ?? ["--skip-trust", "--approval-mode", "plan"]),
      "--include-directories",
      promptDir,
    ],
    clearCommand: "/clear",
  },
  "codex-live": {
    slug: "codex",
    launchCommand: () => [
      "codex",
      ...(parseArgsEnv(process.env.CODE_ASSISTANT_PEERS_REVIEWER_CODEX_ARGS) ?? ["--sandbox", "read-only"]),
    ],
    clearCommand: "/new",
  },
};

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
