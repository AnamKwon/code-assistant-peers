import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  NewPeerReviewFinding,
  PeerReviewFinding,
  PeerReviewResult,
  PeerReviewRound,
  PeerTask,
} from "./types.ts";

const STORE_DIR = process.env.CODE_ASSISTANT_PEERS_HOME
  ?? `${process.env.HOME}/.mcp-code-assistant-peers`;
const DB_PATH = join(STORE_DIR, "store.sqlite");

let db: Database | null = null;

export function getStoreDir(): string {
  return STORE_DIR;
}

export function taskPath(id: string): string {
  return join(STORE_DIR, "tasks", `${id}.json`);
}

export function getDatabasePath(): string {
  return DB_PATH;
}

export async function saveTask(task: PeerTask): Promise<void> {
  initDb();
  const now = new Date().toISOString();
  task.updated_at = task.updated_at || now;
  upsertTaskRow(task);
  await writeTaskMirror(task);
}

export async function loadTask(id: string): Promise<PeerTask | null> {
  initDb();
  const row = database()
    .query("SELECT task_json FROM tasks WHERE id = ?")
    .get(id) as { task_json: string } | null;
  if (row) return JSON.parse(row.task_json) as PeerTask;

  const file = Bun.file(taskPath(id));
  if (!(await file.exists())) return null;
  const task = await file.json() as PeerTask;
  await saveTask(task);
  return task;
}

export async function listTasks(): Promise<PeerTask[]> {
  initDb();
  await migrateJsonTasks();
  const rows = database()
    .query("SELECT task_json FROM tasks ORDER BY created_at DESC")
    .all() as { task_json: string }[];
  return rows.map((row) => JSON.parse(row.task_json) as PeerTask);
}

export async function claimStaleReviewRecovery(
  taskId: string,
  expectedSignature: string,
  staleBeforeIso: string,
): Promise<PeerTask | null> {
  initDb();
  const claimed = database().transaction(() => {
    const row = database()
      .query("SELECT task_json FROM tasks WHERE id = ?")
      .get(taskId) as { task_json: string } | null;
    if (!row) return null;
    const task = JSON.parse(row.task_json) as PeerTask;
    if (task.review_signature !== expectedSignature) return null;
    if (task.status !== "queued" && task.status !== "running") return null;
    if (Date.parse(task.updated_at) > Date.parse(staleBeforeIso)) return null;

    task.status = "queued";
    task.updated_at = new Date().toISOString();
    upsertTaskRow(task);
    return task;
  })();

  if (claimed) await writeTaskMirror(claimed);
  return claimed;
}

export async function appendReviewRound(
  task: PeerTask,
  review: PeerReviewResult,
  prompt: string,
): Promise<PeerReviewRound> {
  initDb();
  const round = insertReviewRound(task, review, prompt);
  task.updated_at = review.completed_at;
  upsertTaskRow(task);
  await writeTaskMirror(task);
  return round;
}

export async function appendReviewRoundAndSaveTask(
  task: PeerTask,
  review: PeerReviewResult,
  prompt: string,
): Promise<PeerReviewRound> {
  initDb();
  const round = database().transaction(() => {
    const inserted = insertReviewRound(task, review, prompt);
    upsertTaskRow(task);
    return inserted;
  })();
  await writeTaskMirror(task);
  return round;
}

export async function listReviewRounds(taskId: string): Promise<PeerReviewRound[]> {
  initDb();
  const rows = database()
    .query("SELECT * FROM review_rounds WHERE task_id = ? ORDER BY round ASC")
    .all(taskId) as ReviewRoundRow[];
  return rows.map(toReviewRound);
}

export async function getReviewRound(taskId: string, round: number): Promise<PeerReviewRound | null> {
  initDb();
  const row = database()
    .query("SELECT * FROM review_rounds WHERE task_id = ? AND round = ?")
    .get(taskId, round) as ReviewRoundRow | null;
  return row ? toReviewRound(row) : null;
}

