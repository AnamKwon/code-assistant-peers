const REVIEW_FOCUS_BUDGET = 1000;

export function normalizeReviewFocus(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed.length <= REVIEW_FOCUS_BUDGET) return trimmed;
  return `${trimmed.slice(0, REVIEW_FOCUS_BUDGET)}\n[Review focus truncated at ${REVIEW_FOCUS_BUDGET} characters.]`;
}
