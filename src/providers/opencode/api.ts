import { join } from "node:path";
import type { Seat, SeatSource } from "../../types.ts";
import { apiLabel, envVarForApi, keyFromAuthEntry, readJsonFile } from "../helpers/api-keys.ts";

/** Every API key saved in OpenCode's `auth.json`, one seat per provider. */
export const opencodeApiSeats: SeatSource = {
  id: "opencode-api",
  label: "OpenCode APIs",
  kind: "api",
  async discover(home) {
    const path = join(home, ".local", "share", "opencode", "auth.json");
    const raw = readJsonFile(path);
    if (!raw || typeof raw !== "object") return [];
    const seats: Seat[] = [];
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      const key = keyFromAuthEntry(value);
      if (!key) continue;
      seats.push({
        id: `api:${id}`,
        source: "opencode-api",
        provider: id,
        kind: "api",
        label: apiLabel(id),
        dir: path,
        signedIn: true,
        env: { [envVarForApi(id)]: key },
      });
    }
    return seats;
  },
};