export async function addFindings(
  taskId: string,
  reviewRoundId: number | null,
  findings: NewPeerReviewFinding[],
): Promise<PeerReviewFinding[]> {
  initDb();
  const now = new Date().toISOString();
  const inserted: PeerReviewFinding[] = [];
  const stmt = database().prepare(`
    INSERT INTO review_findings (
      task_id, review_round_id, severity, file, line, message, status, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const finding of findings) {
    const result = stmt.run(
      taskId,
      reviewRoundId,
      finding.severity,
      finding.file ?? null,
      finding.line ?? null,
      finding.message,
      finding.status ?? "open",
      now,
      now,
    );
    inserted.push({
      id: Number(result.lastInsertRowid),
      task_id: taskId,
      review_round_id: reviewRoundId,
      severity: finding.severity,
      file: finding.file ?? null,
      line: finding.line ?? null,
      message: finding.message,
      status: finding.status ?? "open",
      created_at: now,
      updated_at: now,
    });
  }
  return inserted;
}

export async function listFindings(taskId: string, status?: string): Promise<PeerReviewFinding[]> {
  initDb();
  const rows = status
    ? database()
      .query("SELECT * FROM review_findings WHERE task_id = ? AND status = ? ORDER BY id ASC")
      .all(taskId, status)
    : database()
      .query("SELECT * FROM review_findings WHERE task_id = ? ORDER BY id ASC")
      .all(taskId);
  return rows as PeerReviewFinding[];
}

export async function compactTaskHistory(taskId: string): Promise<string> {
  const task = await loadTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  const rounds = await listReviewRounds(taskId);
  const findings = await listFindings(taskId);
  const summary = [
    `Task ${task.id}`,
    `Request: ${task.prompt}`,
    `Status: ${task.status}`,
    `Review rounds: ${rounds.length}`,
    findings.length > 0 ? `Findings:\n${findings.map((f) => `- [${f.status}] ${f.severity}: ${formatFindingLocation(f)}${f.message}`).join("\n")}` : "Findings: none recorded",
  ].join("\n\n");

  database()
    .prepare(`
      INSERT INTO task_compactions (task_id, summary, created_at)
      VALUES (?, ?, ?)
    `)
    .run(taskId, summary, new Date().toISOString());
  return summary;
}

export async function gcStore(days: number): Promise<{ deletedReviewRounds: number; deletedCompactions: number }> {
  initDb();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const deletedReviewRounds = database()
    .prepare(`
      DELETE FROM review_rounds
      WHERE completed_at < ?
        AND task_id NOT IN (
          SELECT DISTINCT task_id FROM review_findings WHERE status = 'open'
        )
    `)
    .run(cutoff).changes;
  const deletedCompactions = database()
    .prepare("DELETE FROM task_compactions WHERE created_at < ?")
    .run(cutoff).changes;
  return { deletedReviewRounds, deletedCompactions };
}

function initDb(): void {
  if (db) return;
  mkdirSync(STORE_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 3000");
  db.run(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      host TEXT NOT NULL,
      peer TEXT NOT NULL,
      prompt TEXT NOT NULL,
      cwd TEXT NOT NULL,
      git_root TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      task_json TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS review_rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      round INTEGER NOT NULL,
      reviewer TEXT NOT NULL,
      command_json TEXT NOT NULL,
      exit_code INTEGER,
      stdout TEXT NOT NULL,
      stderr TEXT NOT NULL,
      prompt TEXT NOT NULL,
      warning TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      UNIQUE(task_id, round)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS review_findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      review_round_id INTEGER,
      severity TEXT NOT NULL,
      file TEXT,
      line INTEGER,
      message TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS task_compactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  // review_findings is scanned by task_id (and task_id+status) on every status read;
  // without an index those lookups degrade to full table scans as the store grows.
  db.run("CREATE INDEX IF NOT EXISTS idx_review_findings_task ON review_findings(task_id, status)");
  db.run("CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at DESC)");
}

function database(): Database {
  initDb();
  return db!;
}

function upsertTaskRow(task: PeerTask): void {
  database()
    .prepare(`
      INSERT INTO tasks (id, host, peer, prompt, cwd, git_root, status, created_at, updated_at, task_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        host = excluded.host,
        peer = excluded.peer,
        prompt = excluded.prompt,
        cwd = excluded.cwd,
        git_root = excluded.git_root,
        status = excluded.status,
        updated_at = excluded.updated_at,
        task_json = excluded.task_json
    `)
    .run(
      task.id,
      task.host,
      task.peer,
      task.prompt,
      task.cwd,
      task.git_root,
      task.status,
      task.created_at,
      task.updated_at,
      JSON.stringify(task),
    );
}

async function writeTaskMirror(task: PeerTask): Promise<void> {
  // Keep a JSON mirror for easy manual inspection and backward compatibility.
  await mkdir(join(STORE_DIR, "tasks"), { recursive: true });
  await Bun.write(taskPath(task.id), `${JSON.stringify(task, null, 2)}\n`);
}

function insertReviewRound(
  task: PeerTask,
  review: PeerReviewResult,
  prompt: string,
): PeerReviewRound {
  const result = database()
    .prepare(`
      INSERT INTO review_rounds (
        task_id, round, reviewer, command_json, exit_code, stdout, stderr,
        prompt, warning, started_at, completed_at
      )
      SELECT ?, COALESCE(MAX(round), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ?
      FROM review_rounds
      WHERE task_id = ?
    `)
    .run(
      task.id,
      review.reviewer,
      JSON.stringify(review.command),
      review.exit_code,
      review.stdout,
      review.stderr,
      prompt,
      review.warning ?? null,
      review.started_at,
      review.completed_at,
      task.id,
    );
  const inserted = database()
    .query("SELECT * FROM review_rounds WHERE id = ?")
    .get(Number(result.lastInsertRowid)) as ReviewRoundRow;

  return toReviewRound(inserted);
}

async function migrateJsonTasks(): Promise<void> {
  const tasksDir = join(STORE_DIR, "tasks");
  if (!existsSync(tasksDir)) return;

  const glob = new Bun.Glob("*.json");
  for await (const name of glob.scan(tasksDir)) {
    const file = Bun.file(join(tasksDir, name));
    const task = await file.json() as PeerTask;
    const exists = database().query("SELECT id FROM tasks WHERE id = ?").get(task.id);
    if (!exists) await saveTask(task);
  }
}

interface ReviewRoundRow {
  id: number;
  task_id: string;
  round: number;
  reviewer: string;
  command_json: string;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  prompt: string;
  warning: string | null;
  started_at: string;
  completed_at: string;
}

function toReviewRound(row: ReviewRoundRow): PeerReviewRound {
  return {
    id: row.id,
    task_id: row.task_id,
    round: row.round,
    reviewer: row.reviewer,
    command: JSON.parse(row.command_json) as string[],
    exit_code: row.exit_code,
    stdout: row.stdout,
    stderr: row.stderr,
    prompt: row.prompt,
    warning: row.warning ?? undefined,
    started_at: row.started_at,
    completed_at: row.completed_at,
  };
}

function formatFindingLocation(finding: PeerReviewFinding): string {
  if (!finding.file) return "";
  return finding.line ? `${finding.file}:${finding.line} - ` : `${finding.file} - `;
}
