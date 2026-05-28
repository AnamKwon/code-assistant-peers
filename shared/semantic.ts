import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { SemanticSymbolHint } from "./types.ts";
import { getGitRoot } from "./git.ts";

const SYMBOL_HINT_FILE_LIMIT = 30;
const SYMBOL_HINTS_PER_FILE = 24;
const SYMBOL_HINT_CONTEXT_BUDGET = 8000;
const SEMANTIC_CONTEXT_BUDGET = 6000;
const SERENA_CONTEXT_BUDGET = parseInt(process.env.CODE_ASSISTANT_PEERS_SERENA_CONTEXT_BUDGET ?? "8000", 10);
const SERENA_TIMEOUT_MS = parseInt(process.env.CODE_ASSISTANT_PEERS_SERENA_TIMEOUT_MS ?? "90000", 10);
const SERENA_FILE_LIMIT = 8;
const SERENA_SYMBOL_LIMIT = 10;
const SERENA_REFERENCE_LIMIT = 6;
const SERENA_TOOL_RESULT_BUDGET = 2000;
const SERENA_AUTO_SOURCE_BYTES = parseInt(process.env.CODE_ASSISTANT_PEERS_SERENA_AUTO_SOURCE_BYTES ?? "32768", 10);
const SERENA_AUTO_SOURCE_FILES = parseInt(process.env.CODE_ASSISTANT_PEERS_SERENA_AUTO_SOURCE_FILES ?? "4", 10);

export interface SemanticContextOptions {
  diffLength?: number;
  diffBudget?: number;
}

export interface SerenaAutoDecision {
  useSerena: boolean;
  sourceFileCount: number;
  changedSourceBytes: number;
  reasons: string[];
}

export async function buildSemanticContext(
  cwd: string,
  changedFiles: string[],
  injectedContext?: string | null,
  options: SemanticContextOptions = {},
): Promise<string> {
  const parts: string[] = [];
  const normalizedInjected = normalizeInjectedSemanticContext(injectedContext ?? process.env.CODE_ASSISTANT_PEERS_SEMANTIC_CONTEXT);
  if (normalizedInjected) {
    parts.push(`External semantic context:\n${normalizedInjected}`);
  }

  const provider = (process.env.CODE_ASSISTANT_PEERS_CONTEXT_PROVIDER ?? "symbols").trim().toLowerCase();
  if (provider === "off" || provider === "none") {
    return parts.join("\n\n");
  }

  const hints = await collectSymbolHints(cwd, changedFiles);
  const autoDecision = provider === "serena-auto" || provider === "auto"
    ? await decideSerenaAuto(cwd, changedFiles, options)
    : null;

  let skipLocalSymbolHints = false;
  let serenaContext: SerenaContextResult | null = null;
  if (provider === "serena-direct" || autoDecision?.useSerena) {
    serenaContext = await buildSerenaDirectContext(cwd, changedFiles, hints);
    if (serenaContext.text) {
      parts.push(serenaContext.text);
      skipLocalSymbolHints = serenaContext.rich;
    }
  }

  if (hints.length > 0 && !skipLocalSymbolHints) {
    parts.push(`Changed symbol hints:\n${formatSymbolHints(hints, SYMBOL_HINT_CONTEXT_BUDGET)}`);
  }

  if (provider === "serena") {
    parts.push([
      "Serena-style lookup guidance:",
      "- If Serena MCP tools are available in this reviewer session, inspect these changed symbols with symbol overview/reference tools.",
      "- Use references, implementations, subclasses, and diagnostics as impact hints, not as a complete dependency graph.",
      "- If Serena is unavailable, fall back to the git diff and changed symbol hints above.",
    ].join("\n"));
  }

  return [
    `Semantic context status:\n${buildSemanticContextStatus(provider, autoDecision, serenaContext).map((line) => `- ${line}`).join("\n")}`,
    ...parts,
  ].join("\n\n");
}

