#!/usr/bin/env bun
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  compactTaskHistory,
  gcStore,
  getDatabasePath,
  getStoreDir,
  listFindings,
  listReviewRounds,
  listTasks,
  loadTask,
} from "./shared/store.ts";
import { getGeminiAuthReadiness, loadAssistantRegistry } from "./shared/assistants.ts";
import {
  buildSerenaEnv,
  resolveAutoPeerSetupConfig,
  resolveGeminiAutoPeerReadiness,
  resolveSerenaSetupConfig,
  upsertCodexMcpTimeoutConfig,
  type AssistantSetupAvailability,
  type SerenaSetupConfig,
} from "./shared/setup.ts";

const cmd = process.argv[2];
const SERVER_PATH = new URL("./server.ts", import.meta.url).pathname;
const PROJECT_RULE_BLOCK = `<!-- code-assistant-peers:start -->
## Code Assistant Peer Review Rule

When editing, creating, deleting, formatting, or refactoring code files, you must use the code-assistant-peers MCP before the final response.

Required workflow:
1. Call \`begin_peer_task\` before editing when feasible.
2. Make the requested code changes.
3. Before the final response, call \`must_call_after_code_changes\`.
4. Call \`wait_for_peer_review\` or \`get_peer_review_status\` until the task reaches \`reviewed\`, \`partial_failed\`, or \`review_failed\`.
5. Report the peer review result, including any blocking findings or fix proposals.

Do not use built-in \`/review\` as a substitute for this MCP peer review. Built-in review may be used only as an extra check after the MCP peer review.
<!-- code-assistant-peers:end -->`;

