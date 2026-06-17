import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_REVIEWER_GEMINI_ARGS,
  LIVE_CLI_KINDS,
  type ReviewerSession,
  acquireWorkerLock,
  beginMarkerFor,
  buildDefaultReviewerClaudeArgs,
  buildDefaultReviewerCodexArgs,
  buildGeminiReviewerPolicy,
  claimNextJob,
  createDevLogger,
  defaultDevLogPath,
  devLoggingEnabled,
  doneMarkerFor,
  extractReviewFromCapture,
  extractReviewFromFile,
  isUnknownExistingSession,
  liveSessionUntrackedState,
  liveCliKindFor,
  paneTail,
  resolveReviewerWorkflow,
  runReviewerWorker,
  sessionNameFor,
  shouldPersistLiveSessionState,
  shouldRejectUnknownExistingSession,
  sweepOrphanedOutputFiles,
  wrapLiveReviewPrompt,
} from "../broker/reviewer.ts";

interface MockJob {
  id: string;
  reviewer: string;
  prompt: string;
  cwd?: string;
  model?: string;
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
        return Response.json(job ? { id: job.id, reviewer: job.reviewer, prompt: job.prompt, cwd: job.cwd ?? "", model: job.model ?? "" } : { id: null });
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

  test("passes the claimed job model into the live reviewer session", async () => {
    const broker = startMockBroker([{ id: "job-model", reviewer: "codex-live", prompt: "review", model: "gpt-5.5" }]);
    let deliveredModel: string | null | undefined;
    const session: ReviewerSession = {
      deliver: async (_prompt, _jobId, _signal, model) => {
        deliveredModel = model;
        return "patch is correct";
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
      expect(deliveredModel).toBe("gpt-5.5");
      expect(broker.results.get("job-model")?.result).toContain("patch is correct");
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
    expect(codex.launchCommand("/repo", codex.promptDir("/repo")).slice(0, 3)).toContain("codex");
    expect(codex.clearCommand).toBe("/new");

    expect(liveCliKindFor("unknown-live")).toBeNull();
  });

  test("LIVE_CLI_KINDS can launch and resume with explicit model ids", () => {
    const claude = liveCliKindFor("claude-live")!;
    expect(claude.launchCommand("/repo", "/tmp/prompts", "opus", "11111111-1111-4111-8111-111111111111")).toEqual(expect.arrayContaining(["--session-id", "11111111-1111-4111-8111-111111111111", "--model", "opus"]));
    expect(claude.resumeCommand?.("/repo", "/tmp/prompts", "11111111-1111-4111-8111-111111111111", "sonnet")).toEqual(expect.arrayContaining(["--resume", "11111111-1111-4111-8111-111111111111", "--model", "sonnet"]));

    const gemini = liveCliKindFor("gemini-live")!;
    expect(gemini.launchCommand("/repo", "/repo/.peer-review", "gemini-2.5-flash", "22222222-2222-4222-8222-222222222222")).toEqual(expect.arrayContaining(["--session-id", "22222222-2222-4222-8222-222222222222", "--model", "gemini-2.5-flash"]));
    expect(gemini.resumeCommand?.("/repo", "/repo/.peer-review", "22222222-2222-4222-8222-222222222222", "gemini-2.5-pro")).toEqual(expect.arrayContaining(["--resume", "22222222-2222-4222-8222-222222222222", "--model", "gemini-2.5-pro"]));

    const codex = liveCliKindFor("codex-live")!;
    expect(codex.launchCommand("/repo", "/tmp/prompts", "gpt-5.3-codex-spark")).toEqual(expect.arrayContaining(["-m", "gpt-5.3-codex-spark"]));
    expect(codex.resumeCommand?.("/repo", "/tmp/prompts", "019eba36-5fa4-7cc1-b154-097305a7f0f7", "gpt-5.5")).toEqual(expect.arrayContaining(["resume", "019eba36-5fa4-7cc1-b154-097305a7f0f7", "-m", "gpt-5.5"]));
  });

  test("unknown existing tmux sessions reject model switching and do not persist bogus state", () => {
    const unknownExisting = isUnknownExistingSession(true, false, false);
    expect(unknownExisting).toBe(true);
    expect(shouldRejectUnknownExistingSession(unknownExisting, "sonnet")).toBe(true);
    expect(shouldRejectUnknownExistingSession(unknownExisting, null)).toBe(false);
    expect(shouldPersistLiveSessionState(unknownExisting)).toBe(false);
    expect(liveSessionUntrackedState(false, unknownExisting)).toBe(true);
    expect(shouldRejectUnknownExistingSession(liveSessionUntrackedState(true, false), "sonnet")).toBe(true);
    expect(shouldPersistLiveSessionState(liveSessionUntrackedState(true, false))).toBe(false);
    expect(liveSessionUntrackedState(true, false, true)).toBe(false);

    const trackedExisting = isUnknownExistingSession(true, false, true);
    expect(trackedExisting).toBe(false);
    expect(shouldRejectUnknownExistingSession(trackedExisting, "sonnet")).toBe(false);
    expect(shouldPersistLiveSessionState(trackedExisting)).toBe(true);
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

describe("developer live logging", () => {
  test("is disabled by default and does not create a log file", () => {
    const dir = mkdtempSync(join(tmpdir(), "cap-dev-log-disabled-"));
    try {
      const env = {} as NodeJS.ProcessEnv;
      const path = defaultDevLogPath("reviewer", dir);
      createDevLogger("reviewer", env, dir)("event", { ok: true });
      expect(devLoggingEnabled(env)).toBe(false);
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("writes jsonl only when developer logging is enabled", () => {
    const dir = mkdtempSync(join(tmpdir(), "cap-dev-log-enabled-"));
    try {
      const path = join(dir, "events.jsonl");
      const env = { CODE_ASSISTANT_PEERS_DEV_LOG: "1", CODE_ASSISTANT_PEERS_DEV_LOG_PATH: path } as NodeJS.ProcessEnv;
      createDevLogger("reviewer", env, dir)("review_extracted", { reviewer: "codex-live", requestedModel: "gpt-5.4-mini", usedModel: "gpt-5.4-mini" });
      const entry = JSON.parse(readFileSync(path, "utf8").trim()) as { scope: string; event: string; reviewer: string; requestedModel: string; usedModel: string };
      expect(devLoggingEnabled(env)).toBe(true);
      expect(entry.scope).toBe("reviewer");
      expect(entry.event).toBe("review_extracted");
      expect(entry.reviewer).toBe("codex-live");
      expect(entry.requestedModel).toBe("gpt-5.4-mini");
      expect(entry.usedModel).toBe("gpt-5.4-mini");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  test("live prompt without outputFile embeds terminal-print marker requirements", () => {
    const wrapped = wrapLiveReviewPrompt("Original review task", beginMarkerFor("job-wrap"), doneMarkerFor("job-wrap"));
    expect(wrapped).toStartWith("LIVE REVIEW TRANSPORT REQUIREMENTS");
    expect(wrapped).toContain("print the BEGIN marker line formed by concatenating these parts");
    expect(wrapped).toContain("print the DONE marker line formed by concatenating these parts");
    expect(wrapped).toContain("- PEER-REVIEW-BEGIN-");
    expect(wrapped).toContain("- PEER-REVIEW-DONE-");
    expect(wrapped).toContain("- job-wrap");
    expect(wrapped.indexOf("PEER-REVIEW-BEGIN-")).toBeLessThan(wrapped.indexOf("Original review task"));
    expect(wrapped).not.toContain(beginMarkerFor("job-wrap"));
    expect(wrapped).not.toContain(doneMarkerFor("job-wrap"));
  });

  test("live prompt with outputFile instructs shell command and splits markers into parts (no full literal markers)", () => {
    const outputFile = "/tmp/peer-reviewer-prompts/job-wrap-output.md";
    const wrapped = wrapLiveReviewPrompt("Original review task", beginMarkerFor("job-wrap"), doneMarkerFor("job-wrap"), outputFile);
    expect(wrapped).toStartWith("LIVE REVIEW FILE OUTPUT REQUIREMENTS");
    expect(wrapped).toContain(outputFile);
    expect(wrapped).toContain("write_file");
    // Markers must NOT appear as full literal strings (prevent false-positive capture-pane extraction)
    expect(wrapped).not.toContain(beginMarkerFor("job-wrap"));
    expect(wrapped).not.toContain(doneMarkerFor("job-wrap"));
    // But marker PARTS must be present so the model can reconstruct them
    expect(wrapped).toContain("PEER-REVIEW-BEGIN-");
    expect(wrapped).toContain("job-wrap");
    expect(wrapped).toContain("PEER-REVIEW-DONE-");
    expect(wrapped).toContain("Original review task");
  });
});

describe("paneTail (liveness sampling slice)", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

  test("returns the whole capture when it has fewer lines than the limit", () => {
    expect(paneTail("a\nb\nc", 30)).toBe("a\nb\nc");
  });

  test("returns only the last N lines of a long capture", () => {
    const tail = paneTail(lines(1000), 30);
    expect(tail.split("\n")).toHaveLength(30);
    expect(tail.split("\n")[0]).toBe("line 971");
    expect(tail.endsWith("line 1000")).toBe(true);
  });

  test("trailing blank lines do not count as a change (trimmed before slicing)", () => {
    // A flickering trailing newline must produce the SAME tail, so it is not read as 'still working'.
    expect(paneTail("x\ny\nz", 30)).toBe(paneTail("x\ny\nz\n\n  \n", 30));
  });

  test("a ticking elapsed-timer on the last line changes the tail", () => {
    const pane = (secs: number) => [lines(40), `esc to interrupt (${secs}s)`].join("\n");
    expect(paneTail(pane(12), 30)).not.toBe(paneTail(pane(13), 30));
  });
});

describe("extractReviewFromFile", () => {
  test("returns null when file does not exist", async () => {
    expect(await extractReviewFromFile("/tmp/nonexistent-peer-review-output.md", "job-x")).toBeNull();
  });

  test("returns null when file lacks DONE marker (still writing)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "peer-test-"));
    try {
      const file = join(dir, "partial-output.md");
      const jobId = "job-partial";
      writeFileSync(file, `${beginMarkerFor(jobId)}\nsome review content\n`);
      expect(await extractReviewFromFile(file, jobId)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("extracts review body between BEGIN and DONE markers from file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "peer-test-"));
    try {
      const file = join(dir, "output.md");
      const jobId = "job-file-ok";
      writeFileSync(file, `${beginMarkerFor(jobId)}\nNo findings.\npatch is correct\n${doneMarkerFor(jobId)}\n`);
      const review = await extractReviewFromFile(file, jobId);
      expect(review).toContain("No findings.");
      expect(review).toContain("patch is correct");
      expect(review).not.toContain(beginMarkerFor(jobId));
      expect(review).not.toContain(doneMarkerFor(jobId));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns empty string (not null) when both markers are present but body is empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "peer-test-"));
    try {
      const file = join(dir, "empty-output.md");
      const jobId = "job-empty-body";
      writeFileSync(file, `${beginMarkerFor(jobId)}\n${doneMarkerFor(jobId)}\n`);
      const review = await extractReviewFromFile(file, jobId);
      // Must not be null — null means "not ready yet" and causes polling until timeout.
      expect(review).not.toBeNull();
      expect(review).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("sweepOrphanedOutputFiles", () => {
  test("deletes output files older than maxAgeMs and leaves fresh ones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "peer-sweep-"));
    try {
      const old = join(dir, "old-output.md");
      const fresh = join(dir, "fresh-output.md");
      writeFileSync(old, "old");
      writeFileSync(fresh, "fresh");
      // Back-date old file by 3 hours.
      const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
      utimesSync(old, threeHoursAgo, threeHoursAgo);
      await sweepOrphanedOutputFiles(dir, 2 * 60 * 60 * 1000);
      expect(existsSync(old)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveReviewerWorkflow", () => {
  test("defaults to review_only when env var is absent", () => {
    expect(resolveReviewerWorkflow({})).toBe("review_only");
  });

  test("returns peer_fix when CODE_ASSISTANT_PEERS_REVIEWER_WORKFLOW is peer_fix", () => {
    expect(resolveReviewerWorkflow({ CODE_ASSISTANT_PEERS_REVIEWER_WORKFLOW: "peer_fix" })).toBe("peer_fix");
  });

  test("falls back to CODE_ASSISTANT_PEERS_WORKFLOW (set by setup/install for standard --workflow=peer_fix installs)", () => {
    expect(resolveReviewerWorkflow({ CODE_ASSISTANT_PEERS_WORKFLOW: "peer_fix" })).toBe("peer_fix");
  });

  test("CODE_ASSISTANT_PEERS_REVIEWER_WORKFLOW takes precedence over CODE_ASSISTANT_PEERS_WORKFLOW", () => {
    expect(resolveReviewerWorkflow({ CODE_ASSISTANT_PEERS_REVIEWER_WORKFLOW: "review_only", CODE_ASSISTANT_PEERS_WORKFLOW: "peer_fix" })).toBe("review_only");
  });

  test("returns review_only for unknown values", () => {
    expect(resolveReviewerWorkflow({ CODE_ASSISTANT_PEERS_REVIEWER_WORKFLOW: "unknown" })).toBe("review_only");
  });
});

describe("buildDefaultReviewerClaudeArgs", () => {
  test("includes --append-system-prompt and Write(promptDir:*) in allowedTools", () => {
    const args = buildDefaultReviewerClaudeArgs("/tmp/prompt-dir", "review_only");
    expect(args).toContain("--append-system-prompt");
    const allowedIdx = args.indexOf("--allowedTools");
    expect(allowedIdx).toBeGreaterThan(-1);
    const allowedValue = args[allowedIdx + 1];
    expect(allowedValue).toContain("Write(/tmp/prompt-dir:*)");
    expect(allowedValue).toContain("Read");
  });

  test("does not include Write in --disallowedTools", () => {
    const args = buildDefaultReviewerClaudeArgs("/tmp/prompt-dir", "review_only");
    const disallowedIdx = args.indexOf("--disallowedTools");
    expect(disallowedIdx).toBeGreaterThan(-1);
    const disallowedValue = args[disallowedIdx + 1];
    expect(disallowedValue).not.toContain("Write");
    expect(disallowedValue).toContain("Edit");
  });

  test("uses peer_fix system prompt when workflow is peer_fix", () => {
    const reviewOnly = buildDefaultReviewerClaudeArgs("/tmp/p", "review_only");
    const peerFix = buildDefaultReviewerClaudeArgs("/tmp/p", "peer_fix");
    const sysPIdx = reviewOnly.indexOf("--append-system-prompt");
    const sysPFIdx = peerFix.indexOf("--append-system-prompt");
    expect(reviewOnly[sysPIdx + 1]).not.toBe(peerFix[sysPFIdx + 1]);
    expect(peerFix[sysPFIdx + 1]).toContain("peer-fix mode");
  });
});

describe("buildDefaultReviewerCodexArgs", () => {
  test("includes -c instructions=... with system prompt TOML string", () => {
    const args = buildDefaultReviewerCodexArgs("/repo/.peer-review", "review_only");
    const cIdx = args.indexOf("-c");
    expect(cIdx).toBeGreaterThan(-1);
    const value = args[cIdx + 1];
    expect(value).toMatch(/^instructions="/);
    expect(value).toContain("read-only peer code reviewer");
    expect(value).toContain("Do NOT modify");
    expect(value).toContain("BEGIN marker");
  });

  test("uses peer_fix instructions when workflow is peer_fix", () => {
    const reviewOnly = buildDefaultReviewerCodexArgs("/repo/.peer-review", "review_only");
    const peerFix = buildDefaultReviewerCodexArgs("/repo/.peer-review", "peer_fix");
    const roCIdx = reviewOnly.indexOf("-c");
    const pfCIdx = peerFix.indexOf("-c");
    expect(reviewOnly[roCIdx + 1]).not.toBe(peerFix[pfCIdx + 1]);
    expect(peerFix[pfCIdx + 1]).toContain("peer-fix mode");
  });

  test("includes --sandbox workspace-write and -a never (codex --add-dir ignored in read-only)", () => {
    // NOTE: codex ignores --add-dir when sandbox=read-only ("effective permissions do not allow
    // additional writable roots"), so workspace-write is the only viable option for file output.
    const args = buildDefaultReviewerCodexArgs("/repo/.peer-review", "review_only");
    expect(args[args.indexOf("--sandbox") + 1]).toBe("workspace-write");
    expect(args[args.indexOf("-a") + 1]).toBe("never");
    expect(args).not.toContain("--add-dir");
  });

  test("instructions TOML string has no unescaped double-quotes or raw newlines", () => {
    const args = buildDefaultReviewerCodexArgs("/repo/.peer-review", "review_only");
    const value = args[args.indexOf("-c") + 1];
    const inner = value.slice('instructions="'.length, -1);
    expect(inner).not.toMatch(/\n/);
    expect(inner).not.toMatch(/(?<!\\)"/);
  });
});

describe("gemini-live and codex-live kind configuration", () => {
  test("gemini-live default args use approval-mode auto_edit and block MCP servers", () => {
    // auto_edit auto-approves write_file without dialogs; admin policy adds DENY for shell,
    // giving a hard boundary: no shell execution, write_file only to .peer-review/.
    expect(DEFAULT_REVIEWER_GEMINI_ARGS).toContain("auto_edit");
    expect(DEFAULT_REVIEWER_GEMINI_ARGS).not.toContain("plan");
    expect(DEFAULT_REVIEWER_GEMINI_ARGS).not.toContain("yolo");
    expect(DEFAULT_REVIEWER_GEMINI_ARGS).toContain("--allowed-mcp-server-names");
  });

  test("buildGeminiReviewerPolicy includes run_shell_command deny rule for shell security", () => {
    const policy = buildGeminiReviewerPolicy("/repo/.peer-review");
    expect(policy).toContain("run_shell_command");
    expect(policy).toContain("deny");
    // Shell deny priority (600) must be higher than allow (500) and file deny (100)
    expect(policy.indexOf("run_shell_command")).toBeGreaterThan(-1);
  });

  test("gemini-live kind has useOutputFile=true", () => {
    expect(LIVE_CLI_KINDS["gemini-live"].useOutputFile).toBe(true);
  });

  test("codex-live kind has useOutputFile=true", () => {
    expect(LIVE_CLI_KINDS["codex-live"].useOutputFile).toBe(true);
  });

  test("codex-live uses .peer-review promptDir (workspace-accessible)", () => {
    const dir = LIVE_CLI_KINDS["codex-live"].promptDir("/repo/path");
    expect(dir).toBe("/repo/path/.peer-review");
  });

  test("gemini-live uses .peer-review promptDir", () => {
    const dir = LIVE_CLI_KINDS["gemini-live"].promptDir("/repo/path");
    expect(dir).toBe("/repo/path/.peer-review");
  });

  test("codex-live launchCommand uses env CODEX_HOME prefix, contains codex, workspace-write, -a never", () => {
    const cmd = LIVE_CLI_KINDS["codex-live"].launchCommand("/cwd", "/cwd/.peer-review");
    // Command starts with ["env", "CODEX_HOME=...", "codex", ...]
    expect(cmd[0]).toBe("env");
    expect(cmd[1]).toContain("CODEX_HOME=");
    expect(cmd[2]).toBe("codex");
    expect(cmd[cmd.indexOf("--sandbox") + 1]).toBe("workspace-write");
    expect(cmd[cmd.indexOf("-a") + 1]).toBe("never");
  });

  test("gemini-live launchCommand includes --admin-policy pointing to reviewer-policy.toml", () => {
    const cmd = LIVE_CLI_KINDS["gemini-live"].launchCommand("/cwd", "/cwd/.peer-review");
    expect(cmd[0]).toBe("gemini");
    expect(cmd).toContain("--admin-policy");
    expect(cmd[cmd.indexOf("--admin-policy") + 1]).toBe("/cwd/.peer-review/reviewer-policy.toml");
  });

  test("gemini-live kind has policyContent that generates TOML with promptDir-scoped allow rule", () => {
    const kind = LIVE_CLI_KINDS["gemini-live"];
    expect(kind.policyContent).toBeDefined();
    const policy = kind.policyContent!("/cwd/.peer-review");
    expect(policy).toContain("write_file");
    expect(policy).toContain("allow");
    expect(policy).toContain("deny");
    expect(policy).toContain(".peer-review");
    expect(policy).toContain("priority = 500");
    // Verify the regex correctly allows only flat files inside .peer-review/
    const match = policy.match(/argsPattern = "([^"\\]|\\.)+"/);
    expect(match).not.toBeNull();
    const rawPattern = match![0].slice('argsPattern = "'.length, -1);
    const pattern = rawPattern.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    expect(new RegExp(pattern).test(`{"file_path":"/cwd/.peer-review/job-output.md","content":""}`)).toBe(true);
    expect(new RegExp(pattern).test(`{"file_path":"/cwd/src/main.ts","content":""}`)).toBe(false);
  });

  test("claude-live kind has useOutputFile=true", () => {
    expect(LIVE_CLI_KINDS["claude-live"].useOutputFile).toBe(true);
  });

  test("claude-live and gemini-live have initialSessionId (used as freshSessionId for new sessions)", () => {
    // freshSessionId=kind.initialSessionId ensures new sessions always start with a fresh UUID,
    // not the persisted one which can cause slow startup due to old conversation history loading.
    expect(LIVE_CLI_KINDS["claude-live"].initialSessionId).toBeDefined();
    expect(LIVE_CLI_KINDS["gemini-live"].initialSessionId).toBeDefined();
    // Each call produces a unique UUID.
    const id1 = LIVE_CLI_KINDS["claude-live"].initialSessionId!();
    const id2 = LIVE_CLI_KINDS["claude-live"].initialSessionId!();
    expect(id1).not.toBe(id2);
  });
});

describe("buildGeminiReviewerPolicy", () => {
  test("generates valid TOML with allow (priority 500) for promptDir and deny (priority 100) for rest", () => {
    const policy = buildGeminiReviewerPolicy("/repo/.peer-review");
    expect(policy).toContain("write_file");
    expect(policy).toContain("allow");
    expect(policy).toContain("deny");
    expect(policy).toContain("priority = 500");
    expect(policy).toContain("priority = 100");
    expect(policy).toContain(".peer-review");
  });

  test("dots in promptDir are regex-escaped so the allow rule matches literal dot paths", () => {
    const policy = buildGeminiReviewerPolicy("/my.project/.peer-review");
    const match = policy.match(/argsPattern = "([^"\\]|\\.)+"/);
    expect(match).not.toBeNull();
    const rawPattern = match![0].slice('argsPattern = "'.length, -1);
    const pattern = rawPattern.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    // An output file inside the promptDir must match.
    const validArgs = `{"file_path":"/my.project/.peer-review/job-output.md","content":""}`;
    expect(new RegExp(pattern).test(validArgs)).toBe(true);
    // A file that looks the same but with a digit instead of a dot (regex bug check) must NOT.
    const wrongDot = `{"file_path":"/myXproject/Xpeer-review/job-output.md","content":""}`;
    expect(new RegExp(pattern).test(wrongDot)).toBe(false);
  });

  test("argsPattern defends against content-injection, sibling paths, and all traversal variants", () => {
    const policy = buildGeminiReviewerPolicy("/repo/.peer-review");
    const match = policy.match(/argsPattern = "([^"\\]|\\.)+"/);
    expect(match).not.toBeNull();
    const rawPattern = match![0].slice('argsPattern = "'.length, -1);
    // Unescape TOML escapes to get the actual regex string the policy engine will use.
    const pattern = rawPattern.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    expect(pattern.startsWith("^")).toBe(true);

    // Valid: flat filename directly in promptDir.
    const valid = `{"file_path":"/repo/.peer-review/uuid-abc-output.md","content":"review body"}`;
    expect(new RegExp(pattern).test(valid)).toBe(true);

    // Content injection: file_path targets .env; path appears in content only — must NOT match.
    const injection = `{"file_path":"/repo/.env","content":"... \\"file_path\\":\\"/repo/.peer-review/pwned\\" ..."}`;
    expect(new RegExp(pattern).test(injection)).toBe(false);

    // Sibling file sharing the prefix must NOT match.
    expect(new RegExp(pattern).test(`{"file_path":"/repo/.peer-review.ts","content":""}`)).toBe(false);

    // Direct traversal: .peer-review/../src/pwned.ts — blocked because "/" after ".." fails [a-zA-Z0-9._-]*.
    expect(new RegExp(pattern).test(`{"file_path":"/repo/.peer-review/../src/pwned.ts","content":""}`)).toBe(false);

    // Nested traversal: .peer-review/sub/../../src — also blocked by "/" in the path.
    expect(new RegExp(pattern).test(`{"file_path":"/repo/.peer-review/sub/../../src/pwned.ts","content":""}`)).toBe(false);
  });

  test("deny rule has no argsPattern (catches all other paths)", () => {
    const policy = buildGeminiReviewerPolicy("/repo/.peer-review");
    const lines = policy.split("\n");
    const denyRuleStart = lines.findIndex((l) => l.includes('decision = "deny"'));
    const denyBlock = lines.slice(Math.max(0, denyRuleStart - 5), denyRuleStart + 3).join("\n");
    expect(denyBlock).not.toContain("argsPattern");
  });
});

describe("file-based delivery end-to-end (simulated gemini/codex writing output file)", () => {
  // Tests the complete flow:
  //   wrapLiveReviewPrompt embeds outputFile path
  //   → reviewer CLI writes to outputFile (simulated here by writeFileSync)
  //   → extractReviewFromFile reads it back
  //   → worker delivers the result to the broker
  test("outputFile path is embedded in the prompt file and extractable after write", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "peer-repo-"));
    try {
      const promptDir = join(repoDir, ".peer-review");
      mkdirSync(promptDir, { recursive: true });
      const jobId = "e2e-file-job";
      const outputFile = join(promptDir, `${jobId}-output.md`);

      // Step 1: wrapLiveReviewPrompt with outputFile contains the file path in the instruction.
      const wrapped = wrapLiveReviewPrompt(
        "review the change",
        beginMarkerFor(jobId),
        doneMarkerFor(jobId),
        outputFile,
      );
      expect(wrapped).toContain(outputFile);
      expect(wrapped).toContain("write_file");

      // Step 2: Reviewer CLI (gemini/codex) writes the output file.
      writeFileSync(
        outputFile,
        `${beginMarkerFor(jobId)}\nNo findings. patch is correct\n${doneMarkerFor(jobId)}\n`,
      );

      // Step 3: extractReviewFromFile reads the result back.
      const review = await extractReviewFromFile(outputFile, jobId);
      expect(review).toContain("No findings");
      expect(review).toContain("patch is correct");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test("worker loop delivers file-based review to broker when session returns extracted content", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "peer-repo-"));
    try {
      const promptDir = join(repoDir, ".peer-review");
      mkdirSync(promptDir, { recursive: true });

      // A mock session that replicates what TmuxCliSession does when useOutputFile=true:
      // it receives the prompt (which contains the outputFile path), writes the review to that
      // file, then polls and returns the extracted content — exactly what gemini/codex would do.
      const session: ReviewerSession = {
        deliver: async (_prompt, jobId) => {
          const outputFile = join(promptDir, `${jobId}-output.md`);
          writeFileSync(
            outputFile,
            `${beginMarkerFor(jobId)}\nNo findings. patch is correct\n${doneMarkerFor(jobId)}\n`,
          );
          const review = await extractReviewFromFile(outputFile, jobId);
          if (!review && review !== "") throw new Error("extractReviewFromFile returned null");
          return review!;
        },
      };

      const broker = startMockBroker([{ id: "broker-file-job", reviewer: "gemini-live", prompt: "review this" }]);
      try {
        await runReviewerWorker({
          brokerUrl: broker.url,
          sessionFor: () => session,
          signal: new AbortController().signal,
          once: true,
          pollIntervalMs: 10,
        });
        const result = broker.results.get("broker-file-job");
        expect(result?.result).toContain("No findings");
        expect(result?.result).toContain("patch is correct");
      } finally {
        broker.server.stop();
      }
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
