import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SeatSource } from "../../types.ts";
import { envVarForApi, keyFromAuthEntry, readJsonFile } from "../helpers/api-keys.ts";

/** The API key from `~/.commandcode/auth.json`, usable outside the CLI. */
export const commandCodeApiSeats: SeatSource = {
  id: "commandcode-api",
  label: "Command Code API",
  kind: "api",
  async discover(home) {
    const path = join(home, ".commandcode", "auth.json");
    if (!existsSync(path)) return [];
    const key = keyFromAuthEntry(readJsonFile(path));
    if (!key) return [];
    return [
      {
        id: "api:commandcode-file",
        source: "commandcode-api",
        provider: "commandcode",
        kind: "api",
        label: "Command Code",
        dir: path,
        signedIn: true,
        env: { [envVarForApi("commandcode")]: key },
      },
    ];
  },
};
