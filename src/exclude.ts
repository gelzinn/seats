import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isInside } from "./fs.ts";
import { discoverSeatDirs } from "./home-dirs.ts";
import type { McpServers } from "./mcp/types.ts";
import { seatSources } from "./providers/index.ts";
import { readConfig } from "./store.ts";
import type { SeatSource } from "./types.ts";

export type SeatFolder = { id: string; source: SeatSource; dir: string };

/** Every folder of a CLI seat, signed in or not, with its seat id. */
export function seatFolders(home: string, source: SeatSource): SeatFolder[] {
  if (!source.livePath) return [];
  return discoverSeatDirs(home, source.id, basename(source.livePath(home))).map(({ dir, slug }) => ({
    id: `${source.id}:${slug}`,
    source,
    dir,
  }));
}

const allFolders = (home: string) => seatSources.flatMap((source) => seatFolders(home, source));

/** The seat folder for `id`, or an error that lists the seats there are. */
export function findSeatFolder(home: string, id: string): SeatFolder {
  const folders = allFolders(home).filter((folder) => folder.source.sharedItems);
  const found = folders.find((folder) => folder.id === id);
  if (found) return found;
  const known = folders.map((folder) => folder.id).join(", ");
  throw new Error(`No seat named ${id}.${known ? ` Seats: ${known}.` : ""}`);
}

/** Real path, or for a missing file its folder's real path plus its name, so links into a seat still match. */
function resolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    try {
      return join(realpathSync(dirname(path)), basename(path));
    } catch {
      return path;
    }
  }
}

/** The seat whose folder `path` really lives in, e.g. `~/.claude.json` → the active Claude seat. */
export function seatIdOf(home: string, path: string): string | undefined {
  const real = resolved(path);
  return allFolders(home).find((folder) => isInside(real, resolved(folder.dir)))?.id;
}

/** `config.json`'s `exclude`: the shared items each seat keeps its own copy of. */
export function readExclusions(home: string): Record<string, string[]> {
  return readConfig(home).exclude ?? {};
}

/**
 * True when `path` really is, or sits inside, an item a seat keeps out of
 * sharing. Live paths like `~/.claude/CLAUDE.md` lead into the active seat,
 * so cross-tool sync uses this to leave that seat's own copy alone.
 */
export function isExcluded(home: string, path: string): boolean {
  const exclusions = readExclusions(home);
  const excluded = allFolders(home).flatMap(({ id, dir }) => (exclusions[id] ?? []).map((item) => join(dir, item)));
  if (excluded.length === 0) return false;
  const real = resolved(path);
  return excluded.some((item) => isInside(real, resolved(item)));
}

/** Names of the servers in `library` that `seatId` keeps out (`"skip": ["claude:acme"]`). */
export function mcpKeptOut(library: McpServers, seatId: string): string[] {
  return Object.entries(library)
    .filter(([, server]) => server.skip?.includes(seatId))
    .map(([name]) => name);
}
