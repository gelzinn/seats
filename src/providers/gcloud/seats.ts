import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { SeatSource } from "../../types.ts";

/** Named gcloud configurations from `~/.config/gcloud/configurations/config_<name>`. */
export const gcloudSeats: SeatSource = {
  id: "gcloud",
  label: "Google Cloud",
  kind: "cloud",
  async discover(home) {
    const dir = join(home, ".config", "gcloud", "configurations");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.startsWith("config_"))
      .map((name) => {
        const slug = name.replace(/^config_/, "");
        return {
          id: `gcloud:${slug}`,
          source: "gcloud",
          provider: "gcloud",
          kind: "cloud" as const,
          label: slug,
          dir: join(dir, name),
          signedIn: true,
          env: { CLOUDSDK_ACTIVE_CONFIG_NAME: slug },
        };
      });
  },
};
