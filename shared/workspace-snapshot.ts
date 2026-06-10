import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import type { FileSnapshotEntry, WorkspaceSnapshot } from "./types.ts";

const EXCLUDED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "vendor",
  ".venv",
  "venv",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
]);

// Guard against non-numeric env overrides: a NaN limit would silently disable the
// cap (e.g. `captured >= NaN` is always false), letting the walk read the entire tree.
function positiveIntEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const MAX_FILES = positiveIntEnv(process.env.CODE_ASSISTANT_PEERS_NONGIT_MAX_FILES, 500);
const MAX_TEXT_BYTES = positiveIntEnv(process.env.CODE_ASSISTANT_PEERS_NONGIT_MAX_TEXT_BYTES, 200_000);
const MAX_DIFF_TEXT_CHARS = positiveIntEnv(process.env.CODE_ASSISTANT_PEERS_NONGIT_DIFF_TEXT_CHARS, 8_000);

export async function captureWorkspaceSnapshot(cwd: string): Promise<WorkspaceSnapshot> {
  const files: Record<string, FileSnapshotEntry> = {};
  const warnings: string[] = [];
  let truncated = false;
  let captured = 0;

  for await (const path of walkFiles(cwd, "", warnings)) {
    if (captured >= MAX_FILES) {
      truncated = true;
      break;
    }
    try {
      files[path] = await readSnapshotEntry(cwd, path);
      captured += 1;
    } catch (error) {
      warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    captured_at: new Date().toISOString(),
    files,
    truncated,
    warning: warnings.length ? `Some files could not be captured: ${warnings.slice(0, 5).join("; ")}` : undefined,
  };
}

export function emptyWorkspaceSnapshot(warning?: string): WorkspaceSnapshot {
  return {
    captured_at: new Date().toISOString(),
    files: {},
    warning,
  };
}

export async function diffWorkspaceSnapshot(
  cwd: string,
  baseline: WorkspaceSnapshot,
): Promise<{ diff: string; changedFiles: string[]; warning?: string }> {
  const warnings: string[] = [];
  const current = await captureWorkspaceSnapshot(cwd);

  // Baseline-tracked files that the bounded walk did not capture (truncated, deleted,
  // or excluded) are read individually here. Files already present in `current` are
  // reused instead of being read a second time.
  const currentBaselinePaths: Record<string, FileSnapshotEntry> = {};
  for (const path of Object.keys(baseline.files)) {
    if (current.files[path]) continue;
    try {
      currentBaselinePaths[path] = await readSnapshotEntry(cwd, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const paths = new Set([
    ...Object.keys(baseline.files),
    ...(!baseline.truncated ? Object.keys(current.files) : []),
  ]);
  const changedFiles: string[] = [];
  const sections: string[] = [];

  for (const path of [...paths].sort()) {
    const before = baseline.files[path];
    const after = current.files[path] ?? currentBaselinePaths[path];
    const sensitivePossibleChange = Boolean(before?.sensitive || after?.sensitive) && Boolean(before && after);
    if (!sensitivePossibleChange && before && after && fingerprintOf(before) === fingerprintOf(after)) continue;

    changedFiles.push(path);
    if (!before && after) {
      sections.push(formatFileSection("Added", path, undefined, after));
    } else if (before && !after) {
      sections.push(formatFileSection("Deleted", path, before, undefined));
    } else if (before && after) {
      sections.push(formatFileSection("Modified", path, before, after));
    }
  }

  const warning = [
    "Git metadata was not available for this task cwd, so changes were computed from a bounded file snapshot captured when the task began.",
    "Sensitive files are not read or content-hashed; matching sensitive paths are reported as possible changes so reviewers do not silently miss same-size/timestamp-preserved credential edits.",
    baseline.truncated || current.truncated ? `Snapshot file count was capped at ${MAX_FILES}; additions outside the captured set may be omitted.` : "",
    baseline.warning,
    current.warning,
    warnings.length ? `Some baseline paths could not be recaptured: ${warnings.slice(0, 5).join("; ")}` : "",
  ].filter(Boolean).join(" ");

  return {
    diff: sections.length ? `# Non-git workspace snapshot diff\n\n${sections.join("\n\n")}` : "",
    changedFiles,
    warning,
  };
}

async function readSnapshotEntry(cwd: string, path: string): Promise<FileSnapshotEntry> {
  const absolute = join(cwd, path);
  const fileStat = await stat(absolute);
  if (isSensitivePath(path)) {
    return {
      fingerprint: `sensitive:${fileStat.size}:${Math.trunc(fileStat.mtimeMs)}`,
      size: fileStat.size,
      sensitive: true,
      omitted: "sensitive path",
    };
  }
  const buffer = await readFile(absolute);
  const entry: FileSnapshotEntry = {
    fingerprint: createHash("sha256").update(buffer).digest("hex"),
    size: buffer.byteLength,
  };
  if (buffer.byteLength > MAX_TEXT_BYTES) {
    entry.omitted = `file is larger than ${MAX_TEXT_BYTES} bytes`;
  } else if (isProbablyBinary(buffer)) {
    entry.binary = true;
    entry.omitted = "binary file";
  } else {
    entry.text = buffer.toString("utf8");
  }
  return entry;
}

function formatFileSection(
  kind: "Added" | "Deleted" | "Modified",
  path: string,
  before: FileSnapshotEntry | undefined,
  after: FileSnapshotEntry | undefined,
): string {
  const lines = [`## ${kind}: ${path}`];
  if (before) lines.push(`Before: ${describeEntry(before)}`);
  if (after) lines.push(`After: ${describeEntry(after)}`);

  if (before?.text !== undefined || after?.text !== undefined) {
    if (before?.text !== undefined) {
      lines.push(`--- baseline/${path}`);
      lines.push(truncateText(before.text));
    }
    if (after?.text !== undefined) {
      lines.push(`+++ current/${path}`);
      lines.push(truncateText(after.text));
    }
  }
  return lines.join("\n");
}

function describeEntry(entry: FileSnapshotEntry): string {
  const traits = [`${entry.size} bytes`];
  if (!entry.sensitive) traits.push(`sha256 ${fingerprintOf(entry).slice(0, 12)}`);
  if (entry.binary) traits.push("binary");
  if (entry.omitted) traits.push(entry.omitted);
  return traits.join(", ");
}

function fingerprintOf(entry: FileSnapshotEntry): string {
  return entry.fingerprint ?? entry.sha256 ?? "";
}

function truncateText(text: string): string {
  if (text.length <= MAX_DIFF_TEXT_CHARS) return text;
  return `${text.slice(0, MAX_DIFF_TEXT_CHARS)}\n... truncated ${text.length - MAX_DIFF_TEXT_CHARS} char(s) ...`;
}

function isProbablyBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, Math.min(buffer.length, 4096)).includes(0);
}

async function* walkFiles(root: string, dir = "", warnings: string[] = []): AsyncGenerator<string> {
  const absoluteDir = join(root, dir);
  let entries;
  try {
    entries = await readdir(absoluteDir, { withFileTypes: true });
  } catch (error) {
    warnings.push(`${dir || "."}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      yield* walkFiles(root, rel, warnings);
    } else if (entry.isFile()) {
      yield normalizePath(rel);
    }
  }
}

function normalizePath(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

function isSensitivePath(path: string): boolean {
  const parts = path.toLowerCase().split("/");
  const name = parts[parts.length - 1] ?? "";
  const normalized = parts.join("/");
  const sensitiveNamePattern = /(^|[^a-z0-9])(secret|secrets|credential|credentials|creds|token|password|passwd|private[_-]?key|api[_-]?key)([^a-z0-9]|$)/;
  const authConfigPattern = /(^|[^a-z0-9])(auth|oauth)([^a-z0-9]|$)/;
  return name === ".env"
    || name.startsWith(".env.")
    || name.endsWith(".pem")
    || name.endsWith(".key")
    || name.endsWith(".p12")
    || name.endsWith(".pfx")
    || name === ".npmrc"
    || name === ".netrc"
    || name === "credentials"
    || name === "credentials.json"
    || name === "id_rsa"
    || name === "id_ed25519"
    || parts.includes(".ssh")
    || parts.includes(".aws")
    || parts.includes(".gcp")
    || parts.includes(".gemini")
    || parts.includes(".kube")
    || parts.includes(".docker")
    || normalized.includes(".config/gcloud")
    || sensitiveNamePattern.test(normalized)
    || (authConfigPattern.test(normalized) && !isLikelySourcePath(name));
}

function isLikelySourcePath(name: string): boolean {
  return /\.(c|cc|cpp|cs|css|go|h|hpp|html|java|js|jsx|kt|m|mm|php|py|rb|rs|scala|scss|sh|swift|ts|tsx|vue)$/.test(name);
}
