import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SeatSource } from "../../types.ts";

/** Subscriptions from `~/.azure/azureProfile.json`. */
export const azureSeats: SeatSource = {
  id: "azure",
  label: "Azure",
  kind: "cloud",
  async discover(home) {
    const path = join(home, ".azure", "azureProfile.json");
    if (!existsSync(path)) return [];
    try {
      const data = JSON.parse(readFileSync(path, "utf8")) as {
        subscriptions?: Array<{ name?: string; id?: string }>;
      };
      return (data.subscriptions ?? [])
        .filter((sub) => sub.id)
        .map((sub) => ({
          id: `azure:${sub.id}`,
          source: "azure",
          provider: "azure",
          kind: "cloud" as const,
          label: sub.name || sub.id || "subscription",
          dir: path,
          signedIn: true,
          env: { AZURE_SUBSCRIPTION_ID: sub.id as string },
        }));
    } catch {
      return [];
    }
  },
};