function buildSemanticContextStatus(
  provider: string,
  autoDecision: SerenaAutoDecision | null,
  serenaContext: SerenaContextResult | null,
): string[] {
  const statusLines = [`Provider: ${provider}`];
  if (autoDecision) {
    if (!autoDecision.useSerena) {
      statusLines.push(`Serena optimization: skipped (source_files=${autoDecision.sourceFileCount}, source_bytes=${autoDecision.changedSourceBytes})`);
    } else if (serenaContext?.rich) {
      statusLines.push(`Serena optimization: used (${autoDecision.reasons.join(", ")})`);
    } else if (serenaContext?.text?.includes("Serena direct context unavailable")) {
      statusLines.push(`Serena optimization: unavailable (${autoDecision.reasons.join(", ")})`);
    } else {
      statusLines.push(`Serena optimization: attempted (${autoDecision.reasons.join(", ")})`);
    }
  } else if (provider === "serena-direct") {
    if (serenaContext?.rich) {
      statusLines.push("Serena optimization: used.");
    } else if (serenaContext?.text?.includes("Serena direct context unavailable")) {
      statusLines.push("Serena optimization: unavailable.");
    } else {
      statusLines.push("Serena optimization: direct provider requested.");
    }
  } else if (provider === "serena") {
    statusLines.push("Serena optimization: reviewer lookup guidance requested; no host-side Serena MCP call will be made.");
  } else {
    statusLines.push("Serena optimization: not requested; using local symbol hints when available.");
  }
  return statusLines;
}

export async function decideSerenaAuto(
  cwd: string,
  changedFiles: string[],
  options: SemanticContextOptions = {},
): Promise<SerenaAutoDecision> {
  const root = await getGitRoot(cwd) ?? cwd;
  const sourceFiles = changedFiles.filter(isLikelySourceFile);
  let changedSourceBytes = 0;
  for (const file of sourceFiles) {
    try {
      changedSourceBytes += (await stat(join(root, file))).size;
    } catch {
      // Deleted or inaccessible files cannot add source context.
    }
  }

  const reasons: string[] = [];
  if (sourceFiles.length >= SERENA_AUTO_SOURCE_FILES) {
    reasons.push(`source_files>=${SERENA_AUTO_SOURCE_FILES}`);
  }
  if (changedSourceBytes >= SERENA_AUTO_SOURCE_BYTES) {
    reasons.push(`source_bytes>=${SERENA_AUTO_SOURCE_BYTES}`);
  }
  if (options.diffLength !== undefined && options.diffBudget !== undefined && options.diffLength > options.diffBudget) {
    reasons.push("diff_truncated");
  }
  if (sourceFiles.some(isRiskySourcePath)) {
    reasons.push("risk_path");
  }

  return {
    useSerena: reasons.length > 0,
    sourceFileCount: sourceFiles.length,
    changedSourceBytes,
    reasons,
  };
}

export interface SerenaCommand {
  command: string;
  args: string[];
}

interface SerenaContextResult {
  text: string | null;
  rich: boolean;
}

type SerenaInputSchema = {
  properties?: Record<string, unknown>;
};

