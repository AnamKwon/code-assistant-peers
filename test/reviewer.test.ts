import { describe, expect, test } from "bun:test";
import {
  type ReviewerSession,
  acquireWorkerLock,
  claimNextJob,
  doneMarkerFor,
  extractReviewFromCapture,
  runReviewerWorker,
  sessionNameForCwd,
} from "../broker/reviewer.ts";

interface MockJob {
  id: string;
  reviewer: string;
  prompt: string;
  cwd?: string;
}

// In-memory broker exposing exactly the endpoints the reviewer worker uses:
//   GET /next  → claim a pending job (or {id:null})
//   POST /jobs/:id/result | /error → record outcome
// Mirrors broker/server.ts so the worker is exercised end-to-end without a real broker process.
function startMockBroker(jobs: MockJob[]) {
  const queue = [...jobs];
  const results = new Map<string, { result?: string; error?: string }>();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (req.method === "GET" && pathname === "/next") {
        const job = queue.shift();
        return Response.json(job ? { id: job.id, reviewer: job.reviewer, prompt: job.prompt, cwd: job.cwd ?? "" } : { id: null });
      }
      const resultMatch = pathname.match(/^\/jobs\/([^/]+)\/result$/);
      if (req.method === "POST" && resultMatch) {
        const body = (await req.json()) as { result?: string };
        results.set(decodeURIComponent(resultMatch[1]), { result: body.result });
        return Response.json({ ok: true });
      }
      const errorMatch = pathname.match(/^\/jobs\/([^/]+)\/error$/);
      if (req.method === "POST" && errorMatch) {
        const body = (await req.json()) as { error?: string };
        results.set(decodeURIComponent(errorMatch[1]), { error: body.error });
        return Response.json({ ok: true });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  return { server, results, url: `http://127.0.0.1:${server.port}` };
}

describe("reviewer worker loop", () => {
  test("claims a job, delivers it, and posts the review result", async () => {
    const broker = startMockBroker([{ id: "job-1", reviewer: "claude-live", prompt: "review this change" }]);
    const session: ReviewerSession = {
      deliver: async (prompt) => `REVIEW: ${prompt.length} chars seen. patch is correct`,
    };
    try {
      await runReviewerWorker({
        brokerUrl: broker.url,
        sessionFor: () => session,
        signal: new AbortController().signal,
        once: true,
        pollIntervalMs: 10,
      });
      expect(broker.results.get("job-1")?.result).toContain("patch is correct");
      expect(broker.results.get("job-1")?.error).toBeUndefined();
    } finally {
      broker.server.stop(true);
    }
  });

  test("reports a job error when the session throws (worker keeps running)", async () => {
    const broker = startMockBroker([{ id: "job-2", reviewer: "claude-live", prompt: "p" }]);
    const session: ReviewerSession = {
      deliver: async () => {
        throw new Error("live session unreachable");
      },
    };
    try {
      await runReviewerWorker({
        brokerUrl: broker.url,
        sessionFor: () => session,
        signal: new AbortController().signal,
        once: true,
        pollIntervalMs: 10,
      });
      expect(broker.results.get("job-2")?.error).toContain("live session unreachable");
      expect(broker.results.get("job-2")?.result).toBeUndefined();
    } finally {
      broker.server.stop(true);
    }
  });

  test("once mode returns when there is no pending job", async () => {
    const broker = startMockBroker([]);
    const session: ReviewerSession = { deliver: async () => "unused" };
    try {
      await runReviewerWorker({
        brokerUrl: broker.url,
        sessionFor: () => session,
        signal: new AbortController().signal,
        once: true,
        pollIntervalMs: 10,
      });
      expect(broker.results.size).toBe(0);
    } finally {
      broker.server.stop(true);
    }
  });

  test("routes jobs to a per-cwd session: one session built per distinct repo, reused", async () => {
    const broker = startMockBroker([
      { id: "a1", reviewer: "claude-live", prompt: "p", cwd: "/repo/a" },
      { id: "b1", reviewer: "claude-live", prompt: "p", cwd: "/repo/b" },
      { id: "a2", reviewer: "claude-live", prompt: "p", cwd: "/repo/a" },
    ]);
    const builtFor: string[] = [];
    const deliveredBy = new Map<string, string[]>(); // cwd -> jobIds delivered by that session
    const sessionFor = (cwd: string): ReviewerSession => {
      builtFor.push(cwd);
      deliveredBy.set(cwd, []);
      return {
        deliver: async (_prompt, jobId) => {
          deliveredBy.get(cwd)!.push(jobId);
          return "patch is correct";
        },
      };
    };
    const controller = new AbortController();
    try {
      // not once: drain all three jobs, then abort when the queue is empty
      const run = runReviewerWorker({ brokerUrl: broker.url, sessionFor, signal: controller.signal, pollIntervalMs: 5 });
      await Bun.sleep(120);
      controller.abort();
      await run;
      expect(builtFor.sort()).toEqual(["/repo/a", "/repo/b"]); // one session per distinct cwd
      expect(deliveredBy.get("/repo/a")).toEqual(["a1", "a2"]); // repo A session reused for a1 + a2
      expect(deliveredBy.get("/repo/b")).toEqual(["b1"]);
    } finally {
      controller.abort();
      broker.server.stop(true);
    }
  });

  test("claimNextJob returns null when the broker is unreachable", async () => {
    const job = await claimNextJob("http://127.0.0.1:1", new AbortController().signal);
    expect(job).toBeNull();
  });

  test("acquireWorkerLock enforces one live worker per broker", () => {
    const url = `http://127.0.0.1:9${Math.floor(process.hrtime()[1] % 900) + 100}/lock-test`;
    const release1 = acquireWorkerLock(url);
    expect(release1).not.toBeNull(); // first worker acquires
    const release2 = acquireWorkerLock(url);
    expect(release2).toBeNull(); // second worker (this live process holds it) is rejected
    release1?.();
    const release3 = acquireWorkerLock(url); // released → acquirable again
    expect(release3).not.toBeNull();
    release3?.();
  });

  test("sessionNameForCwd is stable, tmux-safe, and distinct per path", () => {
    const a = sessionNameForCwd("peer-reviewer", "/Users/me/work/repo-a");
    const b = sessionNameForCwd("peer-reviewer", "/Users/me/work/repo-b");
    expect(a).toBe(sessionNameForCwd("peer-reviewer", "/Users/me/work/repo-a")); // stable
    expect(a).not.toBe(b); // distinct per path
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/); // tmux-safe
    expect(a).toContain("repo-a");
  });
});