switch (cmd) {
  case "status": {
    const tasks = await listTasks();
    console.log(`Store: ${getStoreDir()}`);
    console.log(`Database: ${getDatabasePath()}`);
    console.log(`Tasks: ${tasks.length}`);
    const latest = tasks[0];
    if (latest) {
      console.log(`Latest: ${latest.id} (${latest.status}) ${latest.created_at}`);
    }
    break;
  }
  case "doctor": {
    await runDoctor();
    break;
  }
  case "tasks": {
    const tasks = await listTasks();
    if (tasks.length === 0) {
      console.log("No tasks.");
      break;
    }
    for (const task of tasks) {
      console.log(`${task.id}  ${task.status}  ${task.host}->${task.peer}  ${task.cwd}`);
    }
    break;
  }
  case "show": {
    const id = process.argv[3];
    if (!id) {
      console.error("Usage: bun cli.ts show <task-id>");
      process.exit(1);
    }
    const task = await loadTask(id);
    if (!task) {
      console.error(`Task not found: ${id}`);
      process.exit(1);
    }
    console.log(JSON.stringify({
      task,
      rounds: await listReviewRounds(id),
      findings: await listFindings(id),
    }, null, 2));
    break;
  }
  case "rounds": {
    const id = process.argv[3];
    if (!id) {
      console.error("Usage: bun cli.ts rounds <task-id>");
      process.exit(1);
    }
    const rounds = await listReviewRounds(id);
    for (const round of rounds) {
      console.log(`Round ${round.round}  ${round.reviewer}  exit:${round.exit_code}  ${round.completed_at}`);
      const preview = (round.stdout || round.stderr).trim().slice(0, 500);
      if (preview) console.log(preview);
      console.log("");
    }
    break;
  }
  case "findings": {
    const id = process.argv[3];
    if (!id) {
      console.error("Usage: bun cli.ts findings <task-id>");
      process.exit(1);
    }
    const findings = await listFindings(id);
    if (findings.length === 0) {
      console.log("No findings.");
      break;
    }
    for (const finding of findings) {
      const location = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ""}` : "no file";
      console.log(`#${finding.id} [${finding.status}] ${finding.severity} ${location} - ${finding.message}`);
    }
    break;
  }
  case "compact": {
    const id = process.argv[3];
    if (!id) {
      console.error("Usage: bun cli.ts compact <task-id>");
      process.exit(1);
    }
    console.log(await compactTaskHistory(id));
    break;
  }
  case "gc": {
    const days = Number(process.argv[3] ?? 30);
    if (!Number.isFinite(days) || days < 1) {
      console.error("Usage: bun cli.ts gc [days]");
      process.exit(1);
    }
    console.log(JSON.stringify(await gcStore(days), null, 2));
    break;
  }
  case "env": {
    const workflow = normalizeWorkflowArg(process.argv[3] ?? "review_only");
    const host = normalizeHostArg(process.argv[4] ?? "claude");
    const mode = normalizeModeArg(process.argv[5] ?? "normal");
    console.log(buildEnvPrefix(host, workflow, mode));
    break;
  }
  case "install-command": {
    const target = process.argv[3];
    const workflow = normalizeWorkflowArg(process.argv[4] ?? "review_only");
    const mode = normalizeModeArg(process.argv[5] ?? "normal");
    if (target !== "claude" && target !== "codex") {
      console.error("Usage: bun cli.ts install-command <claude|codex> [review_only|peer_fix] [normal|adversarial|gate|collaborative]");
      process.exit(1);
    }
    console.log(buildInstallCommand(target, workflow, mode));
    break;
  }
  case "reinstall-command": {
    const target = process.argv[3];
    const workflow = normalizeWorkflowArg(process.argv[4] ?? "review_only");
    const mode = normalizeModeArg(process.argv[5] ?? "normal");
    if (target !== "claude" && target !== "codex") {
      console.error("Usage: bun cli.ts reinstall-command <claude|codex> [review_only|peer_fix] [normal|adversarial|gate|collaborative]");
      process.exit(1);
    }
    if (target === "claude") {
      console.log(`claude mcp remove --scope user code-assistant-peers || true`);
      console.log(buildInstallCommand(target, workflow, mode));
    } else {
      console.log(`codex mcp remove code-assistant-peers || true`);
      console.log(buildInstallCommand(target, workflow, mode));
    }
    break;
  }
  case "mode-command": {
    const target = process.argv[3];
    const mode = normalizeModeArg(process.argv[4] ?? "");
    const workflow = normalizeWorkflowArg(process.argv[5] ?? "review_only");
    if (target !== "claude" && target !== "codex" && target !== "both") {
      console.error("Usage: bun cli.ts mode-command <claude|codex|both> <normal|adversarial|gate|collaborative> [review_only|peer_fix]");
      process.exit(1);
    }
    const targets: readonly ("claude" | "codex")[] = target === "both" ? ["claude", "codex"] : [target];
    for (const item of targets) {
      if (item === "claude") {
        console.log(`claude mcp remove --scope user code-assistant-peers || true`);
      } else {
        console.log(`codex mcp remove code-assistant-peers || true`);
      }
      console.log(buildInstallCommand(item, workflow, mode));
    }
    break;
  }
  case "apply-mode": {
    const target = process.argv[3];
    if (target !== "claude" && target !== "codex" && target !== "both") {
      console.error("Usage: bun cli.ts apply-mode <claude|codex|both> <normal|adversarial|gate|collaborative> [review_only|peer_fix]");
      process.exit(1);
    }
    if (!process.argv[4]) {
      console.error("Usage: bun cli.ts apply-mode <claude|codex|both> <normal|adversarial|gate|collaborative> [review_only|peer_fix]");
      process.exit(1);
    }
    const mode = normalizeModeArg(process.argv[4] ?? "");
    const workflow = normalizeWorkflowArg(process.argv[5] ?? "review_only");
    const targets: readonly ("claude" | "codex")[] = target === "both" ? ["claude", "codex"] : [target];
    for (const item of targets) {
      await reinstallMcp(item, workflow, mode);
    }
    break;
  }
  case "setup": {
    const target = process.argv[3] ?? "both";
    if (target !== "claude" && target !== "codex" && target !== "both") {
      console.error("Usage: bun cli.ts setup [claude|codex|both] [--workflow=review_only|peer_fix] [--mode=normal|adversarial|gate|collaborative] [--peers=auto|codex,gemini] [--timeout=600] [--serena=auto|on|off] [--serena-command='[...]'] [--install-rules[=dir]] [--dry-run]");
      process.exit(1);
    }
    const options = parseSetupOptions(process.argv.slice(4));
    const targets: readonly ("claude" | "codex")[] = target === "both" ? ["claude", "codex"] : [target];
    await setupMcp(targets, options);
    break;
  }
  case "rules": {
    console.log(PROJECT_RULE_BLOCK);
    break;
  }
  case "install-rules": {
    const targetDir = resolve(process.argv[3] ?? process.cwd());
    await installRules(targetDir);
    console.log(`Installed peer review rules into ${join(targetDir, "CLAUDE.md")} and ${join(targetDir, "AGENTS.md")}`);
    break;
  }
  default:
    console.log(`code-assistant-peers CLI

Usage:
  bun cli.ts status          Show store path and task count
  bun cli.ts doctor          Check local setup, assistant CLIs, and Codex MCP timeout
  bun cli.ts tasks           List saved tasks
  bun cli.ts show <task-id>  Print a task record with review memory
  bun cli.ts rounds <task-id>    List review rounds
  bun cli.ts findings <task-id>  List recorded findings
  bun cli.ts compact <task-id>   Save and print a compact task summary
  bun cli.ts gc [days]           Delete old eligible review records
  bun cli.ts env [workflow] [host] [mode]          Print env prefix
  bun cli.ts install-command <claude|codex> [workflow] [mode]
  bun cli.ts reinstall-command <claude|codex> [workflow] [mode]
  bun cli.ts mode-command <claude|codex|both> <mode> [workflow]
  bun cli.ts apply-mode <claude|codex|both> <mode> [workflow]
  bun cli.ts setup [claude|codex|both] [--workflow=review_only|peer_fix] [--mode=normal|adversarial|gate|collaborative] [--peers=auto|a,b] [--timeout=600] [--serena=auto|on|off] [--serena-command='[...]'] [--install-rules[=dir]] [--dry-run]
  bun cli.ts rules                                Print project instruction block
  bun cli.ts install-rules [project-dir]          Add/update CLAUDE.md and AGENTS.md

Workflows:
  review_only  Peer only reviews
  peer_fix     Peer reviews and proposes fixes without editing files

Review modes:
  normal         Standard peer review
  adversarial   More skeptical design/bug review
  gate          Compact ALLOW/BLOCK review
  collaborative Both CLIs review and compare; stronger but uses more tokens`);
}

