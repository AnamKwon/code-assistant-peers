import { describe, expect, test } from "bun:test";
import {
  LIVE_CLI_KINDS,
  type ReviewerSession,
  acquireWorkerLock,
  beginMarkerFor,
  claimNextJob,
  doneMarkerFor,
  extractReviewFromCapture,
  liveCliKindFor,
  runReviewerWorker,
  sessionNameFor,
  stripRenderedLineNumbers,
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

  test("routes jobs per (reviewer kind, cwd): one session per distinct pair, reused", async () => {
    const broker = startMockBroker([
      { id: "a1", reviewer: "claude-live", prompt: "p", cwd: "/repo/a" },
      { id: "b1", reviewer: "claude-live", prompt: "p", cwd: "/repo/b" },
      { id: "g1", reviewer: "gemini-live", prompt: "p", cwd: "/repo/a" }, // same repo, different CLI
      { id: "a2", reviewer: "claude-live", prompt: "p", cwd: "/repo/a" },
    ]);
    const builtFor: string[] = [];
    const deliveredBy = new Map<string, string[]>(); // "reviewer|cwd" -> jobIds delivered
    const sessionFor = (reviewer: string, cwd: string): ReviewerSession => {
      const key = `${reviewer}|${cwd}`;
      builtFor.push(key);
      deliveredBy.set(key, []);
      return {
        deliver: async (_prompt, jobId) => {
          deliveredBy.get(key)!.push(jobId);
          return "patch is correct";
        },
      };
    };
    const controller = new AbortController();
    try {
      // not once: drain all four jobs, then abort when the queue is empty
      const run = runReviewerWorker({ brokerUrl: broker.url, sessionFor, signal: controller.signal, pollIntervalMs: 5 });
      await Bun.sleep(150);
      controller.abort();
      await run;
      expect(builtFor.sort()).toEqual(["claude-live|/repo/a", "claude-live|/repo/b", "gemini-live|/repo/a"]);
      expect(deliveredBy.get("claude-live|/repo/a")).toEqual(["a1", "a2"]); // reused for a1 + a2
      expect(deliveredBy.get("claude-live|/repo/b")).toEqual(["b1"]);
      expect(deliveredBy.get("gemini-live|/repo/a")).toEqual(["g1"]); // same repo, separate session
    } finally {
      controller.abort();
      broker.server.stop(true);
    }
  });

  test("distinct sessions run in PARALLEL; same-session jobs stay serialized", async () => {
    const broker = startMockBroker([
      { id: "c1", reviewer: "claude-live", prompt: "p", cwd: "/repo/a" },
      { id: "g1", reviewer: "gemini-live", prompt: "p", cwd: "/repo/a" }, // different session → parallel
      { id: "c2", reviewer: "claude-live", prompt: "p", cwd: "/repo/a" }, // same session as c1 → after c1
    ]);
    const events: Array<{ job: string; type: "start" | "end"; at: number }> = [];
    const sessionFor = (reviewer: string): ReviewerSession => ({
      deliver: async (_prompt, jobId) => {
        events.push({ job: jobId, type: "start", at: Date.now() });
        await Bun.sleep(120);
        events.push({ job: jobId, type: "end", at: Date.now() });
        return `done by ${reviewer}`;
      },
    });
    const controller = new AbortController();
    try {
      const run = runReviewerWorker({ brokerUrl: broker.url, sessionFor, signal: controller.signal, pollIntervalMs: 5 });
      await Bun.sleep(450);
      controller.abort();
      await run;
      const at = (job: string, type: "start" | "end") => events.find((e) => e.job === job && e.type === type)!.at;
      // parallel: gemini started BEFORE claude's first job finished
      expect(at("g1", "start")).toBeLessThan(at("c1", "end"));
      // serialized: c2 (same session as c1) started only after c1 ended
      expect(at("c2", "start")).toBeGreaterThanOrEqual(at("c1", "end"));
      expect(broker.results.get("c1")?.result).toContain("done");
      expect(broker.results.get("g1")?.result).toContain("done");
      expect(broker.results.get("c2")?.result).toContain("done");
    } finally {
      controller.abort();
      broker.server.stop(true);
    }
  });

  test("an unsupported reviewer becomes a job error, not a worker crash", async () => {
    const broker = startMockBroker([
      { id: "u1", reviewer: "mystery-live", prompt: "p", cwd: "/repo/a" },
      { id: "ok1", reviewer: "claude-live", prompt: "p", cwd: "/repo/a" },
    ]);
    const sessionFor = (reviewer: string): ReviewerSession => {
      if (!liveCliKindFor(reviewer)) throw new Error(`reviewer '${reviewer}' has no live CLI mapping`);
      return { deliver: async () => "patch is correct" };
    };
    const controller = new AbortController();
    try {
      const run = runReviewerWorker({ brokerUrl: broker.url, sessionFor, signal: controller.signal, pollIntervalMs: 5 });
      await Bun.sleep(120);
      controller.abort();
      await run;
      expect(broker.results.get("u1")?.error).toContain("no live CLI mapping");
      expect(broker.results.get("ok1")?.result).toContain("patch is correct"); // worker kept going
    } finally {
      controller.abort();
      broker.server.stop(true);
    }
  });

  test("LIVE_CLI_KINDS maps each built-in live adapter to its CLI launch + reset + prompt dir", () => {
    expect(Object.keys(LIVE_CLI_KINDS).sort()).toEqual(["claude-live", "codex-live", "gemini-live"]);

    const claude = liveCliKindFor("claude-live")!;
    expect(claude.launchCommand("/repo", claude.promptDir("/repo"))[0]).toBe("claude");
    expect(claude.launchCommand("/repo", claude.promptDir("/repo"))).toContain("--add-dir");

    const gemini = liveCliKindFor("gemini-live")!;
    expect(gemini.promptDir("/repo")).toBe("/repo/.peer-review"); // inside the trusted cwd
    const gemCmd = gemini.launchCommand("/repo", gemini.promptDir("/repo"));
    expect(gemCmd[0]).toBe("gemini");
    expect(gemCmd).not.toContain("--include-directories"); // avoids the second trust prompt

    const codex = liveCliKindFor("codex-live")!;
    expect(codex.launchCommand("/repo", codex.promptDir("/repo"))[0]).toBe("codex");
    expect(codex.clearCommand).toBe("/new");

    expect(liveCliKindFor("unknown-live")).toBeNull();
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

  test("sessionNameFor is stable, tmux-safe, distinct per path AND per CLI kind", () => {
    const a = sessionNameFor("peer-reviewer", "claude", "/Users/me/work/repo-a");
    const b = sessionNameFor("peer-reviewer", "claude", "/Users/me/work/repo-b");
    const g = sessionNameFor("peer-reviewer", "gemini", "/Users/me/work/repo-a");
    expect(a).toBe(sessionNameFor("peer-reviewer", "claude", "/Users/me/work/repo-a")); // stable
    expect(a).not.toBe(b); // distinct per path
    expect(a).not.toBe(g); // distinct per CLI kind in the same repo
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/); // tmux-safe
    expect(a).toContain("repo-a");
    expect(a).toContain("claude");
  });
});

