import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { discoverSeatDirs } from "../../home-dirs.ts";
import type { Seat } from "../../types.ts";

/** `join(dir, ...parts)` when `dir` (the tool's home) exists, else undefined. */
export function ifDir(dir: string, ...parts: string[]): string | undefined {
  return existsSync(dir) ? join(dir, ...parts) : undefined;
}

export function exists(...parts: string[]): boolean {
  return existsSync(join(...parts));
}

export function hasEntries(dir: string): boolean {
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/** Seats from `~/.config/seats/<provider>/*` and `~/<liveName>[-*]` that pass `signedIn`. */
export function homeSeats(
  home: string,
  provider: string,
  liveName: string,
  signedIn: (dir: string) => boolean,
): Seat[] {
  return discoverSeatDirs(home, provider, liveName)
    .filter((item) => signedIn(item.dir))
    .map((item) => ({
      id: `${provider}:${item.slug}`,
      source: provider,
      provider,
      kind: "cli" as const,
      label: item.label,
      dir: item.dir,
      signedIn: true,
    }));
}

/** The one seat of a CLI that has a single, fixed config folder. */
export function singleSeat(provider: string, dir: string): Seat {
  return {
    id: `${provider}:default`,
    source: provider,
    provider,
    kind: "cli",
    label: "Default",
    dir,
    signedIn: true,
  };
}