function normalizeWorkflowArg(value: string): "review_only" | "peer_fix" {
  if (value === "peer_fix") return "peer_fix";
  if (value === "review_only") return "review_only";
  console.error(`Unsupported workflow: ${value}`);
  process.exit(1);
}

function normalizeHostArg(value: string): "claude" | "codex" {
  if (value === "claude" || value === "codex") return value;
  console.error(`Unsupported host: ${value}`);
  process.exit(1);
}

function normalizeModeArg(value: string): "normal" | "adversarial" | "gate" | "collaborative" {
  if (value === "normal" || value === "adversarial" || value === "gate" || value === "collaborative") return value;
  console.error(`Unsupported review mode: ${value}`);
  process.exit(1);
}

function buildEnvPrefix(
  host: "claude" | "codex",
  workflow: "review_only" | "peer_fix",
  mode: "normal" | "adversarial" | "gate" | "collaborative",
  peers?: string | null,
  extraEnv: string[] = [],
): string {
  return [
    `HOST_ASSISTANT=${host}`,
    `CODE_ASSISTANT_PEERS_WORKFLOW=${workflow}`,
    `CODE_ASSISTANT_PEERS_REVIEW_MODE=${mode}`,
    peers ? `PEER_ASSISTANTS=${peers}` : null,
    ...extraEnv,
  ].filter((value): value is string => Boolean(value)).map((value) => shellQuote(value)).join(" ");
}

