#!/usr/bin/env bun
// Minimal localhost broker for the "channel" review transport.
//
// It relays review jobs between two sides, and is generic about the reviewer:
//   • channel transport (shared/broker-client.ts):  POST /jobs  → poll GET /jobs/:id
//   • reviewer worker (backgrounded live Claude):    GET /next   → POST /jobs/:id/result
//
// The reviewer side is pluggable. In production it is a backgrounded interactive Claude
// session (subscription pool, read-only) connected via a channel bridge — see
// broker/REVIEWER.md. For tests/dev the reviewer can be any process that polls /next.
//
// Run:  CODE_ASSISTANT_PEERS_BROKER_PORT=7899 bun broker/server.ts

interface Job {
  id: string;
  reviewer: string;
  prompt: string;
  // Repo dir the review is for, so the reviewer worker drives a session pinned to the right repo
  // (per-repo isolation across concurrently reviewed repos). Empty => worker's default cwd.
  cwd: string;
  // Optional model the review should run on; the worker switches the live session when it differs.
  model: string | null;
  status: "pending" | "claimed" | "done" | "error";
  result?: string;
  createdAt: number;
}

const PORT = Number(process.env.CODE_ASSISTANT_PEERS_BROKER_PORT ?? 7899);
const jobs = new Map<string, Job>();
let seq = 0;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const { pathname } = new URL(req.url);

    // --- channel transport side ---
    if (req.method === "POST" && pathname === "/jobs") {
      const body = (await req.json().catch(() => ({}))) as { reviewer?: string; prompt?: string; cwd?: string; model?: string | null };
      if (!body.prompt) return json({ error: "prompt required" }, 400);
      const id = `job_${Date.now().toString(36)}_${seq++}`;
      jobs.set(id, { id, reviewer: String(body.reviewer ?? "claude-live"), prompt: body.prompt, cwd: String(body.cwd ?? ""), model: body.model ? String(body.model) : null, status: "pending", createdAt: Date.now() });
      return json({ id, status: "pending" });
    }

    const result = pathname.match(/^\/jobs\/([^/]+)\/result$/);
    if (req.method === "POST" && result) {
      const job = jobs.get(decodeURIComponent(result[1]));
      if (!job) return json({ error: "unknown job" }, 404);
      const body = (await req.json().catch(() => ({}))) as { result?: string };
      job.status = "done";
      job.result = String(body.result ?? "");
      return json({ ok: true });
    }

    const errored = pathname.match(/^\/jobs\/([^/]+)\/error$/);
    if (req.method === "POST" && errored) {
      const job = jobs.get(decodeURIComponent(errored[1]));
      if (!job) return json({ error: "unknown job" }, 404);
      const body = (await req.json().catch(() => ({}))) as { error?: string };
      job.status = "error";
      job.result = String(body.error ?? "reviewer error");
      return json({ ok: true });
    }

    const poll = pathname.match(/^\/jobs\/([^/]+)$/);
    if (req.method === "GET" && poll) {
      const job = jobs.get(decodeURIComponent(poll[1]));
      if (!job) return json({ status: "error", result: "unknown job" }, 404);
      return json({ status: job.status, result: job.result });
    }

    // --- reviewer worker side ---
    if (req.method === "GET" && pathname === "/next") {
      for (const job of jobs.values()) {
        if (job.status === "pending") {
          job.status = "claimed";
          return json({ id: job.id, reviewer: job.reviewer, prompt: job.prompt, cwd: job.cwd, model: job.model });
        }
      }
      return json({ id: null });
    }

    if (pathname === "/health") return json({ ok: true, jobs: jobs.size });
    return json({ error: "not found" }, 404);
  },
});

console.error(`[code-assistant-peers broker] listening on http://127.0.0.1:${PORT}`);
