import type { GitStatusEntry, ReviewScope } from "./types.ts";

export async function getGitRoot(cwd: string): Promise<string | null> {
  const result = await runGit(["rev-parse", "--show-toplevel"], cwd);
  if (result.exitCode !== 0) return null;
  return result.stdout.trim() || null;
}

export async function getStatusEntries(cwd: string): Promise<GitStatusEntry[]> {
  const result = await runGit(["status", "--porcelain=v1", "-z"], cwd);
  if (result.exitCode !== 0 || !result.stdout) return [];

  return result.stdout
    .split("\0")
    .filter(Boolean)
    .map((entry) => ({
      code: entry.slice(0, 2),
      path: entry.slice(3),
    }));
}

export async function getUncommittedDiff(cwd: string): Promise<string> {
  const staged = await runGit(["diff", "--cached", "--no-ext-diff"], cwd);
  const unstaged = await runGit(["diff", "--no-ext-diff"], cwd);
  const untracked = await getUntrackedFileSummaries(cwd);

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
  options: { scope?: ReviewScope; base?: string | null } = {},
): Promise<{ label: string; diff: string; changedFiles: string[]; warning?: string }> {
  const scope = options.scope ?? "auto";
  const base = options.base?.trim() || null;

  if (base || scope === "branch") {
    const resolvedBase = base ?? await detectDefaultBranch(cwd);
    if (!resolvedBase) {
      return {
        label: "working tree diff",
        diff: await getUncommittedDiff(cwd),
        changedFiles: await getChangedFiles(cwd),
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

  return {
    label: "working tree diff",
    diff: await getUncommittedDiff(cwd),
    changedFiles: await getChangedFiles(cwd),
  };
}

export function formatStatus(entries: GitStatusEntry[]): string {
  if (entries.length === 0) return "(clean)";
  return entries.map((entry) => `${entry.code} ${entry.path}`).join("\n");
}

async function getUntrackedFileSummaries(cwd: string): Promise<string> {
  const status = await getStatusEntries(cwd);
  const untracked = status.filter((entry) => entry.code === "??").map((entry) => entry.path);
  if (untracked.length === 0) return "";

  const lines: string[] = [];
  for (const path of untracked.slice(0, 40)) {
    const result = await runGit(["--no-pager", "diff", "--no-index", "--", "/dev/null", path], cwd);
    if (result.stdout.trim()) {
      lines.push(result.stdout);
    } else {
      lines.push(`Untracked: ${path}`);
    }
  }
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