describe("review extraction from a captured pane", () => {
  // The echoed instruction line, as it appears in the pane: contains BOTH markers once.
  const echoLine = (jobId: string) =>
    `> Read the file /tmp/peer/${jobId}.md ... Print exactly ${beginMarkerFor(jobId)} on a line by itself, then the full review as plain text, then exactly ${doneMarkerFor(jobId)} on the final line.`;

  test("returns null when the markers are absent (no review yet)", () => {
    expect(extractReviewFromCapture("just booting up\n> ", "job-1")).toBeNull();
  });

  test("returns null when only the echoed instruction is present (still running)", () => {
    // The echo contains BEGIN then DONE in order — must NOT be mistaken for a completed review.
    const pane = `${echoLine("job-1")}\n\nthinking...`;
    expect(extractReviewFromCapture(pane, "job-1")).toBeNull();
  });

  test("returns null when only the BEGIN marker has been emitted (body still streaming)", () => {
    const pane = [echoLine("job-2"), "", beginMarkerFor("job-2"), "No findings so far..."].join("\n");
    expect(extractReviewFromCapture(pane, "job-2")).toBeNull();
  });

  test("extracts only the body between the EMITTED markers, excluding preamble and tool chrome", () => {
    const pane = [
      "│ " + echoLine("job-7"),
      "│",
      "│ I'll read the job file and review the change.", // preamble narration — must be excluded
      "│   Read 1 file (ctrl+o to expand)", // tool-status chrome — must be excluded
      "│ ⏺ " + beginMarkerFor("job-7"),
      "│ No findings. The change correctly clamps the timeout.",
      "│ patch is correct",
      "│ " + doneMarkerFor("job-7"),
      "╰──────────────────────────────────────────╯",
    ].join("\n");
    const review = extractReviewFromCapture(pane, "job-7");
    expect(review).toContain("No findings");
    expect(review).toContain("patch is correct");
    expect(review).not.toContain("I'll read the job file"); // begin marker excludes the preamble
    expect(review).not.toContain("Read 1 file");
    expect(review).not.toContain(beginMarkerFor("job-7"));
    expect(review).not.toContain(doneMarkerFor("job-7"));
  });

  test("stale markers from a different job do not match this job", () => {
    const pane = `previous review ... ${beginMarkerFor("old-job")}\nbody\n${doneMarkerFor("old-job")}\nfresh prompt for the new job`;
    expect(extractReviewFromCapture(pane, "job-9")).toBeNull();
  });

  // Regression: the Claude TUI/markdown renderer mangles bracketed markers (e.g. `<<<x>>>` is
  // rendered as `<<x>>`), which silently broke live marker matching. Markers must use only
  // letters/digits/hyphens/underscores so they survive rendering byte-for-byte.
  test("both markers contain no markdown/TUI-special characters", () => {
    expect(beginMarkerFor("job-1")).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(doneMarkerFor("job-1")).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  // Regression: the Gemini TUI renders responses with leading line numbers, which leaked into
  // the extracted review ("2 I am Gemini..."). Strip only under the conservative signature.
  test("strips Gemini's rendered line numbers but never genuine content", () => {
    expect(stripRenderedLineNumbers(" 2 I am Gemini, trained by Google.\n 3 The channel works.")).toBe(
      "I am Gemini, trained by Google.\nThe channel works.",
    );
    expect(stripRenderedLineNumbers(" 2 Only one numbered line")).toBe(" 2 Only one numbered line"); // single line — left alone
    expect(stripRenderedLineNumbers("No findings.\npatch is correct")).toBe("No findings.\npatch is correct");
    expect(stripRenderedLineNumbers("1. first item\n2. second item")).toBe("1. first item\n2. second item"); // markdown list
    expect(stripRenderedLineNumbers("3 issues found\n2 tests failed")).toBe("3 issues found\n2 tests failed"); // not increasing
  });
});
