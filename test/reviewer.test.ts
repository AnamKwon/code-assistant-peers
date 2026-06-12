import { describe, expect, test } from "bun:test";
import {
  LIVE_CLI_KINDS,
  type ReviewerSession,
  acquireWorkerLock,
  RateLimitError,
  beginMarkerFor,
  claimNextJob,
  detectRateLimit,
  doneMarkerFor,
  extractReviewFromCapture,
  codexSessionIdFromRolloutPath,
  findCodexSessionId,
  liveCliKindFor,
  parseGeminiSessionIndex,
  parseResetAtMs,
  runReviewerWorker,
  sessionEnvPrefix,
  sessionNameFor,
  stripRenderedLineNumbers,
} from "../broker/reviewer.ts";

interface MockJob {
  id: string;
  reviewer: string;
  prompt: string;
  cwd?: string;
  model?: string | null;
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
        return Response.json(job ? { id: job.id, reviewer: job.reviewer, prompt: job.prompt, cwd: job.cwd ?? "", model: job.model ?? null } : { id: null });
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

  test("the job's requested model is passed through to the session deliver", async () => {
    const broker = startMockBroker([
      { id: "m1", reviewer: "claude-live", prompt: "p", cwd: "/repo/a", model: "opus" },
      { id: "m2", reviewer: "claude-live", prompt: "p", cwd: "/repo/a" }, // no model -> null
    ]);
    const seen: Array<{ job: string; model: string | null | undefined }> = [];
    const session: ReviewerSession = {
      deliver: async (_p, jobId, _s, model) => {
        seen.push({ job: jobId, model });
        return "ok";
      },
    };
    const controller = new AbortController();
    try {
      const run = runReviewerWorker({ brokerUrl: broker.url, sessionFor: () => session, signal: controller.signal, pollIntervalMs: 5 });
      await Bun.sleep(120);
      controller.abort();
      await run;
      expect(seen).toEqual([{ job: "m1", model: "opus" }, { job: "m2", model: null }]);
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

  test("a rate-limited reviewer is cooled down: later jobs are skipped without retry", async () => {
    const broker = startMockBroker([
      { id: "r1", reviewer: "claude-live", prompt: "p", cwd: "/repo/a" }, // hits the limit
      { id: "r2", reviewer: "claude-live", prompt: "p", cwd: "/repo/a" }, // same reviewer -> skipped
      { id: "ok", reviewer: "gemini-live", prompt: "p", cwd: "/repo/a" }, // different reviewer -> runs
    ]);
    let claudeDelivers = 0;
    const sessionFor = (reviewer: string): ReviewerSession => ({
      deliver: async () => {
        if (reviewer === "claude-live") {
          claudeDelivers++;
          throw new RateLimitError("reviewer hit its usage/rate limit: usage limit reached", null);
        }
        return "patch is correct";
      },
    });
    const controller = new AbortController();
    try {
      const run = runReviewerWorker({ brokerUrl: broker.url, sessionFor, signal: controller.signal, pollIntervalMs: 5, rateLimitCooldownMs: 60_000 });
      await Bun.sleep(160);
      controller.abort();
      await run;
      expect(claudeDelivers).toBe(1); // r1 tried once; r2 skipped WITHOUT calling deliver again
      expect(broker.results.get("r1")?.error).toContain("usage/rate limit");
      expect(broker.results.get("r2")?.error).toContain("rate-limited");
      expect(broker.results.get("ok")?.result).toContain("patch is correct"); // other reviewer unaffected
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

  test("LIVE_CLI_KINDS maps each built-in live adapter to launch/resume commands + strategies", () => {
    expect(Object.keys(LIVE_CLI_KINDS).sort()).toEqual(["claude-live", "codex-live", "gemini-live"]);

    const claude = liveCliKindFor("claude-live")!;
    const claudeLaunch = claude.launchCommand("/repo", claude.promptDir("/repo"), "uuid-1", "opus");
    expect(claudeLaunch[0]).toBe("claude");
    expect(claudeLaunch).toContain("--add-dir");
    expect(claudeLaunch.join(" ")).toContain("--session-id uuid-1"); // assigned id baked into launch
    expect(claudeLaunch.join(" ")).toContain("--model opus"); // first-launch model baked in
    const claudeResume = claude.resumeCommand(claude.promptDir("/repo"), "uuid-1", "sonnet");
    expect(claudeResume.join(" ")).toContain("--resume uuid-1");
    expect(claudeResume.join(" ")).toContain("--model sonnet");
    expect(claude.idStrategy).toBe("assign");

    const gemini = liveCliKindFor("gemini-live")!;
    expect(gemini.promptDir("/repo")).toBe("/repo/.peer-review"); // inside the trusted cwd
    const gemCmd = gemini.launchCommand("/repo", gemini.promptDir("/repo"), "uuid-2", null);
    expect(gemCmd[0]).toBe("gemini");
    expect(gemCmd).not.toContain("--include-directories"); // avoids the second trust prompt
    expect(gemCmd.join(" ")).toContain("--session-id uuid-2");
    expect(gemini.resumeCommand("/p", "4", "flash").join(" ")).toContain("--resume 4"); // list INDEX, not uuid
    expect(gemini.resumeBy).toBe("gemini-index");

    const codex = liveCliKindFor("codex-live")!;
    const cxLaunch = codex.launchCommand("/repo", codex.promptDir("/repo"), null, "gpt-5.4-mini");
    expect(cxLaunch[0]).toBe("codex");
    expect(cxLaunch).not.toContain("--session-id"); // codex cannot assign an id at launch
    expect(cxLaunch.join(" ")).toContain("-m gpt-5.4-mini");
    const cxResume = codex.resumeCommand("/p", "rollout-uuid", "gpt-5.4");
    expect(cxResume.slice(0, 3)).toEqual(["codex", "resume", "rollout-uuid"]);
    expect(cxResume.join(" ")).toContain("model=");
    expect(codex.idStrategy).toBe("capture");
    expect(codex.clearCommand).toBe("/new");

    expect(liveCliKindFor("unknown-live")).toBeNull();
  });

  test("codex session id helpers: filename parsing + marker-based capture", async () => {
    expect(codexSessionIdFromRolloutPath("/x/2026/06/12/rollout-2026-06-12T09-41-24-019eb946-ca67-7221-8e60-9fd5d450f572.jsonl"))
      .toBe("019eb946-ca67-7221-8e60-9fd5d450f572");
    expect(codexSessionIdFromRolloutPath("/x/not-a-rollout.txt")).toBeNull();

    const { mkdtemp, mkdir: mkdirP, writeFile: writeF, rm: rmP } = await import("node:fs/promises");
    const { tmpdir: tmp } = await import("node:os");
    const { join: j } = await import("node:path");
    const dir = await mkdtemp(j(tmp(), "codex-sessions-"));
    try {
      await mkdirP(j(dir, "2026/06/12"), { recursive: true });
      const ours = j(dir, "2026/06/12", "rollout-2026-06-12T10-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl");
      const theirs = j(dir, "2026/06/12", "rollout-2026-06-12T11-00-00-11111111-2222-3333-4444-555555555555.jsonl");
      await writeF(ours, JSON.stringify({ text: "instruction with PEER-REVIEW-BEGIN-job-42 marker" }) + "\n");
      await writeF(theirs, JSON.stringify({ text: "the user own unrelated session" }) + "\n");
      // finds OURS by marker even though THEIRS is newer (never picks most-recent blindly)
      expect(await findCodexSessionId(dir, "PEER-REVIEW-BEGIN-job-42")).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
      expect(await findCodexSessionId(dir, "PEER-REVIEW-BEGIN-job-99")).toBeNull();
      // sinceMs floor excludes rollouts older than the session launch (future floor -> no match)
      expect(await findCodexSessionId(dir, "PEER-REVIEW-BEGIN-job-42", Date.now() + 600_000)).toBeNull();
    } finally {
      await rmP(dir, { recursive: true, force: true });
    }
  });

  test("sessionEnvPrefix isolates the session env to the allowlist", () => {
    const prefix = sessionEnvPrefix({
      PATH: "/usr/bin",
      HOME: "/Users/me",
      TERM: "tmux-256color",
      CLAUDECODE: "1", // nested-session leakage — must NOT pass through
      CLAUDE_CODE_SESSION_ID: "parent-session",
      ANTHROPIC_API_KEY: "sk-secret", // must NOT pass through (subscription auth only)
      CLAUDE_CONFIG_DIR: "/Users/me/.claude-alt", // allowlisted
    } as NodeJS.ProcessEnv);
    expect(prefix.slice(0, 2)).toEqual(["env", "-i"]);
    expect(prefix).toContain("PATH=/usr/bin");
    expect(prefix).toContain("CLAUDE_CONFIG_DIR=/Users/me/.claude-alt");
    expect(prefix).toContain("TERM=tmux-256color");
    expect(prefix.join(" ")).not.toContain("CLAUDECODE");
    expect(prefix.join(" ")).not.toContain("CLAUDE_CODE_SESSION_ID");
    expect(prefix.join(" ")).not.toContain("ANTHROPIC_API_KEY");
  });

  test("gemini session index parsing matches our uuid, never position", () => {
    const listing = [
      "Available sessions for this project (3):",
      "  1. <session_context> something recent... (1 hour ago) [841a449c-14aa-4b1e-8360-2504038181d1]",
      "  2. <session_context> the user own session... (2 hours ago) [51272c1b-25e5-42a7-b6ab-8e77a6749710]",
      "  3. <session_context> ours... (3 hours ago) [03FA3A39-CD84-43c3-9188-7EAE35004BA9]",
    ].join("\n");
    expect(parseGeminiSessionIndex(listing, "03fa3a39-cd84-43c3-9188-7eae35004ba9")).toBe("3"); // case-insensitive
    expect(parseGeminiSessionIndex(listing, "ffffffff-ffff-ffff-ffff-ffffffffffff")).toBeNull();
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
  test("detectRateLimit matches usage/rate-limit notices across CLIs but not normal review text", () => {
    expect(detectRateLimit("...\n  5h limit reached, resets 19:08\n...")).toContain("resets 19:08");
    expect(detectRateLimit("Error: quota exceeded for this project")).toContain("quota exceeded");
    expect(detectRateLimit("429 Too Many Requests")).toBeTruthy();
    expect(detectRateLimit("You have reached your weekly usage limit")).toBeTruthy();
    // normal review content must NOT trip it
    expect(detectRateLimit("No findings. The diff stays within the rate limiter's bounds.")).toBeNull();
    expect(detectRateLimit("patch is correct")).toBeNull();
    // custom extra pattern
    expect(detectRateLimit("PLAN_CAP_HIT code 7", ["plan_cap_hit"])).toBeTruthy();
  });

  test("parseResetAtMs reads an explicit reset time as the next occurrence", () => {
    const noon = new Date("2026-06-12T12:00:00").getTime();
    const at1305 = parseResetAtMs("resets 13:05", noon)!;
    expect(new Date(at1305).getHours()).toBe(13);
    expect(new Date(at1305).getMinutes()).toBe(5);
    // a time already past today rolls to tomorrow
    const at1100 = parseResetAtMs("resets at 11:00", noon)!;
    expect(at1100).toBeGreaterThan(noon);
    expect(parseResetAtMs("no reset here", noon)).toBeNull();
  });

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
