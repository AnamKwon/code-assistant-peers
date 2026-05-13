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
  created_at: string;
  updated_at: string;
  status: TaskStatus;
  review?: PeerReviewResult;
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
}

export interface SemanticSymbolHint {
  file: string;
  line: number;
  kind: string;
  name: string;
}

export interface AssistantAdapter {
  id: AssistantHost;
  command: string[];
  prompt_transport: "stdin" | "argv";
  description?: string;
}
