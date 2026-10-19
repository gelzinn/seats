import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SeatSource } from "../../types.ts";
import { exists, homeSeats } from "../helpers/seats.ts";
import { portableConfig } from "./export.ts";
import { codexHealth } from "./health.ts";
import { codexUsage, readCodexUsage } from "./usage.ts";

/** Email and plan from the ChatGPT `id_token` that `codex login` saves, decoded locally. */
function codexAccount(dir: string): { email?: string; plan?: string } {
  try {
    const auth = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8")) as { tokens?: { id_token?: string } };
    const payload = auth.tokens?.id_token?.split(".")[1];
    if (!payload) return {};
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      email?: unknown;
      "https://api.openai.com/auth"?: { chatgpt_plan_type?: unknown };
    };
    const plan = claims["https://api.openai.com/auth"]?.chatgpt_plan_type;
    return {
      email: typeof claims.email === "string" ? claims.email : undefined,
      plan: typeof plan === "string" ? plan.charAt(0).toUpperCase() + plan.slice(1) : undefined,
    };
  } catch {
    return {};
  }
}

export const codexSeats: SeatSource = {
  id: "codex",
  label: "Codex",
  kind: "cli",
  binary: "codex",
  livePath: (home) => join(home, ".codex"),
  configDirEnv: "CODEX_HOME",
  // Signs in with the browser; `seats add codex <name> -- --device-auth` uses a device code instead.
  login: {
    args: ["login"],
    signedIn: (dir) => exists(dir, "auth.json"),
  },
  health: codexHealth,
  usage: codexUsage,
  readUsage: readCodexUsage,
  // config.toml carries MCP servers and trusted projects; auth.json and sessions stay per account.
  sharedItems: ["config.toml", "AGENTS.md", "agents", "skills", "rules", "prompts", "hooks.json"],
  exportFiles: { "config.toml": portableConfig },
  async discover(home) {
    return homeSeats(home, "codex", ".codex", (dir) => exists(dir, "auth.json")).map((seat) => ({
      ...seat,
      ...codexAccount(seat.dir!),
    }));
  },
};
