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

export function shouldRunCodexSelfReview(host: AssistantHost, mode?: ReviewMode): boolean {
  return host === "codex" && mode !== "collaborative" && mode !== "gate";
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