function buildInstallCommand(
  target: "claude" | "codex",
  workflow: "review_only" | "peer_fix",
  mode: "normal" | "adversarial" | "gate" | "collaborative",
  peers?: string | null,
  extraEnv: string[] = [],
): string {
  if (target === "claude") {
    return `claude mcp add --scope user --transport stdio code-assistant-peers -- env ${buildEnvPrefix("claude", workflow, mode, peers, extraEnv)} bun ${shellQuote(SERVER_PATH)}`;
  }
  return [
    "codex mcp add code-assistant-peers",
    "--env HOST_ASSISTANT=codex",
    `--env CODE_ASSISTANT_PEERS_WORKFLOW=${workflow}`,
    `--env CODE_ASSISTANT_PEERS_REVIEW_MODE=${mode}`,
    peers ? `--env PEER_ASSISTANTS=${peers}` : null,
    ...extraEnv.flatMap((value) => ["--env", shellQuote(value)]),
    `-- bun ${shellQuote(SERVER_PATH)}`,
  ].filter(Boolean).join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function reinstallMcp(
  target: "claude" | "codex",
  workflow: "review_only" | "peer_fix",
  mode: "normal" | "adversarial" | "gate" | "collaborative",
  peers?: string | null,
  extraEnv: string[] = [],
): Promise<void> {
  await runCommand(buildRemoveArgs(target), true);
  await runCommand(buildInstallArgs(target, workflow, mode, peers, extraEnv), false);
  console.log(`Updated ${target} MCP config: workflow=${workflow}, review_mode=${mode}${peers ? `, peers=${peers}` : ""}${extraEnv.length ? ", serena=enabled" : ""}`);
}

function buildRemoveArgs(target: "claude" | "codex"): string[] {
  if (target === "claude") {
    return ["claude", "mcp", "remove", "--scope", "user", "code-assistant-peers"];
  }
  return ["codex", "mcp", "remove", "code-assistant-peers"];
}

function buildInstallArgs(
  target: "claude" | "codex",
  workflow: "review_only" | "peer_fix",
  mode: "normal" | "adversarial" | "gate" | "collaborative",
  peers?: string | null,
  extraEnv: string[] = [],
): string[] {
  if (target === "claude") {
    const envArgs = [
      "HOST_ASSISTANT=claude",
      `CODE_ASSISTANT_PEERS_WORKFLOW=${workflow}`,
      `CODE_ASSISTANT_PEERS_REVIEW_MODE=${mode}`,
      peers ? `PEER_ASSISTANTS=${peers}` : null,
      ...extraEnv,
    ].filter((value): value is string => Boolean(value));
    return [
      "claude",
      "mcp",
      "add",
      "--scope",
      "user",
      "--transport",
      "stdio",
      "code-assistant-peers",
      "--",
      "env",
      ...envArgs,
      "bun",
      SERVER_PATH,
    ];
  }
  const args = [
    "codex",
    "mcp",
    "add",
    "code-assistant-peers",
    "--env",
    "HOST_ASSISTANT=codex",
    "--env",
    `CODE_ASSISTANT_PEERS_WORKFLOW=${workflow}`,
    "--env",
    `CODE_ASSISTANT_PEERS_REVIEW_MODE=${mode}`,
  ];
  if (peers) args.push("--env", `PEER_ASSISTANTS=${peers}`);
  for (const value of extraEnv) args.push("--env", value);
  args.push("--", "bun", SERVER_PATH);
  return args;
}

type SetupOptions = {
  workflow: "review_only" | "peer_fix";
  mode: "normal" | "adversarial" | "gate" | "collaborative";
  peers: string | null;
  autoPeers: boolean;
  timeoutSec: number;
  installRulesDir: string | null;
  dryRun: boolean;
  serenaMode: "auto" | "on" | "off";
  serenaCommand: string | null;
};

function parseSetupOptions(args: string[]): SetupOptions {
  const options: SetupOptions = {
    workflow: "review_only",
    mode: "normal",
    peers: null,
    autoPeers: false,
    timeoutSec: 600,
    installRulesDir: null,
    dryRun: false,
    serenaMode: "auto",
    serenaCommand: null,
  };
  for (const arg of args) {
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--install-rules") {
      options.installRulesDir = process.cwd();
    } else if (arg.startsWith("--install-rules=")) {
      options.installRulesDir = resolve(arg.slice("--install-rules=".length));
    } else if (arg.startsWith("--workflow=")) {
      options.workflow = normalizeWorkflowArg(arg.slice("--workflow=".length));
    } else if (arg.startsWith("--mode=")) {
      options.mode = normalizeModeArg(arg.slice("--mode=".length));
    } else if (arg.startsWith("--peers=")) {
      const peers = arg.slice("--peers=".length).trim().toLowerCase();
      if (peers === "auto") {
        options.autoPeers = true;
        options.peers = null;
      } else {
        options.autoPeers = false;
        options.peers = normalizePeersArg(peers);
      }
    } else if (arg.startsWith("--timeout=")) {
      const timeout = Number(arg.slice("--timeout=".length));
      if (!Number.isInteger(timeout) || timeout < 30) {
        console.error("--timeout must be an integer >= 30");
        process.exit(1);
      }
      options.timeoutSec = timeout;
    } else if (arg.startsWith("--serena=")) {
      options.serenaMode = normalizeSerenaModeArg(arg.slice("--serena=".length));
    } else if (arg.startsWith("--serena-command=")) {
      options.serenaCommand = arg.slice("--serena-command=".length);
    } else {
      console.error(`Unknown setup option: ${arg}`);
      process.exit(1);
    }
  }
  return options;
}

