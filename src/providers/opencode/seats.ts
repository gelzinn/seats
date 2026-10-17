import { join } from "node:path";
import type { SeatSource } from "../../types.ts";
import { exists, singleSeat } from "../helpers/seats.ts";

/** OpenCode keeps one login under its data dir, so it has a single seat and nothing to switch. */
export const opencodeSeats: SeatSource = {
  id: "opencode",
  label: "OpenCode",
  kind: "cli",
  binary: "opencode",
  async discover(home) {
    const dir = join(home, ".local", "share", "opencode");
    return exists(dir, "auth.json") ? [singleSeat("opencode", dir)] : [];
  },
};
