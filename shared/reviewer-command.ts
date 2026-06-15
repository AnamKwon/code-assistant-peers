import type { AssistantAdapter, AssistantHost } from "./types.ts";
import { getAssistantAdapter } from "./assistants.ts";
import { ensureChannelBackend, reviewViaBroker } from "./broker-client.ts";
import { spawnWithTimeout } from "./process.ts";
import { REVIEWER_SYSTEM_PROMPT } from "./review-prompts.ts";
import { parseSerenaCommand } from "./semantic.ts";

const ARGV_PROMPT_BUDGET = parseInt(process.env.CODE_ASSISTANT_PEERS_ARGV_PROMPT_BUDGET ?? "60000", 10);
const DEFAULT_REVIEW_COMMAND_TIMEOUT_MS = 600000;
const DEFAULT_REVIEW_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "TERM",
  "TMPDIR",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
];

export function buildReviewCommand(reviewer: AssistantHost, model?: string | null): string[] {
  const adapter = getAssistantAdapter(reviewer);
  let command = adapter.command.map((part) => part === "{system_prompt}" ? REVIEWER_SYSTEM_PROMPT : part);
  command = insertModelArg(command, adapter, model);
  if (reviewer !== "claude" && reviewer !== "claude-live") return command;

  const serenaCommand = parseSerenaCommand(process.env.CODE_ASSISTANT_PEERS_SERENA_COMMAND);
  const mcpConfig = JSON.stringify({
    mcpServers: serenaCommand
      ? {
        serena: {
          command: serenaCommand.command,
          args: serenaCommand.args,
        },
      }
      : {},
  });
  const insertAt = command.indexOf("--system-prompt");
  const mcpConfigIndex = insertAt === -1 ? command.length : insertAt;
  return [...command.slice(0, mcpConfigIndex), "--strict-mcp-config", "--mcp-config", mcpConfig, ...command.slice(mcpConfigIndex)];
}