function normalizeSerenaModeArg(value: string): "auto" | "on" | "off" {
  if (value === "auto" || value === "on" || value === "off") return value;
  console.error("Unsupported Serena mode. Use --serena=auto|on|off");
  process.exit(1);
}

function normalizePeersArg(value: string): string {
  const registry = loadAssistantRegistry();
  const peers = value.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean);
  if (peers.length === 0) {
    console.error("--peers must include at least one assistant id");
    process.exit(1);
  }
  for (const peer of peers) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(peer)) {
      console.error(`Invalid peer assistant id: ${peer}`);
      process.exit(1);
    }
    if (!registry[peer]) {
      console.error(`Unknown peer assistant id: ${peer}. Known assistants: ${Object.keys(registry).sort().join(", ")}`);
      process.exit(1);
    }
  }
  return [...new Set(peers)].join(",");
}

async function setupMcp(targets: readonly ("claude" | "codex")[], options: SetupOptions): Promise<void> {
  const setupAvailability = await detectAssistantSetupAvailability();
  if (!options.dryRun) validateSetupTargetsAvailable(targets, setupAvailability);
  const peers = options.autoPeers ? resolveAutoPeersForSetup(targets, buildAutoPeerSetupAvailability(setupAvailability)) : options.peers;
  validateSetupPeers(targets, peers);
  const serena = await detectSerenaSetup(options);
  const extraEnv = [...buildSerenaEnv(serena), ...buildCustomAssistantEnv()];
  console.log(`Setting up code-assistant-peers for ${targets.join(", ")}`);
  console.log(`workflow=${options.workflow}, mode=${options.mode}, timeout=${options.timeoutSec}s${peers ? `, peers=${peers}` : ""}`);
  console.log(`serena=${serena.enabled ? "enabled" : "disabled"} - ${serena.reason}`);

  for (const target of targets) {
    if (options.dryRun) {
      console.log(buildRemoveArgs(target).join(" ") + " || true");
      console.log(buildInstallCommand(target, options.workflow, options.mode, peers, extraEnv));
    } else {
      await reinstallMcp(target, options.workflow, options.mode, peers, extraEnv);
    }
  }

  if (targets.includes("codex")) {
    if (options.dryRun) {
      console.log(`# would ensure ~/.codex/config.toml has tool_timeout_sec = ${options.timeoutSec} for code-assistant-peers`);
    } else {
      const configPath = await upsertCodexTimeout(options.timeoutSec);
      console.log(`Updated Codex timeout in ${configPath}`);
    }
  }

  if (options.installRulesDir) {
    if (options.dryRun) {
      console.log(`# would install CLAUDE.md and AGENTS.md rules into ${options.installRulesDir}`);
    } else {
      await installRules(options.installRulesDir);
      console.log(`Installed project rules into ${options.installRulesDir}`);
    }
  }

  console.log("Setup complete. Restart the MCP client, then call code_assistant_peers_setup from Claude/Codex to verify runtime availability.");
}