export function parseSerenaCommand(value: string | undefined): SerenaCommand | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`CODE_ASSISTANT_PEERS_SERENA_COMMAND contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((part) => typeof part !== "string" || part.length === 0)) {
      throw new Error("CODE_ASSISTANT_PEERS_SERENA_COMMAND JSON must be a non-empty string array");
    }
    const [command, ...args] = parsed;
    return { command, args };
  }

  const parts = splitCommandLine(trimmed);
  if (parts.length === 0) return null;
  const [command, ...args] = parts;
  return { command, args };
}

export function validateSerenaToolSet(toolNames: Iterable<string>): string | null {
  const tools = new Set(toolNames);
  if (!tools.has("activate_project")) {
    return "Serena MCP server does not expose activate_project, so project-scoped symbol queries were skipped.";
  }
  return null;
}

export function buildSerenaFindSymbolArgs(hint: SemanticSymbolHint): Record<string, unknown> {
  return {
    name_path_pattern: hint.name,
    relative_path: hint.file,
    depth: 1,
    include_body: false,
    max_matches: 3,
    max_answer_chars: SERENA_TOOL_RESULT_BUDGET,
  };
}

export function buildSerenaNamePathArgs(schema: SerenaInputSchema | undefined, hint: SemanticSymbolHint): Record<string, unknown> {
  const nameKey = schema?.properties?.name_path_pattern ? "name_path_pattern" : "name_path";
  return {
    [nameKey]: hint.name,
    relative_path: hint.file,
    max_answer_chars: SERENA_TOOL_RESULT_BUDGET,
  };
}

async function buildSerenaDirectContext(cwd: string, changedFiles: string[], hints: SemanticSymbolHint[]): Promise<SerenaContextResult> {
  let command: SerenaCommand | null;
  try {
    command = parseSerenaCommand(process.env.CODE_ASSISTANT_PEERS_SERENA_COMMAND);
  } catch (error) {
    return { text: compactSerenaContext(`Serena direct context unavailable: ${error instanceof Error ? error.message : String(error)}`), rich: false };
  }

  if (!command) {
    return { text: compactSerenaContext([
      "Serena direct context unavailable: CODE_ASSISTANT_PEERS_SERENA_COMMAND is not set.",
      "Set CODE_ASSISTANT_PEERS_SERENA_COMMAND to the stdio command that starts your Serena MCP server, preferably as a JSON array.",
    ].join("\n")), rich: false };
  }

  const root = await getGitRoot(cwd) ?? cwd;
  const transport = new StdioClientTransport({
    command: command.command,
    args: command.args,
    cwd: root,
    stderr: "pipe",
  });
  const client = new Client({ name: "code-assistant-peers", version: "0.1.0" }, { capabilities: {} });

  try {
    await client.connect(transport);
    const listed = await client.listTools(undefined, { timeout: SERENA_TIMEOUT_MS, maxTotalTimeout: SERENA_TIMEOUT_MS });
    const tools = new Set(listed.tools.map((tool) => tool.name));
    const inputSchemas = new Map(listed.tools.map((tool) => [tool.name, tool.inputSchema as SerenaInputSchema]));
    const sections: string[] = ["Serena direct context:"];

    const toolSetError = validateSerenaToolSet(tools);
    if (toolSetError) {
      return {
        text: compactSerenaContext(`Serena direct context unavailable: ${toolSetError}`),
        rich: false,
      };
    }

    try {
      await client.callTool({ name: "activate_project", arguments: { project: root } }, undefined, {
        timeout: SERENA_TIMEOUT_MS,
        maxTotalTimeout: SERENA_TIMEOUT_MS,
      });
    } catch (error) {
      return {
        text: compactSerenaContext(`Serena direct context unavailable: activate_project failed: ${error instanceof Error ? error.message : String(error)}`),
        rich: false,
      };
    }

    for (const file of changedFiles.filter(isLikelySourceFile).slice(0, SERENA_FILE_LIMIT)) {
      const overview = await callSerenaTool(client, tools, "get_symbols_overview", {
        relative_path: file,
        depth: 1,
        max_answer_chars: SERENA_TOOL_RESULT_BUDGET,
      });
      if (overview) {
        sections.push(formatSerenaSection(`Overview ${file}`, overview));
      }
    }

    for (const hint of hints.slice(0, SERENA_SYMBOL_LIMIT)) {
      const symbol = await callSerenaTool(client, tools, "find_symbol", buildSerenaFindSymbolArgs(hint));
      if (symbol) {
        sections.push(formatSerenaSection(`Symbol ${hint.file}:${hint.line} ${hint.name}`, symbol));
      }
    }

    for (const hint of hints.slice(0, SERENA_REFERENCE_LIMIT)) {
      const references = await callSerenaTool(
        client,
        tools,
        "find_referencing_symbols",
        buildSerenaNamePathArgs(inputSchemas.get("find_referencing_symbols"), hint),
      );
      if (references) {
        sections.push(formatSerenaSection(`References ${hint.name}`, references));
      }

      const implementations = await callSerenaTool(
        client,
        tools,
        "find_implementations",
        buildSerenaNamePathArgs(inputSchemas.get("find_implementations"), hint),
      );
      if (implementations) {
        sections.push(formatSerenaSection(`Implementations ${hint.name}`, implementations));
      }
    }

    if (sections.length === 1) {
      sections.push("Serena MCP server was reachable, but no supported symbol context tools returned content.");
    }
    return { text: compactSerenaContext(sections.join("\n\n")), rich: sections.length > 2 };
  } catch (error) {
    return { text: compactSerenaContext(`Serena direct context unavailable: ${error instanceof Error ? error.message : String(error)}`), rich: false };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function callSerenaTool(
  client: Client,
  tools: Set<string>,
  name: string,
  args: Record<string, unknown>,
): Promise<string | null> {
  if (!tools.has(name)) return null;
  try {
    const result = await client.callTool({ name, arguments: args }, undefined, {
      timeout: SERENA_TIMEOUT_MS,
      maxTotalTimeout: SERENA_TIMEOUT_MS,
    });
    if ((result as { isError?: unknown }).isError) return null;
    return stringifyToolContent(result.content);
  } catch {
    return null;
  }
}

function stringifyToolContent(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const text = content
    .map((item) => item.type === "text" && typeof item.text === "string" ? item.text : JSON.stringify(item))
    .join("\n")
    .trim();
  if (!text || text.startsWith("Error executing tool")) return null;
  return text;
}

function formatSerenaSection(title: string, body: string): string {
  return `${title}:\n${body.trim()}`;
}

function compactSerenaContext(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= SERENA_CONTEXT_BUDGET) return trimmed;
  return `${trimmed.slice(0, SERENA_CONTEXT_BUDGET)}\n[Serena context truncated at ${SERENA_CONTEXT_BUDGET} characters.]`;
}

export async function collectSymbolHints(cwd: string, changedFiles: string[]): Promise<SemanticSymbolHint[]> {
  const hints: SemanticSymbolHint[] = [];
  const root = await getGitRoot(cwd) ?? cwd;
  for (const file of changedFiles.slice(0, SYMBOL_HINT_FILE_LIMIT)) {
    if (!isLikelySourceFile(file)) continue;
    let source: string;
    try {
      source = await readFile(join(root, file), "utf8");
    } catch {
      continue;
    }
    hints.push(...extractSymbolHints(file, source).slice(0, SYMBOL_HINTS_PER_FILE));
  }
  return hints;
}

export function extractSymbolHints(file: string, source: string): SemanticSymbolHint[] {
  const hints: SemanticSymbolHint[] = [];
  const patterns: Array<{ kind: string; regex: RegExp }> = [
    { kind: "class", regex: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
    { kind: "interface", regex: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
    { kind: "type", regex: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/ },
    { kind: "function", regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
    { kind: "const-function", regex: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/ },
    { kind: "method", regex: /^\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*[:\w\s<>,[\]|.?]*\{/ },
  ];

  source.split(/\r?\n/).forEach((line, index) => {
    for (const pattern of patterns) {
      const match = line.match(pattern.regex);
      if (match?.[1] && !isControlKeyword(match[1])) {
        hints.push({ file, line: index + 1, kind: pattern.kind, name: match[1] });
        return;
      }
    }
  });
  return hints;
}

export function formatSymbolHints(hints: SemanticSymbolHint[], budget: number): string {
  const lines = hints.map((hint) => `- ${hint.file}:${hint.line} ${hint.kind} ${hint.name}`);
  const result: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > budget) {
      result.push(`[Symbol hints truncated at ${budget} characters; ${lines.length - result.length} hint(s) omitted.]`);
      break;
    }
    result.push(line);
    used += line.length + 1;
  }
  return result.join("\n");
}

function normalizeInjectedSemanticContext(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed.length <= SEMANTIC_CONTEXT_BUDGET) return trimmed;
  return `${trimmed.slice(0, SEMANTIC_CONTEXT_BUDGET)}\n[Semantic context truncated at ${SEMANTIC_CONTEXT_BUDGET} characters.]`;
}

function splitCommandLine(value: string): string[] {
  const parts: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|[^\s]+/g;
  for (const match of value.matchAll(pattern)) {
    parts.push(match[1] ?? match[2] ?? match[0]);
  }
  return parts;
}

function isLikelySourceFile(file: string): boolean {
  return /\.(cjs|cts|js|jsx|mjs|mts|ts|tsx)$/.test(file);
}

function isRiskySourcePath(file: string): boolean {
  return /(^|[/_-])(auth|checkout|payment|permission|security|migration|storage|database|db|token|session|encrypt|crypto)([/_.-]|$)/i.test(file);
}

function isControlKeyword(name: string): boolean {
  return [
    "catch",
    "delete",
    "else",
    "for",
    "if",
    "new",
    "return",
    "switch",
    "typeof",
    "void",
    "while",
  ].includes(name);
}
