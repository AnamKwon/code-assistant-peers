import type { AssistantAdapter, AssistantHost } from "./types.ts";
import { homedir } from "node:os";

export const BUILTIN_ASSISTANTS: Record<string, AssistantAdapter> = {
  codex: {
    id: "codex",
    command: ["codex", "exec", "--ignore-user-config", "--ignore-rules", "--sandbox", "read-only", "--skip-git-repo-check", "-"],
    prompt_transport: "stdin",
    description: "OpenAI Codex CLI in read-only exec mode.",
    model_arg: "-m",
    models: [
      { id: "gpt-5.5", quality: "highest", cost: "high", latency: "high", routing: ["deep", "long_context"], description: "Newest frontier model candidate for the highest-risk Codex reviews." },
      { id: "gpt-5.4", quality: "highest", cost: "high", latency: "medium", routing: ["balanced", "long_context"], description: "Frontier model candidate for strong general Codex review and broad contexts." },
      { id: "gpt-5.3-codex", quality: "highest", cost: "high", latency: "high", routing: ["deep", "balanced"], description: "Codex-optimized model candidate for agentic coding and deep code review." },
      { id: "gpt-5.4-mini", quality: "high", cost: "medium", latency: "low", routing: ["fast", "balanced"], description: "Lower-latency GPT-5.4 family model candidate for routine review." },
      { id: "gpt-5.4-nano", quality: "medium", cost: "low", latency: "low", routing: ["fast"], description: "Lowest-cost GPT-5.4 family model candidate for small low-risk diffs." },
    ],
    env_allowlist: [
      "PATH",
      "HOME",
      "USER",
      "SHELL",
      "TERM",
      "TMPDIR",
      "OPENAI_API_KEY",
      "CODEX_HOME",
    ],
  },
  claude: {
    id: "claude",
    command: [
      "claude",
      "-p",
      "--permission-mode",
      "plan",
      "--system-prompt",
      "{system_prompt}",
      "--allowedTools",
      [
        "Read",
        "Grep",
        "Glob",
        "Bash(git status:*)",
        "Bash(git diff:*)",
        "Bash(git show:*)",
        "Bash(git ls-files:*)",
        "mcp__serena__get_symbols_overview",
        "mcp__serena__find_symbol",
        "mcp__serena__find_referencing_symbols",
        "mcp__serena__find_implementations",
        "mcp__serena__get_diagnostics_for_file",
      ].join(","),
      "--disallowedTools",
      [
        "Edit",
        "Write",
        "MultiEdit",
        "NotebookEdit",
        "mcp__serena__create_text_file",
        "mcp__serena__delete_memory",
        "mcp__serena__edit_memory",
        "mcp__serena__insert_after_symbol",
        "mcp__serena__insert_before_symbol",
        "mcp__serena__replace_content",
        "mcp__serena__replace_symbol_body",
        "mcp__serena__rename_symbol",
        "mcp__serena__safe_delete_symbol",
        "mcp__serena__write_memory",
      ].join(","),
    ],
    prompt_transport: "stdin",
    description: "Claude Code print mode with read-only review tools.",
    model_arg: "--model",
    models: [
      { id: "haiku", quality: "medium", cost: "low", latency: "low", routing: ["fast"], description: "Fast review for docs and small low-risk diffs." },
      { id: "sonnet", quality: "high", cost: "medium", latency: "medium", routing: ["balanced"], description: "Balanced default review model." },
      { id: "opus", quality: "highest", cost: "high", latency: "high", routing: ["deep"], description: "Deep review for security, migrations, large diffs, and release gates." },
      { id: "best", quality: "highest", cost: "high", latency: "high", routing: ["deep"], description: "Claude Code alias for the most capable available model." },
      { id: "sonnet[1m]", quality: "high", cost: "high", latency: "medium", routing: ["balanced", "long_context"], description: "Long-context Sonnet alias for large review contexts." },
      { id: "opus[1m]", quality: "highest", cost: "high", latency: "high", routing: ["deep", "long_context"], description: "Long-context Opus alias for broad or truncated review contexts." },
      { id: "opusplan", quality: "highest", cost: "high", latency: "high", routing: ["deep"], description: "Claude Code planning alias that uses Opus for planning and Sonnet for execution." },
    ],
    env_allowlist: [
      "PATH",
      "HOME",
      "USER",
      "SHELL",
      "TERM",
      "TMPDIR",
      "ANTHROPIC_API_KEY",
      "CLAUDE_CONFIG_DIR",
      "CODE_ASSISTANT_PEERS_SERENA_COMMAND",
    ],
  },
  gemini: {
    id: "gemini",
    command: ["gemini", "--skip-trust", "--approval-mode", "plan", "-p", ""],
    prompt_transport: "stdin",
    description: "Gemini CLI headless review mode.",
    timeout_ms: 180000,
    model_arg: "--model",
    models: [
      { id: "auto", quality: "high", cost: "medium", latency: "medium", routing: ["balanced"], description: "Gemini CLI automatic model selection." },
      { id: "pro", quality: "highest", cost: "high", latency: "high", routing: ["deep"], description: "Gemini CLI Pro alias for complex reasoning review." },
      { id: "flash", quality: "high", cost: "low", latency: "low", routing: ["balanced", "fast"], description: "Gemini CLI Flash alias for fast balanced review." },
      { id: "flash-lite", quality: "medium", cost: "low", latency: "low", routing: ["fast"], description: "Gemini CLI Flash Lite alias for small low-risk review." },
      { id: "gemini-3-pro-preview", quality: "highest", cost: "high", latency: "high", routing: ["deep"], description: "Gemini 3 Pro preview model candidate." },
      { id: "gemini-3-flash-preview", quality: "high", cost: "medium", latency: "low", routing: ["balanced", "fast"], description: "Gemini 3 Flash preview model candidate." },
      { id: "gemini-2.5-pro", quality: "highest", cost: "high", latency: "high", routing: ["deep"], description: "Gemini 2.5 Pro model candidate." },
      { id: "gemini-2.5-flash", quality: "high", cost: "low", latency: "low", routing: ["balanced", "fast"], description: "Gemini 2.5 Flash model candidate." },
      { id: "gemini-2.5-flash-lite", quality: "medium", cost: "low", latency: "low", routing: ["fast"], description: "Gemini 2.5 Flash Lite model candidate." },
    ],
    env_allowlist: [
      "PATH",
      "HOME",
      "USER",
      "SHELL",
      "TERM",
      "TMPDIR",
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "GOOGLE_GENAI_USE_VERTEXAI",
      "GOOGLE_CLOUD_PROJECT",
      "GOOGLE_CLOUD_LOCATION",
      "GOOGLE_APPLICATION_CREDENTIALS",
    ],
  },
};

