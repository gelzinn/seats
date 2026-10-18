import { join } from "node:path";
import { discoverSeatDirs } from "../../home-dirs.ts";
import type { Seat, SeatSource } from "../../types.ts";
import { exists } from "../helpers/seats.ts";
import { claudeAccount } from "./account.ts";
import { claudeFailover } from "./failover.ts";
import { mergeClaudeConfigs } from "./merge.ts";
import { claudeUsage } from "./usage.ts";

/** User-level Claude config that should look the same from every seat. */
const SHARED_ITEMS = [
  "settings.json",
  "CLAUDE.md",
  "keybindings.json",
  "statusline-command.sh",
  "agents",
  "commands",
  "skills",
  "hooks",
  "output-styles",
  "themes",
  "plugins/installed_plugins.json",
  "plugins/known_marketplaces.json",
  "plugins/marketplaces",
  "plugins/cache",
];

export const claudeSeats: SeatSource = {
  id: "claude",
  label: "Claude",
  kind: "cli",
  binary: "claude",
  livePath: (home) => join(home, ".claude"),
  extraLivePaths: (home) => [join(home, ".claude.json")],
  configDirEnv: "CLAUDE_CONFIG_DIR",
  sharedItems: SHARED_ITEMS,
  mergeSeats: mergeClaudeConfigs,
  // statusLine commands often point at a script inside the seat folder.
  pathFiles: ["settings.json"],
  // Prints a sign-in link and waits for the code to be pasted; credentials land in the seat folder.
  login: {
    args: ["auth", "login"],
    signedIn: (dir) => claudeAccount(dir) !== undefined,
  },
  usage: claudeUsage,
  failover: claudeFailover,
  // Cheapest model, no MCP servers: only checks that the account answers.
  health: (prompt) => ({ args: ["-p", prompt, "--model", "haiku", "--strict-mcp-config"], model: "haiku" }),
  async discover(home) {
    const seats: Seat[] = [];
    for (const item of discoverSeatDirs(home, "claude", ".claude")) {
      const account = claudeAccount(item.dir);
      if (!account) continue;
      seats.push({
        id: `claude:${item.slug}`,
        source: "claude",
        provider: "claude",
        kind: "cli",
        label: item.label,
        dir: item.dir,
        email: account.email,
        plan: account.plan,
        signedIn: true,
        extraLinks: exists(item.dir, ".claude.json")
          ? [{ live: join(home, ".claude.json"), target: join(item.dir, ".claude.json") }]
          : undefined,
      });
    }
    return seats;
  },
};
