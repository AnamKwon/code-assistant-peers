export type AssistantHost = string;
export type TaskStatus = "open" | "queued" | "running" | "reviewed" | "partial_failed" | "review_failed";
export type FindingStatus = "open" | "addressed" | "dismissed" | "unknown";
export type ReviewMode = "normal" | "adversarial" | "gate" | "collaborative";
export type ReviewScope = "auto" | "working-tree" | "branch";
export type PeerWorkflow = "review_only" | "peer_fix";

export interface GitStatusEntry {
  code: string;
  path: string;
}

export interface FileSnapshotEntry {
  fingerprint: string;
  sha256?: string;
  size: number;
  text?: string;
  binary?: boolean;
  sensitive?: boolean;
  omitted?: string;
}

export interface WorkspaceSnapshot {
  captured_at: string;
  files: Record<string, FileSnapshotEntry>;
  truncated?: boolean;
  warning?: string;
}

export interface PeerTask {
  id: string;
  host: AssistantHost;
  peer: AssistantHost;
  peers?: AssistantHost[];
  prompt: string;
  cwd: string;
  git_root: string | null;
  baseline_status: GitStatusEntry[];
  baseline_diff: string;
  baseline_workspace_snapshot?: WorkspaceSnapshot | null;
  created_at: string;
  updated_at: string;
  status: TaskStatus;
  review?: PeerReviewResult;
  review_signature?: string;
}

export interface PeerReviewResult {
  reviewer: AssistantHost;
  command: string[];
  exit_code: number | null;
  stdout: string;
  stderr: string;
  started_at: string;
  completed_at: string;
  warning?: string;
}

export interface PeerReviewRound extends PeerReviewResult {
  id: number;
  task_id: string;
  round: number;
  prompt: string;
}

export interface PeerReviewFinding {
  id: number;
  task_id: string;
  review_round_id: number | null;
  severity: string;
  file: string | null;
  line: number | null;
  message: string;
  status: FindingStatus;
  created_at: string;
  updated_at: string;
}

export interface NewPeerReviewFinding {
  severity: string;
  file?: string | null;
  line?: number | null;
  message: string;
  status?: FindingStatus;
}

export interface ReviewRequestOptions {
  mode?: ReviewMode;
  scope?: ReviewScope;
  base?: string | null;
  change_summary?: string | null;
  files_changed?: string[];
  workflow?: PeerWorkflow;
  focus?: string | null;
  semantic_context?: string | null;
  self_review?: boolean;
  review_model?: string | null;
  review_models?: Record<string, string>;
  // Bypass the same-state dedup: re-run reviewers even when the repository state and review
  // options match the latest completed review.
  force_review?: boolean;
}

export type ReviewModelRoutingTier = "fast" | "balanced" | "deep" | "long_context";

export interface SemanticSymbolHint {
  file: string;
  line: number;
  kind: string;
  name: string;
}

export interface AssistantAdapter {
  id: AssistantHost;
  command: string[];
  prompt_transport: "stdin" | "argv" | "channel";
  description?: string;
  timeout_ms?: number;
  env_allowlist?: string[];
  model_arg?: string;
  models?: AssistantModelInfo[];
}

export interface AssistantModelInfo {
  id: string;
  aliases?: string[];
  quality?: "low" | "medium" | "high" | "highest";
  cost?: "low" | "medium" | "high";
  latency?: "low" | "medium" | "high";
  routing?: ReviewModelRoutingTier[];
  description?: string;
}