// Claude reviewer routed to a backgrounded interactive Claude session via the broker
// (subscription pool, no `claude -p`). Reuses the `claude` command/env as the fallback that
// runReviewCommand spawns when the broker / live session is unavailable.
BUILTIN_ASSISTANTS["claude-live"] = {
  ...BUILTIN_ASSISTANTS.claude,
  id: "claude-live",
  prompt_transport: "channel",
  description: "Claude review routed to a backgrounded interactive Claude session via the broker (subscription pool, no `claude -p`); falls back to spawning `claude -p` if the broker/session is unavailable.",
};

let cachedCustomConfig: string | undefined;
let cachedRegistry: Record<string, AssistantAdapter> | null = null;

export function loadAssistantRegistry(env = process.env): Record<string, AssistantAdapter> {
  if (env === process.env && cachedRegistry && cachedCustomConfig === env.CODE_ASSISTANT_PEERS_ASSISTANTS) {
    return cachedRegistry;
  }
  const custom = parseCustomAssistants(env.CODE_ASSISTANT_PEERS_ASSISTANTS);
  const registry = { ...BUILTIN_ASSISTANTS, ...custom };
  if (env === process.env) {
    cachedCustomConfig = env.CODE_ASSISTANT_PEERS_ASSISTANTS;
    cachedRegistry = registry;
  }
  return registry;
}

export function normalizeHost(value: string | undefined, registry = loadAssistantRegistry()): AssistantHost {
  const id = normalizeAssistantId(value);
  if (id && registry[id]) return id;
  const available = Object.keys(registry).sort().join(", ");
  throw new Error(`HOST_ASSISTANT must be one of: ${available}`);
}

export function peerFor(
  host: AssistantHost,
  peerValue = process.env.PEER_ASSISTANT,
  peersValue = process.env.PEER_ASSISTANTS,
  registry = loadAssistantRegistry(),
): AssistantHost {
  return peersFor(host, peersValue, peerValue, registry)[0];
}

