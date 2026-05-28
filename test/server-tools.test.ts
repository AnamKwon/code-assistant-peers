import { describe, expect, test } from "bun:test";

describe("server tool descriptions", () => {
  test("keeps the mandatory post-edit gate tool prominent", async () => {
    const source = await Bun.file(new URL("../server.ts", import.meta.url).pathname).text();

    expect(source).toContain('name: "must_call_after_code_changes"');
    expect(source).toContain("ABSOLUTE REQUIRED ASYNC POST-EDIT MCP GATE");
    expect(source).toContain("Never substitute built-in /review");
    expect(source).toContain("Call must_call_after_code_changes before your final answer");
    expect(source).toContain("All post-edit review gates are async-first");
    expect(source).toContain("No duplicate reviewer process was started.");
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
    expect(source).toContain("Host model selection policy:");
    expect(source).toContain("selector: \"host coding agent\"");
    expect(source).toContain("review_models[reviewer]");
    expect(source).toContain("Use review_model=\\\"auto\\\" only when the host wants the MCP server to choose");
    expect(source).toContain("review_models for per-reviewer choices");
  });

  test("keeps installed project rules aligned with async-first review gates", async () => {
    const source = await Bun.file(new URL("../cli.ts", import.meta.url).pathname).text();

    expect(source).toContain("Call \\`wait_for_peer_review\\` or \\`get_peer_review_status\\`");
    expect(source).toContain("reviewed\\`, \\`partial_failed\\`, or \\`review_failed");
    expect(source).toContain('binaryCheck("gemini")');
    expect(source).toContain('name: "Gemini CLI"');
    expect(source).toContain("buildCustomAssistantEnv");
    expect(source).toContain("CODE_ASSISTANT_PEERS_ASSISTANTS=");
    expect(source).toContain("getGeminiSetupAutoReadiness");
  });

  test("keeps web setup diagnostics aligned with Codex env subsections", async () => {
    const source = await Bun.file(new URL("../scripts/web-setup.sh", import.meta.url).pathname).text();

    expect(source).toContain("mcp_servers\\.code-assistant-peers(\\.env)?");
    expect(source).toContain("PEER_ASSISTANTS");
    expect(source).toContain("CODE_ASSISTANT_PEERS_[A-Z0-9_]+");
  });
});
