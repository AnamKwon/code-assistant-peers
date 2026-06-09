// Client side of the "channel" review transport. Instead of spawning a CLI, runReviewCommand
// submits the review prompt to a localhost broker which routes it to a backgrounded, live
// interactive Claude session (subscription pool, no `claude -p`) and returns its reply.
// If the broker / live session is unavailable, the caller falls back to spawning the CLI.

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
      body: JSON.stringify({ reviewer, prompt }),
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