export async function runReviewCommand(
  reviewer: AssistantHost,
  cwd: string,
  prompt: string,
  model?: string | null,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; command: string[] }> {
  const adapter = getAssistantAdapter(reviewer);
  const timeoutMs = resolveReviewCommandTimeoutMs(adapter);

  // Channel transport: route the review to a backgrounded live reviewer session via the broker
  // (subscription pool, no `claude -p`). On any broker/session failure, fall back to spawning
  // the adapter's CLI command over stdin (graceful degradation to the original behavior).
  let transport: "stdin" | "argv" = adapter.prompt_transport === "argv" ? "argv" : "stdin";
  if (adapter.prompt_transport === "channel") {
    // Auto-start the broker + backgrounded reviewer worker if they are not already running, so a
    // host only has to pick `claude-live` — no manual daemon launch. Idempotent + reused.
    await ensureChannelBackend(cwd);
    const reply = await reviewViaBroker(reviewer, prompt, resolveChannelTimeoutMs(), cwd, 1000, model);
    if (reply.ok) {
      const command = model?.trim() ? ["<broker>", reviewer, "--model", model.trim()] : ["<broker>", reviewer];
      return { exitCode: 0, stdout: reply.text, stderr: "", command };
    }
    console.error(`[code-assistant-peers] broker channel unavailable (${reply.error}); falling back to spawning ${reviewer}.`);
    transport = "stdin";
  }

  // Built only after the channel branch so a successful broker route does no wasted command
  // construction.
  const command = buildReviewCommand(reviewer, model);
  const recordedCommand = transport === "argv" ? [...command, "<prompt>"] : command;
  if (model?.trim() && !adapter.model_arg) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Reviewer '${reviewer}' does not declare a model_arg, so review_model cannot be applied to this adapter.`,
      command: recordedCommand,
    };
  }
  const env = buildReviewCommandEnv(adapter);
  const argvPromptBytes = byteLength(prompt);
  if (transport === "argv" && argvPromptBytes > ARGV_PROMPT_BUDGET) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Review prompt is ${argvPromptBytes} bytes, which exceeds CODE_ASSISTANT_PEERS_ARGV_PROMPT_BUDGET=${ARGV_PROMPT_BUDGET} for argv transport. Use stdin transport for large review prompts or lower CODE_ASSISTANT_PEERS_DIFF_BUDGET.`,
      command: recordedCommand,
    };
  }
  const finalCommand = transport === "argv" ? [...command, prompt] : command;
  let result: Awaited<ReturnType<typeof spawnWithTimeout>>;
  try {
    result = await spawnWithTimeout(finalCommand, {
      cwd,
      env,
      stdin: transport === "stdin" ? prompt : null,
      timeoutMs,
    });
  } catch (error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Review command failed to start: ${error instanceof Error ? error.message : String(error)}`,
      command: recordedCommand,
    };
  }

  if (!result.timedOut) {
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, command: recordedCommand };
  }

  const timeoutMessage = `Review command timed out after ${timeoutMs}ms and was terminated. Set CODE_ASSISTANT_PEERS_REVIEW_TIMEOUT_MS to adjust this limit.`;
  return {
    exitCode: 1,
    stdout: result.stdout,
    stderr: result.stderr.trim() ? `${result.stderr.trim()}\n\n${timeoutMessage}` : timeoutMessage,
    command: recordedCommand,
  };
}

export function buildReviewCommandEnv(adapter: AssistantAdapter, sourceEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (sourceEnv.CODE_ASSISTANT_PEERS_PASS_FULL_ENV === "1") {
    return {
      ...Object.fromEntries(Object.entries(sourceEnv).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      CODE_ASSISTANT_PEERS_REVIEWER_SUBPROCESS: "1",
    };
  }
  const allowlist = adapter.env_allowlist ?? DEFAULT_REVIEW_ENV_ALLOWLIST;
  const result: Record<string, string> = {};
  for (const key of allowlist) {
    const value = sourceEnv[key];
    if (value !== undefined) result[key] = value;
  }
  result.CODE_ASSISTANT_PEERS_REVIEWER_SUBPROCESS = "1";
  return result;
}

function insertModelArg(command: string[], adapter: AssistantAdapter, model?: string | null): string[] {
  const normalized = model?.trim();
  if (!normalized || !adapter.model_arg) return command;
  const insertAt = findModelArgInsertIndex(command);
  return [...command.slice(0, insertAt), adapter.model_arg, normalized, ...command.slice(insertAt)];
}

function findModelArgInsertIndex(command: string[]): number {
  const systemPromptIndex = command.indexOf("--system-prompt");
  if (systemPromptIndex !== -1) return systemPromptIndex;
  const promptFlagIndex = command.findIndex((part) => part === "-p" || part === "--prompt");
  if (promptFlagIndex !== -1) return promptFlagIndex;
  const promptIndex = command.findIndex((part) => part === "-" || part === "");
  return promptIndex === -1 ? command.length : promptIndex;
}

function resolveReviewCommandTimeoutMs(adapter: AssistantAdapter): number {
  const configured = parsePositiveInteger(process.env.CODE_ASSISTANT_PEERS_REVIEW_TIMEOUT_MS);
  return configured ?? adapter.timeout_ms ?? DEFAULT_REVIEW_COMMAND_TIMEOUT_MS;
}

// The client-side poll budget for the broker (channel) path. It must be strictly LONGER than the
// reviewer worker's per-review deliver timeout: the worker bounds the review by the same
// CODE_ASSISTANT_PEERS_REVIEW_TIMEOUT_MS (default DEFAULT_REVIEW_COMMAND_TIMEOUT_MS) but its clock
// only starts after the job is claimed and the TUI cold-boots, whereas the client's clock starts
// at submit. Without the extra slack the client would abandon the live session and fall back to
// `claude -p` exactly when the review was about to complete. Deliberately ignores the adapter's
// headless `timeout_ms` (e.g. gemini's 180s) — that bounds the spawn fallback, not the live path.
const CHANNEL_BOOT_SLACK_MS = 120_000;
function resolveChannelTimeoutMs(): number {
  const configured = parsePositiveInteger(process.env.CODE_ASSISTANT_PEERS_REVIEW_TIMEOUT_MS);
  return (configured ?? DEFAULT_REVIEW_COMMAND_TIMEOUT_MS) + CHANNEL_BOOT_SLACK_MS;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
