import type { AssistantHost, AssistantModelInfo, ReviewModelRoutingTier, ReviewRequestOptions } from "./types.ts";
import { getAssistantAdapter } from "./assistants.ts";
import { normalizeReviewFocus } from "./review-utils.ts";

export interface ReviewModelRoutingContext {
  mode?: ReviewRequestOptions["mode"];
  workflow?: ReviewRequestOptions["workflow"];
  focus?: string | null;
  diffLength?: number;
  changedFileCount?: number;
  diffWasTruncated?: boolean;
  selfReview?: boolean;
}

export function resolveReviewerModel(
  reviewer: AssistantHost,
  options: Pick<ReviewRequestOptions, "review_model" | "review_models">,
  context: ReviewModelRoutingContext = {},
): string | null {
  const explicit = options.review_models?.[reviewer]?.trim();
  if (explicit) {
    return explicit === "auto" ? selectAutoReviewerModel(reviewer, context) : explicit;
  }
  const global = options.review_model?.trim();
  if (global && global !== "auto") return global;
  if (global !== "auto") return null;
  return selectAutoReviewerModel(reviewer, context);
}

export function buildReviewModelRoutingContext(
  options: ReviewRequestOptions,
  snapshot: { reviewContext: { diff: string; changedFiles: string[] }; diffWasTruncated: boolean },
): ReviewModelRoutingContext {
  return {
    mode: options.mode ?? "normal",
    workflow: options.workflow ?? "review_only",
    focus: normalizeReviewFocus(options.focus ?? process.env.CODE_ASSISTANT_PEERS_REVIEW_FOCUS),
    diffLength: snapshot.reviewContext.diff.length,
    changedFileCount: snapshot.reviewContext.changedFiles.length,
    diffWasTruncated: snapshot.diffWasTruncated,
    selfReview: options.self_review ?? false,
  };
}

export function selectAutoReviewerModel(
  reviewer: AssistantHost,
  context: ReviewModelRoutingContext = {},
): string | null {
  const adapter = getAssistantAdapter(reviewer);
  if (!adapter.model_arg || !adapter.models?.length) return null;
  return selectModelForTier(adapter.models, chooseReviewModelTier(context))?.id ?? null;
}

export function chooseReviewModelTier(context: ReviewModelRoutingContext = {}): ReviewModelRoutingTier {
  const focus = context.focus?.toLowerCase() ?? "";
  const changedFileCount = context.changedFileCount ?? 0;
  const diffLength = context.diffLength ?? 0;
  const highRisk = /\b(security|auth|permission|data loss|migration|rollback|payment|billing|secret|privacy|race|concurrency|database|schema|production|release|performance)\b/.test(focus);
  // diffWasTruncated alone is not a reliable long_context signal: a low Serena diff
  // budget (CODE_ASSISTANT_PEERS_DIFF_BUDGET=4000) marks any routine diff as truncated
  // even when the actual diff is well within a balanced model's context window.
  // Only escalate to long_context when the raw diff is genuinely large or very broad.
  if (diffLength > 30000 || changedFileCount > 20 || (context.diffWasTruncated && diffLength > 12000)) return "long_context";
  if (highRisk || context.mode === "adversarial" || context.mode === "collaborative" || context.workflow === "peer_fix") return "deep";
  if (context.mode === "gate" || context.selfReview) return "balanced";
  if (diffLength > 0 && diffLength <= 4000 && changedFileCount <= 3 && isLowRiskFocus(focus)) return "fast";
  return "balanced";
}

function selectModelForTier(models: AssistantModelInfo[], tier: ReviewModelRoutingTier): AssistantModelInfo | null {
  const direct = models.find((model) => model.routing?.includes(tier));
  if (direct) return direct;
  if (tier === "long_context") {
    return models.find((model) => model.routing?.includes("deep")) ?? models.find((model) => model.quality === "highest") ?? null;
  }
  if (tier === "deep") {
    return models.find((model) => model.quality === "highest") ?? models.find((model) => model.quality === "high") ?? null;
  }
  if (tier === "fast") {
    return models.find((model) => model.latency === "low" || model.cost === "low") ?? null;
  }
  return models.find((model) => model.quality === "high") ?? models[0] ?? null;
}

function isLowRiskFocus(focus: string): boolean {
  if (!focus) return true;
  return /\b(docs?|documentation|readme|tests?|format|lint|typo|copy|comment)\b/.test(focus);
}