export function peersFor(
  host: AssistantHost,
  peersValue = process.env.PEER_ASSISTANTS,
  peerValue = process.env.PEER_ASSISTANT,
  registry = loadAssistantRegistry(),
): AssistantHost[] {
  const configuredPeers = parseAssistantList(peersValue);
  if (configuredPeers.length > 0) {
    const peers = unique(configuredPeers).filter((id) => id !== host);
    if (peers.length === 0) throw new Error("PEER_ASSISTANTS must include at least one assistant different from HOST_ASSISTANT");
    for (const peer of peers) {
      if (!registry[peer]) {
        const available = Object.keys(registry).sort().join(", ");
        throw new Error(`PEER_ASSISTANTS contains unknown assistant '${peer}'. Available assistants: ${available}`);
      }
    }
    return peers;
  }

  const configuredPeer = normalizeAssistantId(peerValue);
  if (configuredPeer) {
    if (!registry[configuredPeer]) {
      const available = Object.keys(registry).sort().join(", ");
      throw new Error(`PEER_ASSISTANT must be one of: ${available}`);
    }
    if (configuredPeer === host) throw new Error("PEER_ASSISTANT must differ from HOST_ASSISTANT");
    return [configuredPeer];
  }

  if (host === "claude" && registry.codex) return ["codex"];
  if (host === "codex") {
    const defaultPeers = ["claude", "gemini"].filter((id) => Boolean(registry[id]));
    if (defaultPeers.length > 0) return defaultPeers;
  }

  const fallback = Object.keys(registry).find((id) => id !== host);
  if (!fallback) throw new Error("At least two assistant adapters are required, or PEER_ASSISTANT must be set.");
  return [fallback];
}

export function parsePeerAssistants(value: string | undefined): string[] {
  return parseAssistantList(value);
}

export function getAssistantAdapter(id: AssistantHost, registry = loadAssistantRegistry()): AssistantAdapter {
  const adapter = registry[id];
  if (!adapter) {
    const available = Object.keys(registry).sort().join(", ");
    throw new Error(`Unknown assistant '${id}'. Available assistants: ${available}`);
  }
  return adapter;
}

function parseCustomAssistants(value: string | undefined): Record<string, AssistantAdapter> {
  if (!value?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`CODE_ASSISTANT_PEERS_ASSISTANTS contains invalid JSON: ${message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("CODE_ASSISTANT_PEERS_ASSISTANTS must be a JSON object.");
  }

  const result: Record<string, AssistantAdapter> = {};
  for (const [rawId, rawConfig] of Object.entries(parsed as Record<string, unknown>)) {
    const id = normalizeAssistantId(rawId);
    if (!id) throw new Error(`Invalid assistant id: ${rawId}`);
    if (BUILTIN_ASSISTANTS[id]) {
      if (id === "gemini") continue;
      throw new Error(`Custom assistant '${id}' would override a built-in adapter. Use a distinct id such as '${id}-custom'.`);
    }
    if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
      throw new Error(`Assistant '${id}' config must be an object.`);
    }
    const config = rawConfig as Record<string, unknown>;
    if (!Array.isArray(config.command) || config.command.length === 0) {
      throw new Error(`Assistant '${id}' requires a non-empty command array.`);
    }
    const command = config.command.map((part) => String(part));
    const promptTransport: "stdin" | "argv" | "channel" = config.prompt_transport === "argv"
      ? "argv"
      : config.prompt_transport === "channel"
        ? "channel"
        : "stdin";
    result[id] = {
      id,
      command,
      prompt_transport: promptTransport,
      description: config.description === undefined ? undefined : String(config.description),
      timeout_ms: parseOptionalTimeoutMs(id, config.timeout_ms),
      env_allowlist: parseOptionalEnvAllowlist(id, config.env_allowlist),
      model_arg: config.model_arg === undefined ? undefined : String(config.model_arg),
      models: parseOptionalModels(id, config.models),
    };
  }
  return result;
}

function parseOptionalModels(id: string, value: unknown) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`Assistant '${id}' models must be an array.`);
  }
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Assistant '${id}' model at index ${index} must be an object.`);
    }
    const config = item as Record<string, unknown>;
    const modelId = typeof config.id === "string" ? config.id.trim() : "";
    if (!modelId) throw new Error(`Assistant '${id}' model at index ${index} requires an id.`);
    return {
      id: modelId,
      aliases: Array.isArray(config.aliases) ? config.aliases.map(String).filter(Boolean) : undefined,
      quality: parseTier(config.quality, ["low", "medium", "high", "highest"]),
      cost: parseTier(config.cost, ["low", "medium", "high"]),
      latency: parseTier(config.latency, ["low", "medium", "high"]),
      routing: parseOptionalRouting(id, index, config.routing),
      description: config.description === undefined ? undefined : String(config.description),
    };
  });
}

