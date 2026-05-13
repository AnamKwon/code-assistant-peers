import { describe, expect, test } from "bun:test";

describe("server tool descriptions", () => {
  test("keeps the mandatory post-edit gate tool prominent", async () => {
    const source = await Bun.file(new URL("../server.ts", import.meta.url).pathname).text();

    expect(source).toContain('name: "must_call_after_code_changes"');
    expect(source).toContain("ABSOLUTE REQUIRED POST-EDIT MCP GATE");
    expect(source).toContain("Never substitute built-in /review");
    expect(source).toContain("Call must_call_after_code_changes before your final answer");
    expect(source).toContain('reviewer: { type: "string" as const }');
    expect(source).toContain("reviewer must be one of");
    expect(source).toContain('"collaborative"');
    expect(source).toContain("higher token cost");
    expect(source).toContain("Host comparison was skipped because the peer reviewer produced no usable review output.");
    expect(source).toContain('mode: "collaborative"');
    expect(source).toContain('name: "start_peer_review_async"');
    expect(source).toContain('name: "wait_for_peer_review"');
    expect(source).toContain('name: "get_peer_review_status"');
    expect(source).toContain("queued/running/reviewed/partial_failed/review_failed");
    expect(source).toContain("runMultiPeerReviewTool");
    expect(source).toContain("areConfiguredAssistantsReady");
  });
});
