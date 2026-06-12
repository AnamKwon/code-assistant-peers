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
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_BROKER_URL = "http://127.0.0.1:7899";
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_DELIVER_TIMEOUT_MS = 600_000;

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

// The worker loop: claim → deliver to the live session → report result/error. Bounded only by
// the abort signal. A failed delivery is reported as a job error (not a crash) so one bad review
// never takes the worker down.
//
// Concurrency model: jobs for DIFFERENT sessions (reviewer kind × repo) run in PARALLEL — a
// multi-peer review that fans out to claude-live + gemini-live + codex-live boots and runs all
// three TUIs concurrently instead of paying their wall-clock times in sequence. Jobs for the
// SAME session are serialized via a per-session promise chain, because one TUI cannot interleave
// two reviews (send-keys/capture would corrupt both).
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

  // processJob never rejects — failures are reported to the broker as job errors.
  const processJob = async (job: ReviewJob): Promise<void> => {
    log(`claimed job ${job.id} (${job.reviewer}, cwd=${job.cwd || "(default)"})`);
    try {
      const review = await resolveSession(job.reviewer, job.cwd).deliver(job.prompt, job.id, signal, job.model);
      await postResult(brokerUrl, job.id, review);
      log(`job ${job.id} reviewed (${review.length} chars)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await postError(brokerUrl, job.id, `reviewer worker failed: ${message}`).catch(() => {});
      log(`job ${job.id} failed: ${message}`);
    }
  };

  // Tail of the in-order work chain per session key. Chaining serializes same-session jobs while
  // distinct sessions proceed independently (= in parallel).
  const chains = new Map<string, Promise<void>>();

  try {
    while (!signal.aborted) {
      const job = await claimNextJob(brokerUrl, signal);
      if (!job) {
        if (options.once) return;
        await sleep(pollIntervalMs, signal);
        continue;
      }

      if (options.once) {
        await processJob(job);
        return;
      }

      const key = `${job.reviewer}|${job.cwd}`;
      const next = (chains.get(key) ?? Promise.resolve()).then(() => processJob(job));
      chains.set(key, next);
      // Drop the entry once it settles IF it is still the tail, so the Map stays proportional to
      // in-flight sessions rather than every distinct repo the worker ever touched.
      void next.finally(() => {
        if (chains.get(key) === next) chains.delete(key);
      });
      // Loop straight back to claim the next job — concurrent sessions start immediately.
    }
  } finally {
    // Let in-flight reviews finish reporting before tearing the sessions down.
    await Promise.allSettled([...chains.values()]);
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
  return stripRenderedLineNumbers(cleanCapturedReview(between));
}

// The Gemini TUI renders responses with leading line numbers (" 2 I am Gemini...", " 3 ..."),
// which leak into the captured body. Strip them only under a conservative signature so genuine
// content is never mangled: at least two non-empty lines AND every non-empty line starts with a
// bare integer (followed by whitespace) AND those integers are strictly increasing. Markdown
// lists ("1. foo") don't match (dot, not whitespace, follows the digits).
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
  // Dir the per-job prompt files are written to. Must be readable by the session.
  promptDir: string;
  // CLI kind: command building (launch/resume), session-id strategy, conversation reset command.
  kind: LiveCliKind;
  // Send the kind's clear command before each review. Default FALSE (keep conversation memory
  // across reviews); set CODE_ASSISTANT_PEERS_REVIEWER_CLEAR=always for isolated reviews. Keeping
  // memory means the per-REPO session also accumulates other tasks' history and will eventually
  // auto-compact.
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
  // Model the live session is currently running (null = unknown / CLI default).
  private currentModel: string | null = null;
  // Session id used for resume-on-model-switch. Assigned up front where the CLI supports it
  // (claude/gemini --session-id); captured lazily from rollout files for codex; null when the
  // session is not resumable (e.g. we reused a user-launched session).
  private sessionId: string | null;
  // Last delivered job id — its unique BEGIN marker identifies OUR codex transcript on capture.
  private lastJobId: string | null = null;
  // When the session was first launched — lower bound for codex rollout-file mtime filtering.
  private startedAtMs = 0;

  constructor(private readonly config: TmuxSessionConfig) {
    this.sessionId = config.kind.idStrategy === "assign" ? crypto.randomUUID() : null;
  }

  async deliver(prompt: string, jobId: string, signal: AbortSignal, model?: string | null): Promise<string> {
    // Don't boot a session for a job that arrives during shutdown (the worker drains its chains
    // on abort) — bail before any tmux work.
    if (signal.aborted) throw new Error("reviewer worker is shutting down");
    try {
      return await this.deliverInner(prompt, jobId, signal, model);
    } catch (error) {
      // A failed delivery may have left the pane dead/wedged (e.g. a resume that never booted, or
      // swallowed input). Drop readiness so the NEXT job re-boots via ensureSession instead of
      // reusing a broken session forever.
      this.ready = false;
      throw error;
    }
  }

  private async deliverInner(prompt: string, jobId: string, signal: AbortSignal, model?: string | null): Promise<string> {
    const desired = model?.trim() || null;
    await this.ensureSession(signal, desired);
    // Switch the EXISTING session to the requested model (restart + resume keeps the
    // conversation). No-op when no model was requested or it already matches.
    if (desired && desired !== this.currentModel) {
      await this.switchModel(desired, signal);
    }
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
      // Conversation reset is OPT-IN (CODE_ASSISTANT_PEERS_REVIEWER_CLEAR=always): by default the
      // session keeps its memory across reviews so follow-up rounds benefit from what the
      // reviewer already read. NOTE the session is per-REPO, not per-task, so the default also
      // accumulates other tasks' history and a long-lived context will eventually auto-compact —
      // use "always" for isolated, bounded-context rounds.
      if (this.config.clearBetweenReviews && this.config.kind.clearCommand) {
        await tmux(["send-keys", "-t", sessionName, "-l", "--", this.config.kind.clearCommand]);
        await sleep(150, signal);
        await tmux(["send-keys", "-t", sessionName, "Enter"]);
        await sleep(600, signal); // let the reset settle before we wipe scrollback
      }
      // Always drop prior tmux scrollback so the capture is bounded to this job. This wipes the
      // rendered pane history only — NOT the session's conversation memory — so it is safe (and
      // required for clean extraction) regardless of clearBetweenReviews.
      await tmux(["clear-history", "-t", sessionName]);
      // Submit with echo verification: a TUI that is still booting (especially right after a
      // resume relaunch) can swallow keystrokes. The echoed instruction contains the BEGIN
      // marker, so its absence from the pane means the input was lost — retry a few times.
      let submitted = false;
      for (let attempt = 0; attempt < 3 && !submitted; attempt++) {
        await tmux(["send-keys", "-t", sessionName, "-l", "--", instruction]);
        await sleep(150, signal); // let the TUI register the paste before submitting
        await tmux(["send-keys", "-t", sessionName, "Enter"]);
        const echoDeadline = Date.now() + 5_000;
        while (Date.now() < echoDeadline && !submitted) {
          await sleep(500, signal);
          if ((await this.capture()).includes(begin)) submitted = true;
        }
      }
      if (!submitted) throw new Error("the live session did not accept the review instruction (input swallowed)");
      this.lastJobId = jobId; // marker is now part of the transcript (used for codex id capture)

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
  // If the session already exists we reuse it (the user may have launched it themselves) — but a
  // reused session was not launched with our session id, so it is not resumable by us.
  private async ensureSession(signal: AbortSignal, desiredModel: string | null = null): Promise<void> {
    if (this.ready) return;
    const { sessionName, cwd, promptDir, kind, startupTimeoutMs } = this.config;

    const exists = (await tmux(["has-session", "-t", sessionName])).code === 0;
    if (!exists) {
      // Bake the requested model into the FIRST launch — cheaper than booting on the default
      // model and immediately restarting to switch.
      const launched = await this.createTmuxSession(kind.launchCommand(cwd, promptDir, this.sessionId, desiredModel));
      if (!launched.ok) {
        throw new Error(`failed to start tmux session '${sessionName}': ${launched.detail}`);
      }
      // `ready`/`currentModel` are only trustworthy once the pane is CONFIRMED live — otherwise a
      // later job would short-circuit ensureSession and send keys into a half-booted/dead TUI.
      if (!(await this.waitUntilReady(startupTimeoutMs, signal))) {
        throw new Error(`tmux session '${sessionName}' did not become ready within ${startupTimeoutMs}ms`);
      }
      this.currentModel = desiredModel;
    } else {
      // Reused (likely user-launched) session: unknown identity and model, and we can't confirm
      // boot state, so trust that an existing session is usable but treat it as non-resumable.
      this.sessionId = null;
      this.currentModel = null;
    }
    this.ready = true;
  }

  // Switch the live session to `desired` by restarting it with the kind's resume command, which
  // preserves the conversation. Falls back to a FRESH session (memory reset, logged) when no
  // resumable ref exists, the resume relaunch fails to start, or the resumed pane never boots
  // (e.g. an expired/bad ref where `tmux new-session` still exits 0 but the inner CLI dies).
  private async switchModel(desired: string, signal: AbortSignal): Promise<void> {
    const { kind, cwd, promptDir, sessionName, startupTimeoutMs } = this.config;

    const ref = await this.resolveResumeRef();
    if (ref && kind.resumeCommand) {
      const resumed = await this.createTmuxSession(kind.resumeCommand(promptDir, ref, desired), true);
      // Success requires BOTH new-session exiting 0 AND the pane actually booting — the latter is
      // what catches a resume whose inner command died on a bad ref.
      if (resumed.ok && (await this.waitUntilReady(startupTimeoutMs, signal))) {
        this.ready = true;
        this.currentModel = desired;
        console.error(`[reviewer] ${sessionName}: switched model to ${desired} (resumed session ${ref}, conversation preserved)`);
        return;
      }
      console.error(`[reviewer] ${sessionName}: resume to ${desired} did not come up (${resumed.ok ? "pane never booted" : resumed.detail}); restarting fresh (conversation memory reset).`);
    } else {
      console.error(`[reviewer] ${sessionName}: no resumable session ref; model switch restarts fresh (conversation memory reset).`);
    }

    // Fresh fallback: new identity, requested model baked into the launch.
    this.sessionId = kind.idStrategy === "assign" ? crypto.randomUUID() : null;
    this.lastJobId = null;
    const fresh = await this.createTmuxSession(kind.launchCommand(cwd, promptDir, this.sessionId, desired), true);
    if (!fresh.ok || !(await this.waitUntilReady(startupTimeoutMs, signal))) {
      this.ready = false; // leave it un-ready so the next job re-boots instead of reusing a dead pane
      throw new Error(`failed to restart session '${sessionName}' for model switch to ${desired}`);
    }
    this.ready = true;
    this.currentModel = desired;
  }

  // The reference the kind's resume command needs: assigned uuid (claude), per-project list
  // index resolved from our uuid (gemini), or the rollout uuid captured by grepping for our
  // unique job marker (codex). null = not resumable.
  private async resolveResumeRef(): Promise<string | null> {
    const { kind, cwd } = this.config;
    if (kind.idStrategy === "capture") {
      if (!this.lastJobId) return null; // nothing delivered yet — fresh restart loses nothing
      // Only consider rollouts touched since this session launched (minus slack) so a busy
      // machine-global store can't push our file past the scan window.
      return await findCodexSessionId(codexSessionsDir(), beginMarkerFor(this.lastJobId), this.startedAtMs - 60_000);
    }
    if (!this.sessionId) return null;
    if (kind.resumeBy === "gemini-index") return await resolveGeminiSessionIndex(cwd, this.sessionId);
    return this.sessionId;
  }

  // (Re)create the tmux session running `command`. killExisting tears down the old session first.
  // Reports only whether `tmux new-session` launched — NOT whether the inner TUI booted; the
  // caller must confirm liveness via waitUntilReady before trusting `ready`/`currentModel`.
  private async createTmuxSession(command: string[], killExisting = false): Promise<{ ok: boolean; detail: string }> {
    const { sessionName, cwd, promptDir } = this.config;
    if (killExisting) {
      await tmux(["kill-session", "-t", sessionName]).catch(() => {});
    }
    this.ready = false;
    await mkdir(promptDir, { recursive: true });
    // Wide window => less line wrapping => cleaner capture. `--` ends tmux option parsing so the
    // rest is the command run inside the session (must include any prompt-dir access grant).
    const created = await tmux([
      "new-session", "-d", "-s", sessionName, "-c", cwd, "-x", "400", "-y", "120",
      "--", ...sessionEnvPrefix(), ...command,
    ]);
    if (created.code !== 0) return { ok: false, detail: created.stderr.trim() || `exit ${created.code}` };
    this.startedAtMs = Date.now();
    return { ok: true, detail: "" };
  }

  // The TUI takes a moment to boot. We don't know an exact "ready" string across versions, so we
  // wait until the captured pane is non-empty and stable across two consecutive reads. Returns
  // true only when that confirmed-live state was observed; false on abort or timeout (a never-
  // booted pane), so callers can distinguish a live session from a dead one.
  private async waitUntilReady(timeoutMs: number, signal: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let previous = "";
    let stableReads = 0;
    while (Date.now() < deadline) {
      // Bail out promptly on shutdown — sleep() resolves immediately when aborted, so without
      // this guard the loop would busy-spin spawning `tmux capture-pane` until the deadline.
      if (signal.aborted) return false;
      await sleep(700, signal);
      const current = await this.capture();
      if (current.trim().length > 0 && current === previous) {
        if (++stableReads >= 2) return true;
      } else {
        stableReads = 0;
      }
      previous = current;
    }
    return false; // timed out without observing a confirmed-live pane
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
      "[reviewer] note: ANTHROPIC_API_KEY is set in the worker environment, but reviewer sessions are " +
        "launched with an isolated env that strips it — claude sessions stay on subscription auth. " +
        "Unset it anyway to keep spawn-fallback reviews (claude -p) off API-key billing.",
    );
  }

  const baseCwd = process.env.CODE_ASSISTANT_PEERS_REVIEWER_CWD ?? process.cwd();
  const sessionBaseName = process.env.CODE_ASSISTANT_PEERS_TMUX_SESSION ?? "peer-reviewer";

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
    return new TmuxCliSession({
      sessionName: sessionNameFor(sessionBaseName, kind.slug, repoCwd),
      cwd: repoCwd,
      promptDir: kindPromptDir,
      kind,
      // Default: KEEP conversation memory across reviews (resume-on-switch preserves it too).
      // "always" clears before every review for isolated rounds; "never" kept as a legacy alias.
      clearBetweenReviews: process.env.CODE_ASSISTANT_PEERS_REVIEWER_CLEAR === "always",
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
  // Parent dir for the per-job prompt file. The session must be able to Read it: claude grants
  // it via --add-dir; gemini puts it INSIDE the (trusted) repo cwd to avoid a second trust
  // prompt that --include-directories would raise; codex reads absolute paths under its sandbox.
  promptDir: (cwd: string) => string;
  // Argv for a FRESH session. sessionId is baked in where the CLI supports assigning one
  // (claude/gemini --session-id; codex cannot); model is baked in when already requested.
  launchCommand: (cwd: string, promptDir: string, sessionId: string | null, model: string | null) => string[];
  // Argv that relaunches the CLI RESUMING sessionRef on a new model (conversation preserved).
  // sessionRef: assigned uuid (claude), per-project list index (gemini), captured rollout uuid
  // (codex). NEVER use --last/latest here — session stores are shared with the user's own
  // sessions (codex is even machine-global), so only explicit refs are safe.
  resumeCommand: (promptDir: string, sessionRef: string, model: string) => string[];
  // How this kind gets a resumable id: "assign" = we hand the CLI a uuid at launch;
  // "capture" = recover it later from the CLI's own session store (codex rollout files).
  idStrategy: "assign" | "capture";
  // What resumeCommand's sessionRef is resolved from: the uuid itself, or gemini's
  // per-project session list index looked up by our uuid.
  resumeBy: "uuid" | "gemini-index";
  clearCommand: string | null;
}

const SHARED_PROMPT_DIR = join(tmpdir(), "peer-reviewer-prompts");

function claudeBaseArgs(): string[] {
  return parseArgsEnv(process.env.CODE_ASSISTANT_PEERS_REVIEWER_CLAUDE_ARGS) ?? DEFAULT_REVIEWER_CLAUDE_ARGS;
}
function geminiBaseArgs(): string[] {
  return parseArgsEnv(process.env.CODE_ASSISTANT_PEERS_REVIEWER_GEMINI_ARGS) ?? ["--skip-trust", "--approval-mode", "plan"];
}
function codexBaseArgs(): string[] {
  return parseArgsEnv(process.env.CODE_ASSISTANT_PEERS_REVIEWER_CODEX_ARGS) ?? ["--sandbox", "read-only"];
}

export const LIVE_CLI_KINDS: Record<string, LiveCliKind> = {
  "claude-live": {
    slug: "claude",
    promptDir: () => SHARED_PROMPT_DIR,
    launchCommand: (_cwd, promptDir, sessionId, model) => [
      "claude",
      ...claudeBaseArgs(),
      ...(sessionId ? ["--session-id", sessionId] : []),
      ...(model ? ["--model", model] : []),
      "--add-dir",
      promptDir,
    ],
    resumeCommand: (promptDir, sessionRef, model) => [
      "claude",
      ...claudeBaseArgs(),
      "--resume",
      sessionRef,
      "--model",
      model,
      "--add-dir",
      promptDir,
    ],
    idStrategy: "assign",
    resumeBy: "uuid",
    clearCommand: "/clear",
  },
  "gemini-live": {
    slug: "gemini",
    // Inside the repo cwd (already trusted via --skip-trust) so gemini can Read it without the
    // separate `--include-directories` trust prompt that stalls a detached session.
    promptDir: (cwd) => join(cwd, ".peer-review"),
    launchCommand: (_cwd, _promptDir, sessionId, model) => [
      "gemini",
      ...geminiBaseArgs(),
      ...(sessionId ? ["--session-id", sessionId] : []),
      ...(model ? ["-m", model] : []),
    ],
    // gemini --resume takes the per-project session list INDEX (resolved from our uuid via
    // --list-sessions), not the uuid itself.
    resumeCommand: (_promptDir, sessionRef, model) => [
      "gemini",
      ...geminiBaseArgs(),
      "-m",
      model,
      "--resume",
      sessionRef,
    ],
    idStrategy: "assign",
    resumeBy: "gemini-index",
    clearCommand: "/clear",
  },
  "codex-live": {
    slug: "codex",
    promptDir: () => SHARED_PROMPT_DIR,
    launchCommand: (_cwd, _promptDir, _sessionId, model) => [
      "codex",
      ...codexBaseArgs(),
      ...(model ? ["-m", model] : []),
    ],
    // codex resume continues the recorded session (uuid captured from its rollout file); the
    // model is overridden via config since resume has no -m flag of its own.
    resumeCommand: (_promptDir, sessionRef, model) => [
      "codex",
      "resume",
      sessionRef,
      "-c",
      `model=${JSON.stringify(model)}`,
    ],
    idStrategy: "capture",
    resumeBy: "uuid",
    clearCommand: "/new",
  },
};

// ---------------------------------------------------------------------------
// Session environment isolation
//
// The reviewer TUIs must NOT inherit the spawning process's environment: when the worker is
// auto-started from a host coding agent (or a dev shell inside one), nested-session variables
// leak in and break the CLIs — observed concretely as Claude sessions no longer persisting
// their conversation transcripts (which silently breaks resume-on-model-switch). Launch every
// session through `env -i` with an explicit allowlist instead — the same posture
// buildReviewCommandEnv takes for spawned headless reviewers. ANTHROPIC_API_KEY is deliberately
// absent so claude stays on subscription auth.
// ---------------------------------------------------------------------------

const SESSION_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_APPLICATION_CREDENTIALS",
];

export function sessionEnvPrefix(sourceEnv: NodeJS.ProcessEnv = process.env): string[] {
  const pairs = SESSION_ENV_ALLOWLIST.flatMap((key) =>
    sourceEnv[key] !== undefined ? [`${key}=${sourceEnv[key]}`] : [],
  );
  // TERM must be re-set explicitly because `env -i` wipes the one tmux provides to the pane.
  return ["env", "-i", ...pairs, `TERM=${sourceEnv.TERM ?? "xterm-256color"}`];
}

// ---------------------------------------------------------------------------
// Session-id helpers for resume-on-model-switch
// ---------------------------------------------------------------------------

export function codexSessionsDir(): string {
  return process.env.CODE_ASSISTANT_PEERS_CODEX_SESSIONS_DIR ?? join(homedir(), ".codex", "sessions");
}

// rollout-2026-06-12T09-41-24-<uuid>.jsonl -> <uuid>
export function codexSessionIdFromRolloutPath(path: string): string | null {
  const match = /rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(path);
  return match ? match[1] : null;
}

// Find OUR codex session by content: its transcript is the only one in the world containing the
// given per-job marker, so this never confuses the user's own (machine-global) codex sessions.
// Scans newest-first and bounds the scan; returns null when nothing matches (caller falls back).
export async function findCodexSessionId(dir: string, marker: string, sinceMs = 0, scanLimit = 50): Promise<string | null> {
  let entries: string[];
  try {
    entries = (await readdir(dir, { recursive: true })) as string[];
  } catch {
    return null;
  }
  const files = entries.filter((entry) => entry.endsWith(".jsonl")).map((entry) => join(dir, entry));
  const dated = (await Promise.all(files.map(async (file) => ({
    file,
    mtimeMs: (await stat(file).catch(() => null))?.mtimeMs ?? 0,
  }))))
    .filter((entry) => entry.mtimeMs >= sinceMs) // our rollout can't predate the session launch
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const scanned = dated.slice(0, scanLimit);
  for (const { file } of scanned) {
    try {
      if ((await readFile(file, "utf8")).includes(marker)) return codexSessionIdFromRolloutPath(file);
    } catch {
      // unreadable rollout — skip
    }
  }
  if (dated.length > scanLimit) {
    console.error(`[reviewer] codex session capture scanned the ${scanLimit} newest of ${dated.length} candidate rollouts without a match; resume may fall back to a fresh session.`);
  }
  return null;
}

// Parse `gemini --list-sessions` output ("  3. <preview>... (20 hours ago) [<uuid>]") and return
// the list index for OUR uuid. Index-by-uuid keeps us off "latest", which could be the user's
// own gemini session in the same repo.
export function parseGeminiSessionIndex(listOutput: string, sessionId: string): string | null {
  for (const line of listOutput.split("\n")) {
    const match = /^\s*(\d+)\.\s.*\[([0-9a-fA-F-]{36})\]\s*$/.exec(line);
    if (match && match[2].toLowerCase() === sessionId.toLowerCase()) return match[1];
  }
  return null;
}

async function resolveGeminiSessionIndex(cwd: string, sessionId: string): Promise<string | null> {
  // Use the same isolated env as the launched session (env -i + allowlist) so the probe sees the
  // identical config/auth the real session does — and never inherits nested-CLI leakage.
  const [, , ...envPairs] = sessionEnvPrefix();
  const env = Object.fromEntries(envPairs.map((pair) => {
    const eq = pair.indexOf("=");
    return [pair.slice(0, eq), pair.slice(eq + 1)];
  }));
  const proc = Bun.spawn(["gemini", "--list-sessions"], { cwd, env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), 30_000);
  try {
    const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return parseGeminiSessionIndex(stdout, sessionId);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
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
