import { join } from "node:path";
import type { SeatSource } from "../../types.ts";
import { exists, hasEntries, homeSeats } from "../helpers/seats.ts";

export const kiroSeats: SeatSource = {
  id: "kiro",
  label: "Kiro",
  kind: "cli",
  binary: "kiro",
  livePath: (home) => join(home, ".kiro"),
  sharedItems: ["settings/mcp.json", "settings/cli.json", "steering", "agents", "skills"],
  async discover(home) {
    return homeSeats(
      home,
      "kiro",
      ".kiro",
      (dir) => exists(dir, "settings", "cli.json") || hasEntries(join(dir, "sessions")),
    );
  },
};
