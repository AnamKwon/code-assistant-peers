import { afterEach, describe, expect, test } from "bun:test";
import { type BackendBootstrapDeps, bootstrapBackend, reviewViaBroker } from "../shared/broker-client.ts";
import { runReviewCommand } from "../shared/review.ts";

function bootstrapDeps(overrides: Partial<BackendBootstrapDeps> = {}): BackendBootstrapDeps & { spawnCalls: number } {
  let clock = 0;
  const state = {
    brokerHealthy: async () => false,
    spawnBackend: () => {},
    sleep: async () => {},
    now: () => (clock += 100),
    healthWaitMs: 1000,
    pollMs: 100,
    spawnCalls: 0,
  } as BackendBootstrapDeps & { spawnCalls: number };
  Object.assign(state, overrides);
  const userSpawn = state.spawnBackend;
  state.spawnBackend = (cwd: string) => {
    state.spawnCalls++;
    userSpawn(cwd);
  };
  return state;
}

// Mock broker: POST /jobs -> id; GET /jobs/:id -> done with a canned review.
function startMockBroker(reviewText: string) {
  let jobId = "";
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (req.method === "GET" && pathname === "/health") {
        return Response.json({ ok: true }); // healthy => runReviewCommand's autostart is a no-op
      }
      if (req.method === "POST" && pathname === "/jobs") {
        jobId = "mock-1";
        return Response.json({ id: jobId, status: "pending" });
      }
      if (req.method === "GET" && pathname === `/jobs/${jobId}`) {
        return Response.json({ status: "done", result: reviewText });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
}

describe("channel review transport (broker)", () => {
  const prev = process.env.CODE_ASSISTANT_PEERS_BROKER_URL;
  afterEach(() => {
    if (prev === undefined) delete process.env.CODE_ASSISTANT_PEERS_BROKER_URL;
    else process.env.CODE_ASSISTANT_PEERS_BROKER_URL = prev;
  });

  test("reviewViaBroker returns the reviewer reply on success", async () => {
    const server = startMockBroker("MOCK REVIEW: No findings.");
    process.env.CODE_ASSISTANT_PEERS_BROKER_URL = `http://127.0.0.1:${server.port}`;
    try {
      const reply = await reviewViaBroker("claude-live", "review this", 5000, "", 25);
      expect(reply.ok).toBe(true);
      expect(reply.text).toContain("MOCK REVIEW");
    } finally {
      server.stop(true);
    }
  });

  test("reviewViaBroker fails gracefully when the broker is unreachable", async () => {
    process.env.CODE_ASSISTANT_PEERS_BROKER_URL = "http://127.0.0.1:1";
    const reply = await reviewViaBroker("claude-live", "review this", 400, "", 25);
    expect(reply.ok).toBe(false);
    expect(reply.error).toBeTruthy();
  });

  test("bootstrapBackend does not spawn when the broker is already healthy", async () => {
    const deps = bootstrapDeps({ brokerHealthy: async () => true });
    await bootstrapBackend(process.cwd(), deps);
    expect(deps.spawnCalls).toBe(0);
  });

  test("bootstrapBackend spawns once and returns when the broker comes up", async () => {
    let healthChecks = 0;
    const deps = bootstrapDeps({
      // first check (pre-spawn) unhealthy, then healthy after the spawn + one poll
      brokerHealthy: async () => ++healthChecks > 1,
    });
    await bootstrapBackend(process.cwd(), deps);
    expect(deps.spawnCalls).toBe(1);
  });

  test("bootstrapBackend spawns once then proceeds even if the broker never answers", async () => {
    const deps = bootstrapDeps({ brokerHealthy: async () => false, healthWaitMs: 500, pollMs: 100 });
    await bootstrapBackend(process.cwd(), deps); // resolves (does not hang) so the caller can fall back
    expect(deps.spawnCalls).toBe(1);
  });

  test("runReviewCommand routes the claude-live adapter through the broker (no spawn)", async () => {
    const server = startMockBroker("MOCK REVIEW via broker.");
    process.env.CODE_ASSISTANT_PEERS_BROKER_URL = `http://127.0.0.1:${server.port}`;
    try {
      const result = await runReviewCommand("claude-live", process.cwd(), "review this");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("MOCK REVIEW via broker");
      expect(result.command).toEqual(["<broker>", "claude-live"]);
    } finally {
      server.stop(true);
    }
  });
});
