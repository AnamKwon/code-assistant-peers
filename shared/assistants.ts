import type { AssistantAdapter, AssistantHost } from "./types.ts";

export const BUILTIN_ASSISTANTS: Record<string, AssistantAdapter> = {
  codex: {
    id: "codex",
    command: ["codex", "exec", "--sandbox", "read-only", "--skip-git-repo-check", "-"],
    prompt_transport: "stdin",
    description: "OpenAI Codex CLI in read-only exec mode.",
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
      "Read,Grep,Glob,Bash(git status:*),Bash(git diff:*),Bash(git show:*),Bash(git ls-files:*),mcp__code-assistant-peers__get_peer_task_context,mcp__code-assistant-peers__list_peer_review_rounds,mcp__code-assistant-peers__get_peer_review_round,mcp__code-assistant-peers__get_open_findings,mcp__code-assistant-peers__record_peer_review",
      "--disallowedTools",
      "Edit,Write,MultiEdit,NotebookEdit",
    ],
    prompt_transport: "stdin",
    description: "Claude Code print mode with read-only review tools.",
  },
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
  if (host === "codex" && registry.claude) return ["claude"];

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
    const promptTransport = config.prompt_transport === "argv" ? "argv" : "stdin";
    result[id] = {
      id,
      command,
      prompt_transport: promptTransport,
      description: config.description === undefined ? undefined : String(config.description),
    };
  }
  return result;
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
