// Client side of the "channel" review transport. Instead of spawning a CLI, runReviewCommand
// submits the review prompt to a localhost broker which routes it to a backgrounded, live
// interactive Claude session (subscription pool, no `claude -p`) and returns its reply.
// If the broker / live session is unavailable, the caller falls back to spawning the CLI.

import { openSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Read at call time (not module load) so it is configurable per-call and testable.
export function brokerUrl(): string {
  return process.env.CODE_ASSISTANT_PEERS_BROKER_URL ?? "http://127.0.0.1:7899";
}

export interface BrokerReply {
  ok: boolean;
  text: string;
  error?: string;
}

interface SubmitResponse {
  id: string;
}

interface PollResponse {
  status: "pending" | "claimed" | "done" | "error";
  result?: string;
}

// Per-fetch bound so a broker that accepts a connection but never responds fails fast and the
// caller falls back to spawning the CLI (rather than hanging before the overall timeout).
const REQUEST_TIMEOUT_MS = 10_000;

// Submit a review job and poll until the reviewer session replies, the broker errors, or we
// hit timeoutMs. Never throws — network/availability failures return { ok: false } so the
// caller can fall back to spawning the CLI.
export async function reviewViaBroker(
  reviewer: string,
  prompt: string,
  timeoutMs: number,
  cwd = "",
  pollIntervalMs = 1000,
): Promise<BrokerReply> {
  const base = brokerUrl();
  // Bound the WHOLE operation (submit + polling) by timeoutMs — compute the deadline up front
  // so a slow submit cannot hand the poll loop a fresh full budget.
  const deadline = Date.now() + Math.max(1, timeoutMs);
  let id: string;
  try {
    const submit = await fetch(`${base}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // cwd routes the review to a per-repo reviewer session on the worker side.
      body: JSON.stringify({ reviewer, prompt, cwd }),
      signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, Math.max(1, deadline - Date.now()))),
    });
    if (!submit.ok) return { ok: false, text: "", error: `broker submit failed (HTTP ${submit.status})` };
    const parsed = (await submit.json()) as SubmitResponse;
    if (!parsed.id) return { ok: false, text: "", error: "broker did not return a job id" };
    id = parsed.id;
  } catch (error) {
    return { ok: false, text: "", error: `broker submit failed: ${error instanceof Error ? error.message : String(error)}` };
  }

  while (Date.now() < deadline) {
    // Clamp the inter-poll sleep to the remaining budget so it cannot overshoot the deadline.
    await sleep(Math.min(pollIntervalMs, deadline - Date.now()));
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      // Clamp each poll to the remaining budget so the broker path never exceeds the
      // caller's timeout (and thus the configured review timeout) before falling back.
      const poll = await fetch(`${base}/jobs/${encodeURIComponent(id)}`, {
        signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remaining)),
      });
      if (!poll.ok) continue;
      const job = (await poll.json()) as PollResponse;
      if (job.status === "done") return { ok: true, text: job.result ?? "" };
      if (job.status === "error") return { ok: false, text: "", error: job.result ?? "reviewer reported an error" };
    } catch {
      continue; // transient error / aborted poll — retry until the overall deadline
    }
  }
  return { ok: false, text: "", error: `broker timed out after ${timeoutMs}ms waiting for the reviewer session` };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Auto-start: bring up the channel backend (broker + reviewer worker) on demand so a host
// (Codex or Claude) only has to select `claude-live` — no manual daemon launch. The backend is
// a persistent, REUSED set of processes: once running, later reviews find it healthy and skip
// spawning. Disable with CODE_ASSISTANT_PEERS_NO_AUTOSTART=1.
// ---------------------------------------------------------------------------

export async function brokerHealthy(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

// Spawn the broker and reviewer worker as detached background processes (they outlive this MCP
// server and are reused). stdout/stderr go to a log file — NEVER this process's stdout, which
// carries the MCP stdio protocol. The reviewer worker runs in `cwd` so the live Claude session
// inspects the repo under review.
function spawnBackend(cwd: string): void {
  const here = dirname(fileURLToPath(import.meta.url)); // .../shared
  const serverPath = join(here, "..", "broker", "server.ts");
  const reviewerPath = join(here, "..", "broker", "reviewer.ts");
  const logPath = join(tmpdir(), "code-assistant-peers-backend.log");
  const fd = openSync(logPath, "a");
  const base = brokerUrl();
  const childEnv = {
    ...process.env,
    CODE_ASSISTANT_PEERS_BROKER_URL: base,
    CODE_ASSISTANT_PEERS_REVIEWER_CWD: cwd,
  } as Record<string, string>;
  const opts = { cwd, env: childEnv, stdin: "ignore", stdout: fd, stderr: fd } as const;
  Bun.spawn([process.execPath, serverPath], opts);
  Bun.spawn([process.execPath, reviewerPath], opts);
  console.error(
    `[code-assistant-peers] auto-started channel backend (broker + reviewer worker) in ${cwd}. ` +
      `It runs backgrounded INTERACTIVE Claude sessions, one per reviewed repo (subscription pool, not 'claude -p'). ` +
      `Logs: ${logPath}. List the reviewer sessions: tmux ls (named peer-reviewer-<repo>-<hash>); ` +
      `watch one live: tmux attach -t <name>. Stop everything: tmux kill-session per session and kill the broker on ${base}.`,
  );
}

export interface BackendBootstrapDeps {
  brokerHealthy: (base: string) => Promise<boolean>;
  spawnBackend: (cwd: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  healthWaitMs: number;
  pollMs: number;
}

const defaultBootstrapDeps: BackendBootstrapDeps = {
  brokerHealthy,
  spawnBackend,
  sleep,
  now: () => Date.now(),
  healthWaitMs: 8000,
  pollMs: 300,
};

// Ensure the broker is up: if already healthy, do nothing; otherwise spawn the backend and wait
// (briefly) for the broker to answer. We only wait for the lightweight broker here — the live
// Claude session boots asynchronously and reviewViaBroker's own polling absorbs that cold start.
export async function bootstrapBackend(cwd: string, deps: BackendBootstrapDeps = defaultBootstrapDeps): Promise<void> {
  const base = brokerUrl();
  if (await deps.brokerHealthy(base)) return;
  deps.spawnBackend(cwd);
  const deadline = deps.now() + deps.healthWaitMs;
  while (deps.now() < deadline) {
    await deps.sleep(deps.pollMs);
    if (await deps.brokerHealthy(base)) return;
  }
  // Proceed regardless — reviewViaBroker will fall back to `claude -p` if the broker never came up.
}

let backendBootstrap: Promise<void> | null = null;

// Idempotent per MCP-server process: the first channel review triggers the bootstrap; concurrent
// and subsequent reviews await/reuse the same promise. A failed bootstrap resets so a later
// review can retry.
export async function ensureChannelBackend(cwd: string): Promise<void> {
  if (process.env.CODE_ASSISTANT_PEERS_NO_AUTOSTART === "1") return;
  if (!backendBootstrap) {
    backendBootstrap = bootstrapBackend(cwd).catch((error) => {
      backendBootstrap = null;
      console.error(
        `[code-assistant-peers] channel backend autostart failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
  return backendBootstrap;
}
