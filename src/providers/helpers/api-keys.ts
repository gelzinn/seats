import { readFileSync } from "node:fs";

/** Env var each API provider's SDKs read. */
export const API_ENV_VARS: Record<string, string> = {
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  groq: "GROQ_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  gemini: "GEMINI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  zai: "ZAI_API_KEY",
  "zai-coding-plan": "ZAI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  together: "TOGETHER_API_KEY",
  huggingface: "HF_TOKEN",
  grok: "XAI_API_KEY",
  xai: "XAI_API_KEY",
  opencode: "OPENCODE_API_KEY",
  "opencode-go": "OPENCODE_API_KEY",
  commandcode: "COMMAND_CODE_API_KEY",
  gitlawb: "GITLAWB_API_KEY",
};

const API_LABELS: Record<string, string> = {
  openrouter: "OpenRouter",
  openai: "OpenAI",
  anthropic: "Anthropic",
  groq: "Groq",
  google: "Google",
  gemini: "Gemini",
  deepseek: "DeepSeek",
  zai: "Z.AI",
  "zai-coding-plan": "Z.AI Coding Plan",
  mistral: "Mistral",
  together: "Together",
  huggingface: "Hugging Face",
  grok: "Grok",
  xai: "xAI",
  opencode: "OpenCode",
  "opencode-go": "OpenCode Go",
  commandcode: "Command Code",
  gitlawb: "GitLawb",
};

export function envVarForApi(id: string): string {
  return API_ENV_VARS[id] ?? `SEATS_${id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}

export function apiLabel(id: string): string {
  return API_LABELS[id] ?? id;
}

export function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** The key in an auth entry, whichever field the tool stores it under. */
export function keyFromAuthEntry(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const field of ["key", "apiKey", "token", "access_token"]) {
    const candidate = record[field];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return undefined;
}