function parseOptionalRouting(id: string, index: number, value: unknown) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`Assistant '${id}' model at index ${index} routing must be an array.`);
  }
  const allowed = ["fast", "balanced", "deep", "long_context"] as const;
  const parsed = value.map(String).filter((item): item is typeof allowed[number] => {
    return (allowed as readonly string[]).includes(item);
  });
  return parsed.length ? parsed : undefined;
}

function parseTier<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  return allowed.includes(String(value) as T) ? String(value) as T : undefined;
}

function parseOptionalEnvAllowlist(id: string, value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`Assistant '${id}' env_allowlist must be an array of non-empty strings.`);
  }
  return value.map((item) => item.trim());
}

function parseOptionalTimeoutMs(id: string, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Assistant '${id}' timeout_ms must be a positive number.`);
  }
  return Math.floor(parsed);
}

export async function getGeminiAuthReadiness(
  env: NodeJS.ProcessEnv = process.env,
  credentialFiles = defaultGeminiCredentialFiles(),
  vertexCredentialFiles = defaultVertexCredentialFiles(env),
): Promise<{ ok: boolean; detail: string }> {
  if (isTruthyEnv(env.GOOGLE_GENAI_USE_VERTEXAI)) {
    if (!hasNonBlankEnv(env.GOOGLE_CLOUD_PROJECT)) {
      return {
        ok: false,
        detail: "gemini found, but Vertex AI mode requires GOOGLE_CLOUD_PROJECT.",
      };
    }
    if (!hasNonBlankEnv(env.GOOGLE_CLOUD_LOCATION)) {
      return {
        ok: false,
        detail: "gemini found, but Vertex AI mode requires GOOGLE_CLOUD_LOCATION.",
      };
    }
    for (const file of vertexCredentialFiles) {
      if (await hasNonEmptyFile(file)) {
        return { ok: true, detail: `gemini found and Vertex AI credentials detected at ${file}` };
      }
    }
    return {
      ok: false,
      detail: "gemini found, but Vertex AI mode requires GOOGLE_APPLICATION_CREDENTIALS or gcloud application-default credentials.",
    };
  }
  if (hasNonBlankEnv(env.GEMINI_API_KEY) || hasNonBlankEnv(env.GOOGLE_API_KEY)) {
    return { ok: true, detail: "gemini found and API key environment is set" };
  }

  for (const file of credentialFiles) {
    if (await hasNonEmptyFile(file)) {
      return { ok: true, detail: `gemini found and credentials detected at ${file}` };
    }
  }

  return {
    ok: false,
    detail: "gemini found, but no Gemini credentials were detected. Run `gemini` once to authenticate, or set GEMINI_API_KEY/GOOGLE_API_KEY before starting the MCP server.",
  };
}

function defaultGeminiCredentialFiles(): string[] {
  const geminiHome = `${homedir()}/.gemini`;
  return [
    `${geminiHome}/oauth_creds.json`,
    `${geminiHome}/google_accounts.json`,
  ];
}

function defaultVertexCredentialFiles(env: NodeJS.ProcessEnv): string[] {
  return [
    env.GOOGLE_APPLICATION_CREDENTIALS?.trim(),
    `${homedir()}/.config/gcloud/application_default_credentials.json`,
  ].filter((path): path is string => Boolean(path));
}

export function isTruthyEnv(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

export function hasNonBlankEnv(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

async function hasNonEmptyFile(path: string): Promise<boolean> {
  try {
    const file = Bun.file(path);
    return await file.exists() && file.size > 0;
  } catch {
    return false;
  }
}

function normalizeAssistantId(value: string | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) return null;
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(trimmed)) {
    throw new Error(`Invalid assistant id '${value}'. Use lowercase letters, numbers, hyphen, or underscore.`);
  }
  return trimmed;
}

function parseAssistantList(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value.split(",").map((part) => {
    const id = normalizeAssistantId(part);
    if (!id) throw new Error(`Invalid assistant id '${part}' in PEER_ASSISTANTS`);
    return id;
  });
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
