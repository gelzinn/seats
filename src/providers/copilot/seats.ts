import { join } from "node:path";
import type { SeatSource } from "../../types.ts";
import { exists, homeSeats } from "../helpers/seats.ts";

export const copilotSeats: SeatSource = {
  id: "copilot",
  label: "Copilot",
  kind: "cli",
  binary: "copilot",
  livePath: (home) => join(home, ".copilot"),
  // config.json, mcp-oauth-config and mcp-secrets stay per account.
  sharedItems: [
    "settings.json",
    "mcp-config.json",
    "copilot-instructions.md",
    "instructions",
    "agents",
    "skills",
    "hooks",
  ],
  async discover(home) {
    return homeSeats(
      home,
      "copilot",
      ".copilot",
      (dir) => exists(dir, "session-store.db") || exists(dir, "session-state") || exists(dir, "config.json"),
    );
  },
};