function buildCustomAssistantEnv(): string[] {
  const customAssistants = process.env.CODE_ASSISTANT_PEERS_ASSISTANTS?.trim();
  return customAssistants ? [`CODE_ASSISTANT_PEERS_ASSISTANTS=${customAssistants}`] : [];
}

function resolveAutoPeersForSetup(
  targets: readonly ("claude" | "codex")[],
  availability: AssistantSetupAvailability,
): string {
  try {
    const result = resolveAutoPeerSetupConfig(targets, availability);
    console.log(`auto peers=${result.peers}`);
    const skipped = result.skipped
      .filter((item) => !result.selected.includes(item.id) && item.reason !== "same as the only setup target")
      .map((item) => `${item.id}: ${item.reason}`);
    if (skipped.length > 0) console.log(`auto peer skips: ${skipped.join("; ")}`);
    return result.peers;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

async function detectSerenaSetup(options: SetupOptions): Promise<SerenaSetupConfig> {
  try {
    return resolveSerenaSetupConfig({
      mode: options.serenaMode,
      explicitCommand: options.serenaCommand ?? process.env.CODE_ASSISTANT_PEERS_SERENA_COMMAND,
      hasSerenaBinary: await commandExists("serena"),
      hasUvx: await commandExists("uvx"),
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

async function upsertCodexTimeout(timeoutSec: number): Promise<string> {
  const home = process.env.HOME;
  if (!home) {
    throw new Error("HOME is required to update Codex config.");
  }
  const configPath = join(home, ".codex", "config.toml");
  await mkdir(dirname(configPath), { recursive: true });
  const current = existsSync(configPath) ? await readFile(configPath, "utf8") : "";
  const updated = upsertCodexMcpTimeoutConfig(current, SERVER_PATH, timeoutSec);
  const tempPath = `${configPath}.${process.pid}.tmp`;
  await writeFile(tempPath, updated);
  await rename(tempPath, configPath);
  return configPath;
}

function validateSetupPeers(targets: readonly ("claude" | "codex")[], peers: string | null): void {
  if (!peers) return;
  const peerSet = new Set(peers.split(","));
  for (const target of targets) {
    const remainingPeers = [...peerSet].filter((peer) => setupBaseAssistantId(peer) !== target);
    if (remainingPeers.length === 0) {
      console.error(`--peers=${peers} leaves no peer reviewer for HOST_ASSISTANT=${target}. Include at least one assistant different from ${target}.`);
      process.exit(1);
    }
  }
}

function setupBaseAssistantId(id: string): string {
  return id.endsWith("-live") ? id.slice(0, -"-live".length) : id;
}

function validateSetupTargetsAvailable(
  targets: readonly ("claude" | "codex")[],
  availability: AssistantSetupAvailability,
): void {
  const missing = targets.filter((target) => !availability[target]?.ok);
  if (missing.length === 0) return;
  for (const target of missing) {
    console.error(`Cannot register ${target}: ${availability[target]?.detail ?? "not checked"}`);
  }
  process.exit(1);
}

async function runCommand(args: string[], allowFailure: boolean): Promise<void> {
  console.log(`$ ${args.join(" ")}`);
  const proc = Bun.spawn(args, {
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0 && allowFailure) {
    console.warn(`Ignored non-zero exit ${exitCode} from optional command: ${args.join(" ")}`);
  }
  if (exitCode !== 0 && !allowFailure) {
    process.exit(exitCode);
  }
}

async function runDoctor(): Promise<void> {
  const checks: Array<{ name: string; passed: boolean; detail: string; fatal: boolean }> = [];
  checks.push({
    name: "Bun >= 1.0",
    passed: isBunVersionAtLeast(1, 0),
    detail: Bun.version,
    fatal: true,
  });
  const setupAvailability = await detectAssistantSetupAvailability();
  const autoAvailability = buildAutoPeerSetupAvailability(setupAvailability);
  const serena = await detectSerenaSetup({
    workflow: "review_only",
    mode: "normal",
    peers: null,
    autoPeers: false,
    timeoutSec: 600,
    installRulesDir: null,
    dryRun: false,
    serenaMode: "auto",
    serenaCommand: null,
  });
  checks.push({ name: "Claude CLI", passed: Boolean(setupAvailability.claude?.ok), detail: setupAvailability.claude?.detail ?? "not checked", fatal: false });
  checks.push({ name: "Codex CLI", passed: Boolean(setupAvailability.codex?.ok), detail: setupAvailability.codex?.detail ?? "not checked", fatal: false });
  checks.push({ name: "Gemini CLI", passed: Boolean(setupAvailability.gemini?.ok), detail: setupAvailability.gemini?.detail ?? "not checked", fatal: false });
  checks.push({ name: "Serena semantic context", passed: serena.enabled, detail: serena.reason, fatal: false });
  checks.push({
    name: "Codex MCP timeout",
    passed: !setupAvailability.codex?.ok || await codexTimeoutOk(),
    detail: setupAvailability.codex?.ok ? "tool_timeout_sec >= 600 recommended" : "skipped because Codex CLI was not found",
    fatal: false,
  });

  let ok = true;
  for (const check of checks) {
    if (check.fatal) ok &&= check.passed;
    const label = check.passed ? "OK " : check.fatal ? "ERR" : "WARN";
    console.log(`${label} ${check.name}${check.detail ? ` - ${check.detail}` : ""}`);
  }
  if (!setupAvailability.claude?.ok && !setupAvailability.codex?.ok && !setupAvailability.gemini?.ok) {
    ok = false;
    console.log("ERR At least one assistant CLI is required.");
  }
  printAutoPeerRecommendation(autoAvailability);
  console.log(`Store: ${getStoreDir()}`);
  console.log(`Database: ${getDatabasePath()}`);
  if (!ok) {
    console.log("Run: bun cli.ts setup both --timeout=600");
    process.exit(1);
  }
}

async function detectAssistantSetupAvailability(): Promise<AssistantSetupAvailability> {
  const [[claudeOk, claudeDetail], [codexOk, codexDetail], [geminiOk, geminiDetail]] = await Promise.all([
    binaryCheck("claude"),
    binaryCheck("codex"),
    binaryCheck("gemini"),
  ]);
  const availability: AssistantSetupAvailability = {
    claude: { ok: claudeOk, detail: claudeDetail || "command 'claude' not found" },
    codex: { ok: codexOk, detail: codexDetail || "command 'codex' not found" },
    gemini: { ok: geminiOk, detail: geminiDetail || "command 'gemini' not found" },
  };
  if (geminiOk) {
    const geminiAuth = await getGeminiAuthReadiness(process.env);
    availability.gemini = geminiAuth.ok
      ? { ok: true, detail: geminiDetail || geminiAuth.detail }
      : geminiAuth;
  }
  return availability;
}

function buildAutoPeerSetupAvailability(availability: AssistantSetupAvailability): AssistantSetupAvailability {
  const autoAvailability = { ...availability };
  const geminiDetail = availability.gemini?.detail ?? "";
  if (availability.gemini?.ok || geminiDetail.startsWith("gemini found")) {
    autoAvailability.gemini = getGeminiSetupAutoReadiness(process.env);
  }
  return autoAvailability;
}

function getGeminiSetupAutoReadiness(env: NodeJS.ProcessEnv): { ok: boolean; detail: string } {
  return resolveGeminiAutoPeerReadiness(env);
}

function printAutoPeerRecommendation(availability: AssistantSetupAvailability): void {
  for (const target of ["claude", "codex"] as const) {
    if (!availability[target]?.ok) continue;
    try {
      const result = resolveAutoPeerSetupConfig([target], availability);
      console.log(`Recommended ${target} setup: bun cli.ts setup ${target} --peers=auto  # PEER_ASSISTANTS=${result.peers}`);
    } catch {
      // The explicit WARN lines above already explain which CLIs are missing.
    }
  }
}

function isBunVersionAtLeast(major: number, minor: number): boolean {
  const [actualMajor, actualMinor] = Bun.version.split(".").map((part) => Number(part));
  return actualMajor > major || (actualMajor === major && actualMinor >= minor);
}

async function binaryCheck(command: string): Promise<[boolean, string]> {
  try {
    const proc = Bun.spawn(["/usr/bin/env", "which", command], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return [exitCode === 0, (stdout || stderr).trim()];
  } catch (error) {
    return [false, error instanceof Error ? error.message : String(error)];
  }
}

async function commandExists(command: string): Promise<boolean> {
  const [ok] = await binaryCheck(command);
  return ok;
}

async function codexTimeoutOk(): Promise<boolean> {
  const home = process.env.HOME;
  if (!home) return false;
  const configPath = join(home, ".codex", "config.toml");
  if (!existsSync(configPath)) return false;
  const config = await readFile(configPath, "utf8");
  const sectionMatch = config.match(/\[mcp_servers\.code-assistant-peers\]([\s\S]*?)(?=\n\[|$)/);
  if (!sectionMatch) return false;
  const timeoutMatch = sectionMatch[1].match(/^\s*tool_timeout_sec\s*=\s*(\d+)/m);
  return Number(timeoutMatch?.[1] ?? 0) >= 600;
}

async function installRules(targetDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  await upsertRuleBlock(join(targetDir, "CLAUDE.md"));
  await upsertRuleBlock(join(targetDir, "AGENTS.md"));
}

async function upsertRuleBlock(path: string): Promise<void> {
  if (!existsSync(path)) {
    await writeFile(path, `${PROJECT_RULE_BLOCK}\n`);
    return;
  }

  const current = await readFile(path, "utf8");
  const start = "<!-- code-assistant-peers:start -->";
  const end = "<!-- code-assistant-peers:end -->";
  const startIndex = current.indexOf(start);
  const endIndex = current.indexOf(end);
  if ((startIndex === -1) !== (endIndex === -1) || (startIndex !== -1 && endIndex <= startIndex)) {
    throw new Error(`Invalid existing code-assistant-peers rule markers in ${path}. Fix or remove the partial marker block before reinstalling rules.`);
  }
  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    const suffix = current.slice(endIndex + end.length);
    const separatedSuffix = suffix.length > 0 && !suffix.startsWith("\n") ? `\n${suffix}` : suffix;
    const updated = `${current.slice(0, startIndex)}${PROJECT_RULE_BLOCK}${separatedSuffix}`;
    await writeFile(path, updated.endsWith("\n") ? updated : `${updated}\n`);
    return;
  }

  await appendFile(path, `${current.endsWith("\n") ? "\n" : "\n\n"}${PROJECT_RULE_BLOCK}\n`);
}
