import { homedir } from "node:os";
import { basename } from "node:path";
import { discoverSeatDirs, type SeatDir } from "./home-dirs.ts";
import { seatSources } from "./providers/index.ts";

export type { SeatDir };
export { seatsHome } from "./store.ts";

const source = (provider: string) => seatSources.find((item) => item.id === provider);

/**
 * Seat folders for a CLI provider (`claude`, `codex`, ...), from the store and
 * legacy `~/.<provider>-<slug>` folders. Does not check whether they are signed in.
 */
export function listSeatDirs(provider: string, home = homedir()): SeatDir[] {
  const live = source(provider)?.livePath?.(home);
  return discoverSeatDirs(home, provider, live ? basename(live) : `.${provider}`);
}

/** Folder of the `<provider>:<slug>` seat, or undefined when there is none. */
export function seatDir(provider: string, slug: string, home = homedir()): string | undefined {
  return listSeatDirs(provider, home).find((seat) => seat.slug === slug)?.dir;
}

/** Env that points `provider`'s CLI at `dir`. Empty when the CLI has no such variable. */
export function seatDirEnv(provider: string, dir: string): Record<string, string> {
  const name = source(provider)?.configDirEnv;
  return name ? { [name]: dir } : {};
}

/**
 * Env that launches `provider`'s CLI on the `<provider>:<slug>` seat, such as
 * `CLAUDE_CONFIG_DIR`. Undefined when the seat is missing or the CLI has no such variable.
 */
export function seatEnv(
  provider: string,
  slug: string,
  home = homedir(),
): Record<string, string> | undefined {
  const dir = seatDir(provider, slug, home);
  if (!dir) return undefined;
  const env = seatDirEnv(provider, dir);
  return Object.keys(env).length > 0 ? env : undefined;
}
