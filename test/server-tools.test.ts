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
    expect(source).toContain("Known reviewer model candidates");
    expect(source).toContain("shared/reviewer-models.json");
    expect(source).toContain("formatKnownReviewerModels");
    expect(source).toContain("adapter.models?.map");
    expect(source).toContain("actively choose reviewer models based on risk, size, latency, and cost");
    expect(source).toContain("Pass review_model=\\\"auto\\\" or review_models[reviewer]=\\\"auto\\\"");
    expect(source).toContain("Pass explicit review_models");
    expect(source).toContain("Prefer review_models over review_model when reviewers use different providers");
    expect(source).toContain("global_selection_warning");
    expect(source).not.toContain('all_reviewers: { review_model: "sonnet" }');

    const assistantsSource = await Bun.file(new URL("../shared/assistants.ts", import.meta.url).pathname).text();
    expect(assistantsSource).toContain("reviewer-models.json");
    expect(assistantsSource).not.toContain('models: [');

    const modelListSource = await Bun.file(new URL("../shared/reviewer-models.json", import.meta.url).pathname).text();
    expect(modelListSource).toContain("gpt-5.5");
    expect(modelListSource).toContain("opus");
    expect(modelListSource).toContain("flash-lite");
    const models = JSON.parse(modelListSource);
    expect(models.codex[0].routing).toContain("deep");
    expect(models.claude[1].routing).toContain("balanced");
    expect(models.gemini[3].routing).toContain("fast");
    expect(assistantsSource).toContain("loadBuiltinReviewerModels");
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

  test("keeps runtime support files in the npm package", async () => {
    const packageJson = JSON.parse(await Bun.file(new URL("../package.json", import.meta.url).pathname).text());

    expect(packageJson.files).toContain("shared");
    expect(packageJson.files).toContain("broker");
    expect(await Bun.file(new URL("../shared/reviewer-models.json", import.meta.url).pathname).exists()).toBe(true);
    expect(await Bun.file(new URL("../broker/server.ts", import.meta.url).pathname).exists()).toBe(true);
    expect(await Bun.file(new URL("../broker/reviewer.ts", import.meta.url).pathname).exists()).toBe(true);
  });
});
