import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));

function textFromToolResult(result: any): string {
  return (result.content ?? [])
    .map((item: { type: string; text?: string }) => item.type === "text" ? item.text ?? "" : "")
    .filter(Boolean)
    .join("\n");
}

function parseJsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error(`JSON object not found in text:\n${text}`);
  }
  return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
}

function extractTaskId(text: string): string {
  const match = text.match(/"task_id"\s*:\s*"([^"]+)"/);
  if (!match) throw new Error(`task_id not found in tool output:\n${text}`);
  return match[1];
}

describe("server integration", () => {
  test("reports host-unavailable failures through the MCP tool path", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "cap-host-unavailable-"));
    const transport = new StdioClientTransport({
      command: "bun",
      args: ["server.ts"],
      cwd: PROJECT_ROOT,
      env: {
        HOST_ASSISTANT: "foo",
        PEER_ASSISTANTS: "claude,gemini",
        CODE_ASSISTANT_PEERS_HOME: storeDir,
        CODE_ASSISTANT_PEERS_ASSISTANTS: JSON.stringify({
          foo: {
            command: ["missing-host-cli"],
            prompt_transport: "stdin",
            description: "Broken host assistant used for integration coverage",
          },
        }),
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "integration-test", version: "1.0.0" });

    try {
      await client.connect(transport);

      const startResult = await client.callTool({
        name: "must_call_after_code_changes",
        arguments: {
          prompt: "force the host unavailable preflight path",
        },
      });
      const startText = textFromToolResult(startResult);
      expect(startResult.isError).toBe(false);
      expect(startText).toContain("queued");
      const taskId = extractTaskId(startText);

      const waitResult = await client.callTool({
        name: "wait_for_peer_review",
        arguments: {
          task_id: taskId,
          poll_interval_ms: 100,
          timeout_seconds: 20,
        },
      });
      const waitText = textFromToolResult(waitResult);
      const waitJson = parseJsonObject(waitText);

      expect(waitJson.task_id).toBe(taskId);
      expect(waitJson.status).toBe("review_failed");
      expect(waitJson.review_rounds).toBe(1);
      expect(waitJson.latest_round).not.toBeNull();
      const latestRound = waitJson.latest_round as {
        round?: number;
        reviewer?: string;
        exit_code?: number;
        output_preview?: string;
      };
      expect(latestRound.round).toBe(1);
      expect(latestRound.reviewer).toBe("foo");
      expect(latestRound.exit_code).toBe(1);
      expect(String(latestRound.output_preview ?? "")).toContain("Aggregate reviewer foo is not available");
      expect(String(waitJson.next_action ?? "")).toContain("Review failed");
      expect(waitResult.isError).toBe(true);
    } finally {
      await transport.close();
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  test("does not duplicate an active in-process async review", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "cap-active-review-"));
    const transport = new StdioClientTransport({
      command: "bun",
      args: ["server.ts"],
      cwd: PROJECT_ROOT,
      env: {
        HOST_ASSISTANT: "host",
        PEER_ASSISTANT: "peer",
        CODE_ASSISTANT_PEERS_HOME: storeDir,
        CODE_ASSISTANT_PEERS_STALE_REVIEW_MS: "1",
        CODE_ASSISTANT_PEERS_ASSISTANTS: JSON.stringify({
          host: {
            command: ["bun", "--eval", "await new Response(Bun.stdin).text(); console.log('host aggregate')"],
            prompt_transport: "stdin",
          },
          peer: {
            command: ["bun", "--eval", "await new Response(Bun.stdin).text(); await Bun.sleep(250); console.log('No findings.\\npatch is correct')"],
            prompt_transport: "stdin",
          },
        }),
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "integration-test", version: "1.0.0" });

    try {
      await client.connect(transport);

      const startResult = await client.callTool({
        name: "start_peer_review_async",
        arguments: {
          prompt: "exercise active review duplicate prevention",
          mode: "normal",
        },
      });
      const startText = textFromToolResult(startResult);
      const taskId = extractTaskId(startText);

      const duplicateResult = await client.callTool({
        name: "start_peer_review_async",
        arguments: {
          task_id: taskId,
          mode: "normal",
        },
      });
      const duplicateText = textFromToolResult(duplicateResult);
      expect(duplicateText).toContain("No duplicate reviewer process was started.");

      const waitResult = await client.callTool({
        name: "wait_for_peer_review",
        arguments: {
          task_id: taskId,
          poll_interval_ms: 100,
          timeout_seconds: 10,
        },
      });
      const waitJson = parseJsonObject(textFromToolResult(waitResult));
      expect(waitJson.status).toBe("reviewed");
      expect(waitJson.review_rounds).toBe(1);
    } finally {
      await transport.close();
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  test("passes review_models from the MCP tool call into the reviewer command", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "cap-review-models-"));
    const transport = new StdioClientTransport({
      command: "bun",
      args: ["server.ts"],
      cwd: PROJECT_ROOT,
      env: {
        HOST_ASSISTANT: "host",
        PEER_ASSISTANT: "peer",
        CODE_ASSISTANT_PEERS_HOME: storeDir,
        CODE_ASSISTANT_PEERS_ASSISTANTS: JSON.stringify({
          host: {
            command: ["bun", "--eval", "await new Response(Bun.stdin).text(); console.log('host aggregate')"],
            prompt_transport: "stdin",
            model_arg: "--model",
          },
          peer: {
            command: ["bun", "--eval", "await new Response(Bun.stdin).text(); console.log('No findings.\\npatch is correct')"],
            prompt_transport: "stdin",
            model_arg: "--model",
            models: [
              { id: "peer-fast", routing: ["fast"], latency: "low" },
              { id: "peer-deep", routing: ["deep"], quality: "highest" },
            ],
          },
        }),
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "integration-test", version: "1.0.0" });

    try {
      await client.connect(transport);

      const startResult = await client.callTool({
        name: "start_peer_review_async",
        arguments: {
          prompt: "exercise explicit per-reviewer model selection",
          mode: "adversarial",
          focus: "security",
          review_models: {
            peer: "peer-deep",
          },
        },
      });
      const taskId = extractTaskId(textFromToolResult(startResult));

      const waitResult = await client.callTool({
        name: "wait_for_peer_review",
        arguments: {
          task_id: taskId,
          poll_interval_ms: 100,
          timeout_seconds: 10,
        },
      });
      const waitJson = parseJsonObject(textFromToolResult(waitResult));
      expect(waitJson.status).toBe("reviewed");

      const roundResult = await client.callTool({
        name: "get_peer_review_round",
        arguments: {
          task_id: taskId,
          round: 1,
        },
      });
      const round = parseJsonObject(textFromToolResult(roundResult));
      expect(round.reviewer).toBe("peer");
      expect(round.command).toEqual([
        "bun",
        "--eval",
        "await new Response(Bun.stdin).text(); console.log('No findings.\\npatch is correct')",
        "--model",
        "peer-deep",
      ]);
    } finally {
      await transport.close();
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  test("recovers a stale running review after a new server process starts", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "cap-stale-review-"));
    const slowEnv = {
      HOST_ASSISTANT: "host",
      PEER_ASSISTANT: "peer",
      CODE_ASSISTANT_PEERS_HOME: storeDir,
      CODE_ASSISTANT_PEERS_STALE_REVIEW_MS: "1",
      CODE_ASSISTANT_PEERS_ASSISTANTS: JSON.stringify({
        host: {
          command: ["bun", "--eval", "await new Response(Bun.stdin).text(); console.log('host aggregate')"],
          prompt_transport: "stdin",
        },
        peer: {
          command: ["bun", "--eval", "await new Response(Bun.stdin).text(); await Bun.sleep(5000); console.log('late peer')"],
          prompt_transport: "stdin",
        },
      }),
    };
    const fastEnv = {
      ...slowEnv,
      CODE_ASSISTANT_PEERS_ASSISTANTS: JSON.stringify({
        host: {
          command: ["bun", "--eval", "await new Response(Bun.stdin).text(); console.log('host aggregate')"],
          prompt_transport: "stdin",
        },
        peer: {
          command: ["bun", "--eval", "await new Response(Bun.stdin).text(); console.log('No findings.\\npatch is correct')"],
          prompt_transport: "stdin",
        },
      }),
    };

    let firstTransport: StdioClientTransport | null = new StdioClientTransport({
      command: "bun",
      args: ["server.ts"],
      cwd: PROJECT_ROOT,
      env: slowEnv,
      stderr: "pipe",
    });
    const firstClient = new Client({ name: "integration-test", version: "1.0.0" });

    try {
      await firstClient.connect(firstTransport);
      const startResult = await firstClient.callTool({
        name: "start_peer_review_async",
        arguments: {
          prompt: "exercise stale review recovery",
          mode: "normal",
        },
      });
      const taskId = extractTaskId(textFromToolResult(startResult));

      await firstTransport.close();
      firstTransport = null;

      const taskFile = join(storeDir, "tasks", `${taskId}.json`);
      const task = JSON.parse(await readFile(taskFile, "utf8")) as Record<string, unknown>;
      task.status = "running";
      task.updated_at = new Date(0).toISOString();
      await writeFile(taskFile, `${JSON.stringify(task, null, 2)}\n`);
      const db = new Database(join(storeDir, "store.sqlite"));
      try {
        db.prepare("UPDATE tasks SET status = ?, updated_at = ?, task_json = ? WHERE id = ?")
          .run("running", task.updated_at as string, JSON.stringify(task), taskId);
      } finally {
        db.close();
      }

      const secondTransport = new StdioClientTransport({
        command: "bun",
        args: ["server.ts"],
        cwd: PROJECT_ROOT,
        env: fastEnv,
        stderr: "pipe",
      });
      const secondClient = new Client({ name: "integration-test", version: "1.0.0" });
      try {
        await secondClient.connect(secondTransport);
        const recoverResult = await secondClient.callTool({
          name: "start_peer_review_async",
          arguments: {
            task_id: taskId,
            mode: "normal",
          },
        });
        expect(textFromToolResult(recoverResult)).toContain("Recovered stale running review state");

        const waitResult = await secondClient.callTool({
          name: "wait_for_peer_review",
          arguments: {
            task_id: taskId,
            poll_interval_ms: 100,
            timeout_seconds: 10,
          },
        });
        const waitJson = parseJsonObject(textFromToolResult(waitResult));
        expect(waitJson.status).toBe("reviewed");
        expect(waitJson.review_rounds).toBe(1);
      } finally {
        await secondTransport.close();
      }
    } finally {
      if (firstTransport) await firstTransport.close();
      await rm(storeDir, { recursive: true, force: true });
    }
  });
});
