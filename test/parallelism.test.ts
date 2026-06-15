import { expect, test } from "bun:test";
import { runReviewerWorker, type ReviewerSession } from "../broker/reviewer.ts";

function startMockBroker(jobs: any[]) {
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
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  return { server, results, url: `http://127.0.0.1:${server.port}` };
}

test("head-of-line blocking: one busy pair starves another", async () => {
  const MAX_CONCURRENT = 2;
  const broker = startMockBroker([
    { id: "a1", reviewer: "claude-live", prompt: "p", cwd: "repo-a" },
    { id: "a2", reviewer: "claude-live", prompt: "p", cwd: "repo-a" },
    { id: "b1", reviewer: "claude-live", prompt: "p", cwd: "repo-b" },
  ]);

  const startedAt = new Map<string, number>();
  const finishedAt = new Map<string, number>();

  const sessionFor = (reviewer: string, cwd: string): ReviewerSession => {
    return {
      deliver: async (_prompt, jobId) => {
        startedAt.set(jobId, Date.now());
        await Bun.sleep(100);
        finishedAt.set(jobId, Date.now());
        return "ok";
      },
    };
  };

  const controller = new AbortController();
  const run = runReviewerWorker({
    brokerUrl: broker.url,
    sessionFor,
    signal: controller.signal,
    maxConcurrentSessions: MAX_CONCURRENT,
    pollIntervalMs: 10,
  });

  // Wait long enough for all jobs to likely complete if they were parallelized correctly
  await Bun.sleep(500);
  controller.abort();
  await run;
  broker.server.stop();

  console.log("Started at:", startedAt);
  console.log("Finished at:", finishedAt);

  // If parallelization for DIFFERENT pairs works perfectly, b1 should start almost immediately
  // after a1 starts, because b1 and a1 are different pairs.
  // BUT because a2 is claimed and occupies a slot in inFlightClaims, and b1 is behind a2 in the broker queue,
  // b1 won't be claimed until either a1 or a2 finishes.
  
  const a1Start = startedAt.get("a1")!;
  const b1Start = startedAt.get("b1")!;
  
  // If b1 waited for a1 to finish (because a2 took the second slot), then b1Start >= finishedAt.get("a1")
  if (b1Start >= finishedAt.get("a1")!) {
    console.log("CONFIRMED: b1 was blocked by a2 occupying the claim budget.");
  } else {
    console.log("NOT BLOCKED: b1 started before a1 finished.");
  }
});
