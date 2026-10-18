import { readFileSync } from "node:fs";
import { join } from "node:path";

type CachedModel = {
  slug?: string;
  description?: string;
  visibility?: string;
  priority?: number;
  supported_reasoning_levels?: Array<{ effort?: string } | string>;
};

/** Words Codex uses to describe its small models ("Fast and affordable model…"). */
const CHEAP = /\b(affordable|cheap|cheapest|mini|nano|lightweight|efficient)\b/i;
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

/**
 * The cheapest model this account can use, from the `models_cache.json` Codex
 * keeps in the seat folder: the newest listed model described as small or
 * affordable, with its lowest reasoning effort. Undefined when there's no cache.
 */
export function cheapestModel(dir: string): { slug: string; effort?: string } | undefined {
  let models: CachedModel[];
  try {
    models =
      (JSON.parse(readFileSync(join(dir, "models_cache.json"), "utf8")) as { models?: CachedModel[] }).models ?? [];
  } catch {
    return undefined;
  }
  const listed = models.filter((model) => model.slug && model.visibility !== "hide");
  const pick = listed
    .filter((model) => CHEAP.test(model.description ?? "") || CHEAP.test(model.slug!))
    .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))[0];
  if (!pick) return undefined;

  const levels = (pick.supported_reasoning_levels ?? []).map((level) =>
    typeof level === "string" ? level : level.effort,
  );
  const effort = EFFORTS.find((name) => levels.includes(name));
  return { slug: pick.slug!, effort };
}

/** `codex exec` on the cheapest model, read-only, without saving a session. */
export function codexHealth(prompt: string, dir: string): { args: string[]; model?: string } {
  const model = cheapestModel(dir);
  const args = [
    "exec",
    "--skip-git-repo-check",
    "--ephemeral",
    "--sandbox",
    "read-only",
    ...(model ? ["--model", model.slug] : []),
    "-c",
    `model_reasoning_effort="${model?.effort ?? "low"}"`,
    prompt,
  ];
  return { args, model: model?.slug };
}
