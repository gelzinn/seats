import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { discoverSeatDirs } from "../../home-dirs.ts";
import type { Seat, SeatSource } from "../../types.ts";
import { exists } from "../helpers/seats.ts";
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

const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** "Max" becomes "Max 20x" when the seat's `.claude.json` records the rate-limit tier. */
function planName(dir: string, subscription: string | undefined): string | undefined {
  if (!subscription) return undefined;
  try {
    const config = JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8")) as {
      oauthAccount?: { userRateLimitTier?: string };
    };
    const multiplier = config.oauthAccount?.userRateLimitTier?.match(/_(\d+x)$/)?.[1];
    if (multiplier) return `${capitalize(subscription)} ${multiplier}`;
  } catch {
    // no tier recorded
  }
  return capitalize(subscription);
}

/** The account signed in to a config dir, or undefined when signed out. */
async function claudeAccount(dir: string): Promise<{ email?: string; plan?: string } | undefined> {
  const proc = Bun.spawn(["claude", "auth", "status"], {
    cwd: homedir(),
    env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  try {
    const data = JSON.parse(stdout) as { loggedIn?: boolean; email?: string; subscriptionType?: string };
    if (!data.loggedIn) return undefined;
    return { email: data.email || undefined, plan: planName(dir, data.subscriptionType) };
  } catch {
    return undefined;
  }
}

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
    signedIn: async (dir) => (await claudeAccount(dir)) !== undefined,
    // Its own prompt echoes nothing, so a paste looks like it didn't land.
    codePrompt: "Paste code here if prompted >",
  },
  usage: claudeUsage,
  failover: claudeFailover,
  // Cheapest model, no MCP servers: only checks that the account answers.
  health: (prompt) => ({ args: ["-p", prompt, "--model", "haiku", "--strict-mcp-config"], model: "haiku" }),
  async discover(home) {
    const seats: Seat[] = [];
    for (const item of discoverSeatDirs(home, "claude", ".claude")) {
      const account = await claudeAccount(item.dir);
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
