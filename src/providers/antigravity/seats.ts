import { join } from "node:path";
import { isDirectory } from "../../fs.ts";
import type { SeatSource } from "../../types.ts";
import { exists, singleSeat } from "../helpers/seats.ts";

export const antigravitySeats: SeatSource = {
  id: "antigravity",
  label: "Antigravity",
  kind: "cli",
  binary: "agy",
  livePath: (home) => join(home, ".antigravity"),
  async discover(home) {
    const dir = join(home, ".antigravity");
    const geminiDir = join(home, ".gemini", "antigravity");
    if (!isDirectory(dir) && !isDirectory(geminiDir)) return [];
    if (!exists(home, ".gemini", "oauth_creds.json") && !isDirectory(geminiDir)) return [];
    return [singleSeat("antigravity", isDirectory(dir) ? dir : geminiDir)];
  },
};
