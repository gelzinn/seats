import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cheapestModel, codexHealth } from "../../../src/providers/codex/health.ts";
import { tempHome } from "../../helpers/temp-home.ts";

let env: ReturnType<typeof tempHome>;
afterEach(() => env?.cleanup());

const levels = (...names: string[]) => names.map((effort) => ({ effort }));

/** Shaped like Codex's models_cache.json. */
const cache = {
  models: [
    {
      slug: "big-2",
      description: "Most capable model.",
      visibility: "list",
      priority: 1,
      supported_reasoning_levels: levels("low", "high"),
    },
    {
      slug: "small-2",
      description: "Fast and affordable model for easier tasks.",
      visibility: "list",
      priority: 4,
      supported_reasoning_levels: levels("low", "medium"),
    },
    {
      slug: "small-1",
      description: "Older fast and efficient model.",
      visibility: "list",
      priority: 9,
      supported_reasoning_levels: levels("minimal", "low"),
    },
    { slug: "internal-mini", description: "Internal.", visibility: "hide", priority: 0 },
  ],
};

describe("cheapestModel", () => {
  test("picks the newest small model the account lists, at its lowest effort", () => {
    env = tempHome();
    const dir = join(env.home, "seat");
    env.write("seat/models_cache.json", cache);
    expect(cheapestModel(dir)).toEqual({ slug: "small-2", effort: "low" });
  });

  test("is undefined without a cache, so Codex keeps its own default", () => {
    env = tempHome();
    expect(cheapestModel(join(env.home, "seat"))).toBeUndefined();
    const health = codexHealth("hi", join(env.home, "seat"));
    expect(health.args).not.toContain("--model");
    expect(health.model).toBeUndefined();
  });

  test("passes the model and effort to codex exec", () => {
    env = tempHome();
    env.write("seat/models_cache.json", cache);
    const { args, model } = codexHealth("hi", join(env.home, "seat"));
    expect(model).toBe("small-2");
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 4)).toEqual([
      "--model",
      "small-2",
      "-c",
      'model_reasoning_effort="low"',
    ]);
    expect(args.at(-1)).toBe("hi");
  });
});
