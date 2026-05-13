import type { AssistantHost, TaskStatus } from "./types.ts";

export type AssistantAvailabilityMap = Record<string, {
  available?: {
    ok?: boolean;
  };
} | undefined>;

export function areConfiguredAssistantsReady(
  assistants: AssistantAvailabilityMap,
  host: AssistantHost,
  peers: AssistantHost[],
): boolean {
  return Boolean(assistants[host]?.available?.ok && peers.every((reviewer) => Boolean(assistants[reviewer]?.available?.ok)));
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
