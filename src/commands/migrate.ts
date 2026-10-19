import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import pc from "picocolors";
import { isInside, isSymlink, lexists, linkTarget, moveTree, replacePathPrefix, replaceSymlink } from "../fs.ts";
import { discoverSeatDirs, legacySeatDirs } from "../home-dirs.ts";
import { seatSources } from "../providers/index.ts";
import { sharedDir, storeDir } from "../store.ts";
import type { SeatSource } from "../types.ts";
import { tilde } from "./ui.ts";

export type Move = { provider: string; from: string; to: string; blocked?: string };

const liveSources = () => seatSources.filter((source) => source.kind === "cli" && source.livePath);

const seatDirsOf = (home: string, source: SeatSource) =>
  discoverSeatDirs(home, source.id, basename(source.livePath!(home)));

/** Legacy `~/.<tool>-<slug>` folders and where they move inside the seats store. */
export function planMigration(home: string): Move[] {
  return liveSources().flatMap((source) => {
    const liveName = basename(source.livePath!(home));
    return legacySeatDirs(home, liveName).map(({ dir, slug }) => {
      const to = join(storeDir(home, source.id), slug);
      return { provider: source.id, from: dir, to, blocked: lexists(to) ? `${to} exists` : undefined };
    });
  });
}

function symlinksIn(dir: string): string[] {
  try {
    return readdirSync(dir)
      .map((name) => join(dir, name))
      .filter(isSymlink);
  } catch {
    return [];
  }
}

/** Symlinks that may point into a seat folder: live paths and links inside seat folders. */
function candidateLinks(home: string): string[] {
  const links = liveSources().flatMap((source) => [source.livePath!(home), ...(source.extraLivePaths?.(home) ?? [])]);
  for (const source of liveSources()) {
    for (const { dir } of seatDirsOf(home, source)) {
      links.push(...symlinksIn(dir), ...symlinksIn(join(dir, "plugins")));
    }
  }
  return links.filter(isSymlink);
}

/** Each source's `pathFiles`, in its shared folder and in every seat that has its own copy. */
function filesWithPaths(home: string): Set<string> {
  const files = new Set<string>();
  for (const source of liveSources()) {
    for (const name of source.pathFiles ?? []) {
      files.add(join(sharedDir(home, source.id), name));
      for (const { dir } of seatDirsOf(home, source)) {
        if (!isSymlink(join(dir, name))) files.add(join(dir, name));
      }
    }
  }
  return files;
}

/** Points links and `pathFiles` paths that lead into `from` at the same place inside `to`. */
export function repoint(home: string, from: string, to: string): void {
  for (const link of candidateLinks(home)) {
    const target = linkTarget(link);
    if (!target || !isInside(target, from)) continue;
    replaceSymlink(link, to + target.slice(from.length));
  }

  for (const file of filesWithPaths(home)) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    const next = replacePathPrefix(text, from, to);
    if (next !== text) writeFileSync(file, next);
  }
}

export function applyMigration(home: string, moves: Move[]): Move[] {
  const done: Move[] = [];
  for (const move of moves) {
    if (move.blocked) continue;
    mkdirSync(dirname(move.to), { recursive: true, mode: 0o700 });
    try {
      moveTree(move.from, move.to);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EXDEV") {
        throw new Error(
          `${move.from} and ${move.to} are on different filesystems. Move it by hand, then run \`seats migrate\` again.`,
        );
      }
      throw error;
    }
    repoint(home, move.from, move.to);
    done.push(move);
  }
  return done;
}

/** `seats migrate [--dry-run]`: move `~/.<tool>-*` folders into the store. */
export async function migrateCommand(args: string[]): Promise<void> {
  const moves = planMigration(homedir());
  if (moves.length === 0) {
    console.log("Nothing to migrate.");
    return;
  }
  for (const move of moves) {
    const note = move.blocked ? pc.yellow(`  skipped: ${move.blocked}`) : "";
    console.log(`${tilde(move.from)} -> ${tilde(move.to)}${note}`);
  }
  if (args.includes("--dry-run")) return;

  const done = applyMigration(homedir(), moves);
  console.log(`Moved ${done.length} seat folders.`);
  if (done.length > 0) {
    console.log(pc.dim("Update any CLAUDE_CONFIG_DIR or similar paths in your shell config to the new folders."));
  }
}
