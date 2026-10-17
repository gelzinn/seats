import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Seat, SeatSource } from "../../types.ts";

/** Profile names from an AWS ini file (`[name]` or `[profile name]`). */
function iniProfiles(path: string): string[] {
  if (!existsSync(path)) return [];
  const names = new Set<string>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const name = line.match(/^\[(?:profile\s+)?(.+?)\]\s*$/)?.[1]?.trim();
    if (name) names.add(name);
  }
  return [...names];
}

function profileSeat(name: string, dir: string, label = name): Seat {
  return {
    id: `aws:${name}`,
    source: "aws",
    provider: "aws",
    kind: "cloud",
    label,
    dir,
    signedIn: true,
    env: { AWS_PROFILE: name },
  };
}

/** Profiles from `~/.aws/credentials` and `~/.aws/config`, plus live SSO sessions. */
export const awsSeats: SeatSource = {
  id: "aws",
  label: "AWS",
  kind: "cloud",
  async discover(home) {
    const awsDir = join(home, ".aws");
    const profiles = new Set([
      ...iniProfiles(join(awsDir, "credentials")),
      ...iniProfiles(join(awsDir, "config")),
    ]);
    const seats = [...profiles].map((name) => profileSeat(name, awsDir));

    const ssoCache = join(awsDir, "sso", "cache");
    if (!existsSync(ssoCache)) return seats;
    for (const file of readdirSync(ssoCache)) {
      if (!file.endsWith(".json")) continue;
      const path = join(ssoCache, file);
      try {
        const data = JSON.parse(readFileSync(path, "utf8")) as { accessToken?: string; profileArn?: string };
        if (!data.accessToken) continue;
        const slug = file.replace(/\.json$/, "");
        if (seats.some((seat) => seat.id === `aws:${slug}`)) continue;
        seats.push(profileSeat(slug, path, data.profileArn ? "SSO session" : slug));
      } catch {
        // ignore malformed cache
      }
    }
    return seats;
  },
};
