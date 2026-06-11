import type { AssistantHost, ReviewMode, TaskStatus } from "./types.ts";

export type AssistantAvailabilityMap = Record<string, {
  available?: {
    ok?: boolean;
  };
} | undefined>;

export type ReviewerAvailability = {
  reviewer: AssistantHost;
  available: {
    ok: boolean;
    detail: string;
  };
};

export type MultiPeerAvailabilitySummary = {
  availablePeers: AssistantHost[];
  skippedPeers: ReviewerAvailability[];
  failure?: "host_unavailable" | "no_peers";
};

export function areConfiguredAssistantsReady(
  assistants: AssistantAvailabilityMap,
  host: AssistantHost,
  peers: AssistantHost[],
): boolean {
  return Boolean(assistants[host]?.available?.ok && peers.every((reviewer) => Boolean(assistants[reviewer]?.available?.ok)));
}

// Which hosts run a self-review (the host reviews its own patch, merged into the aggregate pass).
// Controlled by CODE_ASSISTANT_PEERS_SELF_REVIEW:
//   unset (default) -> "codex"   (backwards compatible)
//   "all" / "*"     -> every host
//   "none" / "off"  -> disabled
//   comma list      -> those hosts, e.g. "claude,codex"
// Self-review never runs in collaborative or gate modes (the host already participates there).
export function shouldRunHostSelfReview(host: AssistantHost, mode?: ReviewMode, env: NodeJS.ProcessEnv = process.env): boolean {
  if (mode === "collaborative" || mode === "gate") return false;
  const raw = env.CODE_ASSISTANT_PEERS_SELF_REVIEW?.trim().toLowerCase();
  if (!raw) return host === "codex";
  if (raw === "none" || raw === "off") return false;
  if (raw === "all" || raw === "*") return true;
  return raw.split(",").map((part) => part.trim()).filter(Boolean).includes(host.toLowerCase());
}

export function summarizeMultiPeerAvailability(
  hostAvailability: { ok: boolean; detail: string },
  peerAvailability: ReviewerAvailability[],
  selfReviewEnabled: boolean,
): MultiPeerAvailabilitySummary {
  const availablePeers = peerAvailability.filter((item) => item.available.ok).map((item) => item.reviewer);
  const skippedPeers = peerAvailability.filter((item) => !item.available.ok);

  if (!hostAvailability.ok) {
    return { availablePeers, skippedPeers, failure: "host_unavailable" };
  }

  if (availablePeers.length === 0 && !selfReviewEnabled) {
    return { availablePeers, skippedPeers, failure: "no_peers" };
  }

  return { availablePeers, skippedPeers };
}

export function resolveMultiPeerTaskStatus(params: {
  successfulPeerReviews: number;
  failedPeerReviews: number;
  skippedPeers: number;
  aggregateExitCode: number | null;
}): TaskStatus {
  if (params.successfulPeerReviews === 0 || params.aggregateExitCode !== 0) return "review_failed";
  if (params.failedPeerReviews > 0 || params.skippedPeers > 0) return "partial_failed";
  return "reviewed";
}
