const MCP_SERVER_NAME = "code-assistant-peers";
const DEFAULT_SERENA_UVX_COMMAND = [
  "uvx",
  "--from",
  "git+https://github.com/oraios/serena",
  "serena",
  "start-mcp-server",
  "--project-from-cwd",
  "--enable-web-dashboard",
  "false",
  "--open-web-dashboard",
  "false",
  "--log-level",
  "ERROR",
];

export interface SerenaSetupConfig {
  enabled: boolean;
  command: string[] | null;
  reason: string;
}

export type AssistantSetupAvailability = Record<string, { ok: boolean; detail: string } | undefined>;

export interface AutoPeerSetupResult {
  peers: string;
  selected: string[];
  skipped: Array<{ id: string; reason: string }>;
}

const BUILTIN_SETUP_ASSISTANTS = ["claude", "codex", "gemini"] as const;

export function buildSerenaEnv(config: SerenaSetupConfig): string[] {
  if (!config.enabled || !config.command) return [];
  return [
    "CODE_ASSISTANT_PEERS_CONTEXT_PROVIDER=serena-auto",
    `CODE_ASSISTANT_PEERS_SERENA_COMMAND=${JSON.stringify(config.command)}`,
    "CODE_ASSISTANT_PEERS_DIFF_BUDGET=4000",
    "CODE_ASSISTANT_PEERS_SERENA_CONTEXT_BUDGET=8000",
    "CODE_ASSISTANT_PEERS_SERENA_TIMEOUT_MS=90000",
  ];
}

export function resolveSerenaSetupConfig(options: {
  mode: "auto" | "on" | "off";
  explicitCommand?: string | null;
  hasSerenaBinary?: boolean;
  hasUvx?: boolean;
}): SerenaSetupConfig {
  if (options.mode === "off") {
    return { enabled: false, command: null, reason: "disabled by --serena=off" };
  }

  if (options.explicitCommand?.trim()) {
    return {
      enabled: true,
      command: parseCommandForSetup(options.explicitCommand),
      reason: "using --serena-command",
    };
  }

  if (options.hasSerenaBinary) {
    return {
      enabled: true,
      command: [
        "serena",
        "start-mcp-server",
        "--project-from-cwd",
        "--enable-web-dashboard",
        "false",
        "--open-web-dashboard",
        "false",
        "--log-level",
        "ERROR",
      ],
      reason: "detected serena executable",
    };
  }

  if (options.hasUvx) {
    return {
      enabled: true,
      command: DEFAULT_SERENA_UVX_COMMAND,
      reason: "detected uvx; Serena will run through uvx",
    };
  }

  if (options.mode === "on") {
    throw new Error("Serena was requested with --serena=on, but neither serena nor uvx was found. Install Serena/uv or pass --serena-command.");
  }

  return {
    enabled: false,
    command: null,
    reason: "Serena not detected; using standard diff/changed-files review",
  };
}

export function resolveAutoPeerSetupConfig(
  targets: readonly string[],
  availability: AssistantSetupAvailability,
): AutoPeerSetupResult {
  const targetSet = new Set(targets);
  const selected = BUILTIN_SETUP_ASSISTANTS.filter((id) => {
    if (targets.length === 1 && targetSet.has(id)) return false;
    return Boolean(availability[id]?.ok);
  });
  const skipped = BUILTIN_SETUP_ASSISTANTS
    .filter((id) => !selected.includes(id))
    .map((id) => ({
      id,
      reason: targetSet.has(id) && targets.length === 1
        ? "same as the only setup target"
        : availability[id]?.detail ?? "not checked",
    }));

  if (selected.length === 0) {
    const details = BUILTIN_SETUP_ASSISTANTS
      .map((id) => `${id}: ${availability[id]?.detail ?? "not checked"}`)
      .join("; ");
    throw new Error(`--peers=auto could not find an available peer assistant different from the setup target. ${details}`);
  }
  for (const target of targets) {
    if (selected.filter((id) => id !== target).length > 0) continue;
    const details = BUILTIN_SETUP_ASSISTANTS
      .map((id) => `${id}: ${availability[id]?.detail ?? "not checked"}`)
      .join("; ");
    throw new Error(`--peers=auto could not find an available peer assistant for HOST_ASSISTANT=${target}. ${details}`);
  }

  return {
    peers: selected.join(","),
    selected,
    skipped,
  };
}

export function resolveGeminiAutoPeerReadiness(env: NodeJS.ProcessEnv): { ok: boolean; detail: string } {
  if (isTruthySetupEnv(env.GOOGLE_GENAI_USE_VERTEXAI)) {
    return {
      ok: false,
      detail: "gemini found, but --peers=auto does not select Gemini in Vertex AI mode. Use --peers=gemini to opt into Vertex credentials.",
    };
  }
  if (env.GEMINI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim()) {
    return { ok: true, detail: "gemini found and API key environment is set" };
  }
  return {
    ok: false,
    detail: "gemini found, but --peers=auto only selects Gemini when GEMINI_API_KEY/GOOGLE_API_KEY is set. Use --peers=gemini to opt into Gemini CLI OAuth or Vertex credentials.",
  };
}

export function upsertCodexMcpTimeoutConfig(current: string, serverPath: string, timeoutSec: number): string {
  const header = `[mcp_servers.${MCP_SERVER_NAME}]`;
  const escapedServerPath = serverPath.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
  const fallbackBlock = [
    header,
    'command = "bun"',
    `args = ["${escapedServerPath}"]`,
    "startup_timeout_sec = 30",
    `tool_timeout_sec = ${timeoutSec}`,
    "",
  ].join("\n");
  if (!current.trim()) return `${fallbackBlock}\n`;

  const lines = current.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) {
    return `${current.replace(/\s*$/, "\n\n")}${fallbackBlock}\n`;
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) {
      end = i;
      break;
    }
  }

  const section = lines.slice(start, end);
  const withCommand = upsertTomlKey(section, "command", '"bun"');
  const withArgs = upsertTomlKey(withCommand, "args", `["${escapedServerPath}"]`);
  const withStartupTimeout = upsertTomlKey(withArgs, "startup_timeout_sec", "30");
  const withToolTimeout = upsertTomlKey(withStartupTimeout, "tool_timeout_sec", String(timeoutSec));
  const updated = [...lines.slice(0, start), ...withToolTimeout, ...lines.slice(end)].join("\n");
  return updated.endsWith("\n") ? updated : `${updated}\n`;
}

function isTruthySetupEnv(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

function parseCommandForSetup(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`Invalid --serena-command JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((part) => typeof part !== "string" || part.length === 0)) {
      throw new Error("--serena-command JSON must be a non-empty string array");
    }
    return parsed;
  }
  return splitCommandLine(trimmed);
}

function splitCommandLine(value: string): string[] {
  const parts: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|[^\s]+/g;
  for (const match of value.matchAll(pattern)) {
    parts.push(match[1] ?? match[2] ?? match[0]);
  }
  if (parts.length === 0) throw new Error("--serena-command must not be empty");
  return parts;
}

function upsertTomlKey(lines: string[], key: string, value: string): string[] {
  const index = lines.findIndex((line) => line.trim().startsWith(`${key} `) || line.trim().startsWith(`${key}=`));
  if (index === -1) return [...lines, `${key} = ${value}`];
  const updated = [...lines];
  updated[index] = `${key} = ${value}`;
  return updated;
}
