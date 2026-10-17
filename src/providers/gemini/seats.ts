import { join } from "node:path";
import type { SeatSource } from "../../types.ts";
import { exists, homeSeats } from "../helpers/seats.ts";

export const geminiSeats: SeatSource = {
  id: "gemini",
  label: "Gemini",
  kind: "cli",
  binary: "gemini",
  livePath: (home) => join(home, ".gemini"),
  // oauth_creds.json and google_accounts.json stay per account.
  sharedItems: ["settings.json", "GEMINI.md", "trustedFolders.json", "skills", "commands", "extensions"],
  async discover(home) {
    return homeSeats(
      home,
      "gemini",
      ".gemini",
      (dir) => exists(dir, "oauth_creds.json") || exists(dir, "google_accounts.json"),
    );
  },
};