describe("review extraction from a captured pane", () => {
  test("returns null when the marker is absent (no review yet)", () => {
    expect(extractReviewFromCapture("just booting up\n> ", "job-1")).toBeNull();
  });

  test("returns null when only the echoed instruction marker is present (still running)", () => {
    const marker = doneMarkerFor("job-1");
    const pane = `> Read the file /tmp/x.md ... output exactly: ${marker}\n\nthinking...`;
    expect(extractReviewFromCapture(pane, "job-1")).toBeNull();
  });

  test("extracts the review between the echoed marker and the emitted marker", () => {
    const marker = doneMarkerFor("job-7");
    const pane = [
      "│ > Read the file /tmp/peer/job-7.md ... output exactly: " + marker,
      "│",
      "│ No findings. The change correctly clamps the timeout.",
      "│ patch is correct",
      "│ " + marker,
      "╰──────────────────────────────────────────╯",
    ].join("\n");
    const review = extractReviewFromCapture(pane, "job-7");
    expect(review).toContain("No findings");
    expect(review).toContain("patch is correct");
    expect(review).not.toContain(marker);
  });

  test("a stale marker from a different job does not match this job", () => {
    const otherMarker = doneMarkerFor("old-job");
    const pane = `previous review ... ${otherMarker}\nfresh prompt for the new job`;
    expect(extractReviewFromCapture(pane, "job-9")).toBeNull();
  });

  // Regression: the Claude TUI/markdown renderer mangles bracketed markers (e.g. `<<<x>>>` is
  // rendered as `<<x>>`), which silently broke live marker matching. The marker must use only
  // letters/digits/hyphens/underscores so it survives rendering byte-for-byte.
  test("the done marker contains no markdown/TUI-special characters", () => {
    expect(doneMarkerFor("job-1")).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
