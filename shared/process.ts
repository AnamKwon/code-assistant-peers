const DEFAULT_FORCE_KILL_DELAY_MS = 5000;

export interface SpawnWithTimeoutOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** When provided, the value is written to the child's stdin and stdin is closed. */
  stdin?: string | null;
  timeoutMs: number;
  /** Delay between SIGTERM and the SIGKILL escalation after a timeout. */
  forceKillDelayMs?: number;
}

export interface SpawnWithTimeoutResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Spawn a subprocess, capture stdout/stderr, and enforce a timeout that escalates
 * SIGTERM -> SIGKILL. Shared by the reviewer, model-probe, and CLI-help call paths so
 * the timeout/stream-collection mechanics live in one place. Throws if the process
 * fails to start; callers map that to their own failure shape.
 */
export async function spawnWithTimeout(
  command: string[],
  options: SpawnWithTimeoutOptions,
): Promise<SpawnWithTimeoutResult> {
  const usesStdin = options.stdin !== undefined && options.stdin !== null;
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    stdin: usesStdin ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: options.env,
  });

  if (usesStdin) {
    proc.stdin?.write(options.stdin as string);
    proc.stdin?.end();
  }

  let timedOut = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGTERM");
    forceKillTimer = setTimeout(() => proc.kill("SIGKILL"), options.forceKillDelayMs ?? DEFAULT_FORCE_KILL_DELAY_MS);
  }, options.timeoutMs);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timeoutTimer);
    if (forceKillTimer) clearTimeout(forceKillTimer);
  }
}
