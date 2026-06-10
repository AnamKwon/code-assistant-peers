import type { GitStatusEntry, ReviewScope, WorkspaceSnapshot } from "./types.ts";
import { diffWorkspaceSnapshot } from "./workspace-snapshot.ts";

export async function getGitRoot(cwd: string): Promise<string | null> {
  const result = await runGit(["rev-parse", "--show-toplevel"], cwd);
  if (result.exitCode !== 0) return null;
  return result.stdout.trim() || null;
}

export async function getStatusEntries(cwd: string): Promise<GitStatusEntry[]> {
  const result = await runGit(["status", "--porcelain=v1", "-z"], cwd);
  if (result.exitCode !== 0 || !result.stdout) return [];
  return parseStatusEntriesZ(result.stdout);
}

/**
 * Parse `git status --porcelain=v1 -z` output. In `-z` mode a rename/copy entry is
 * emitted as two NUL-separated fields: the status record (`R  <new>`) followed by the
 * original path. The trailing original-path field is consumed so it is not parsed as a
 * phantom entry.
 */
export function parseStatusEntriesZ(stdout: string): GitStatusEntry[] {
  const segments = stdout.split("\0");
  const entries: GitStatusEntry[] = [];
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (!segment) continue;
    const code = segment.slice(0, 2);
    entries.push({ code, path: segment.slice(3) });
    if (code.includes("R") || code.includes("C")) i++;
  }
  return entries;
}

export async function getUncommittedDiff(cwd: string, statusEntries?: GitStatusEntry[]): Promise<string> {
  const [staged, unstaged, untracked] = await Promise.all([
    runGit(["diff", "--cached", "--no-ext-diff"], cwd),
    runGit(["diff", "--no-ext-diff"], cwd),
    getUntrackedFileSummaries(cwd, statusEntries),
  ]);

  const parts = [];
  if (staged.stdout.trim()) parts.push(`# Staged diff\n\n${staged.stdout}`);
  if (unstaged.stdout.trim()) parts.push(`# Unstaged diff\n\n${unstaged.stdout}`);
  if (untracked.trim()) parts.push(`# Untracked files\n\n${untracked}`);
  return parts.join("\n\n");
}

export async function getChangedFiles(cwd: string): Promise<string[]> {
  const staged = await runGit(["diff", "--cached", "--name-only"], cwd);
  const unstaged = await runGit(["diff", "--name-only"], cwd);
  const untracked = await runGit(["ls-files", "--others", "--exclude-standard"], cwd);
  const files = [
    ...staged.stdout.trim().split("\n"),
    ...unstaged.stdout.trim().split("\n"),
    ...untracked.stdout.trim().split("\n"),
  ].filter(Boolean);
  return [...new Set(files)].sort();
}

export async function getReviewDiff(
  cwd: string,
  options: { scope?: ReviewScope; base?: string | null; baselineWorkspaceSnapshot?: WorkspaceSnapshot | null } = {},
): Promise<{ label: string; diff: string; changedFiles: string[]; warning?: string }> {
  const scope = options.scope ?? "auto";
  const base = options.base?.trim() || null;
  const gitRoot = await getGitRoot(cwd);

  if (!gitRoot) {
    if (options.baselineWorkspaceSnapshot) {
      const snapshotDiff = await diffWorkspaceSnapshot(cwd, options.baselineWorkspaceSnapshot);
      return {
        label: "non-git workspace snapshot diff",
        ...snapshotDiff,
      };
    }
    return {
      label: "non-git workspace snapshot diff",
      diff: "",
      changedFiles: [],
      warning: "Git metadata is not available for this task cwd, and no baseline workspace snapshot was captured. Pass change_summary/files_changed or call begin_peer_task before editing so non-git changes can be reviewed.",
    };
  }

  if (base || scope === "branch") {
    const resolvedBase = base ?? await detectDefaultBranch(cwd);
    if (!resolvedBase) {
      return {
        ...await getWorkingTreeReview(cwd),
        warning: "Branch review was requested, but no default branch could be detected. Fell back to working tree review.",
      };
    }
    const mergeBase = await runGit(["merge-base", "HEAD", resolvedBase], cwd);
    const range = mergeBase.exitCode === 0 && mergeBase.stdout.trim()
      ? `${mergeBase.stdout.trim()}..HEAD`
      : `${resolvedBase}...HEAD`;
    const diff = await runGit(["diff", "--binary", "--no-ext-diff", "--submodule=diff", range], cwd);
    const files = await runGit(["diff", "--name-only", range], cwd);
    return {
      label: `branch diff against ${resolvedBase}`,
      diff: diff.stdout,
      changedFiles: files.stdout.trim().split("\n").filter(Boolean).sort(),
      warning: diff.exitCode === 0 ? undefined : diff.stderr.trim() || "Unable to collect branch diff.",
    };
  }

  return await getWorkingTreeReview(cwd);
}

async function getWorkingTreeReview(cwd: string): Promise<{ label: string; diff: string; changedFiles: string[] }> {
  // Collect status once and reuse it for the untracked-file summaries instead of
  // re-running `git status`, and run the diff and changed-file collection concurrently.
  const statusEntries = await getStatusEntries(cwd);
  const [diff, changedFiles] = await Promise.all([
    getUncommittedDiff(cwd, statusEntries),
    getChangedFiles(cwd),
  ]);
  return { label: "working tree diff", diff, changedFiles };
}

export function formatStatus(entries: GitStatusEntry[]): string {
  if (entries.length === 0) return "(clean)";
  return entries.map((entry) => `${entry.code} ${entry.path}`).join("\n");
}

async function getUntrackedFileSummaries(cwd: string, statusEntries?: GitStatusEntry[]): Promise<string> {
  const status = statusEntries ?? await getStatusEntries(cwd);
  const untracked = status.filter((entry) => entry.code === "??").map((entry) => entry.path);
  if (untracked.length === 0) return "";

  const summaries = await Promise.all(untracked.slice(0, 40).map(async (path) => {
    const result = await runGit(["--no-pager", "diff", "--no-index", "--", "/dev/null", path], cwd);
    return result.stdout.trim() ? result.stdout : `Untracked: ${path}`;
  }));
  const lines = [...summaries];
  if (untracked.length > 40) {
    lines.push(`... ${untracked.length - 40} more untracked file(s) omitted`);
  }
  return lines.join("\n\n");
}

async function detectDefaultBranch(cwd: string): Promise<string | null> {
  const remoteHead = await runGit(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd);
  const remote = remoteHead.stdout.trim();
  if (remoteHead.exitCode === 0 && remote.startsWith("refs/remotes/origin/")) {
    return remote.replace("refs/remotes/origin/", "");
  }

  for (const candidate of ["main", "master", "trunk"]) {
    const local = await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`], cwd);
    if (local.exitCode === 0) return candidate;
    const origin = await runGit(["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`], cwd);
    if (origin.exitCode === 0) return `origin/${candidate}`;
  }
  return null;
}

async function runGit(args: string[], cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}
