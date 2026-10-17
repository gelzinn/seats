import { describe, expect, test } from "bun:test";
import { envVarForApi } from "../../../src/providers/helpers/api-keys.ts";

describe("envVarForApi", () => {
  test("maps known providers", () => {
    expect(envVarForApi("openrouter")).toBe("OPENROUTER_API_KEY");
    expect(envVarForApi("zai-coding-plan")).toBe("ZAI_API_KEY");
    expect(envVarForApi("google")).toBe("GOOGLE_GENERATIVE_AI_API_KEY");
  });

  test("falls back for unknown ids", () => {
    expect(envVarForApi("acme-llm")).toBe("SEATS_ACME_LLM_API_KEY");
  });
});
