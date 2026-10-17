import { join } from "node:path";
import type { SeatSource } from "../../types.ts";
import { exists, homeSeats } from "../helpers/seats.ts";

export const commandCodeSeats: SeatSource = {
  id: "commandcode",
  label: "Command Code",
  kind: "cli",
  binary: "cmd",
  livePath: (home) => join(home, ".commandcode"),
  // auth.json stays per account.
  sharedItems: ["settings.json", "skills"],
  async discover(home) {
    return homeSeats(home, "commandcode", ".commandcode", (dir) => exists(dir, "auth.json"));
  },
};
