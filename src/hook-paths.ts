import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { isSymlink, lexists, writeJsonAtomic } from "./fs.ts";
import { parseRecord } from "./share.ts";
import { sharedDir, storeDir } from "./store.ts";
import { sharedSettingsFile } from "./trust.ts";
import type { SeatSource } from "./types.ts";

/** A real path, or the path itself when it doesn't exist. */
const real = (path: string) => (existsSync(path) ? realpathSync(path) : path);

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What may follow a path in a shell command: more of it, a quote, a space or an operator. */
const PATH_END = `(?=[/'"\\s;&|)]|$)`;

/**
 * Rewrites the paths in a hook command that reach a shared item of `source`
 * by way of one seat to one path for that item:
 * - the live path (`~/.claude/hooks/…`) when it leads to the shared item. It's
 *   what herdr writes when it installs its own hook from a plain shell, and
 *   herdr only knows its hook by that exact path, so any other form gets a
 *   second copy at its next install;
 * - else, when the active seat keeps its own copy, the shared folder's path.
 *
 * Rewritten: the shared folder's path, the live path, a seat's path to the
 * item when it's linked to the shared one (or is a real copy sync is about to
 * fold in), and a path into a store seat folder that's gone (renamed or
 * removed). A seat's own copy of an item it keeps out is left alone.
 */
export function sharedPathRewriter(
  home: string,
  source: SeatSource,
  dirs: string[],
  keep: (dir: string, item: string) => boolean,
): (command: string) => string {
  const live = source.livePath?.(home);
  const activeDir = live && dirs.find((dir) => real(dir) === real(live));
  const store = storeDir(home, source.id);
  const targets = new Map<string, string>();
  const patterns: string[] = [];

  for (const item of source.sharedItems ?? []) {
    const shared = join(sharedDir(home, source.id), item);
    if (!existsSync(shared)) continue;
    const reaches = (dir: string) => {
      const path = join(dir, item);
      if (keep(dir, item)) return false;
      return isSymlink(path) ? real(path) === real(shared) : lexists(path);
    };
    const liveItem = live && activeDir && reaches(activeDir) ? join(live, item) : undefined;
    const to = liveItem ?? shared;
    for (const from of [
      shared,
      ...(liveItem ? [liveItem] : []),
      ...dirs.filter(reaches).map((dir) => join(dir, item)),
    ]) {
      targets.set(from, to);
    }
    targets.set(item, to);
    patterns.push(`${escapeRegExp(store)}/[^/'"\\s]+/${escapeRegExp(item)}`);
  }
  if (targets.size === 0) return (command) => command;

  const exact = [...targets.keys()].filter((from) => from.startsWith("/")).sort((a, b) => b.length - a.length);
  const pattern = new RegExp(`(${[...exact.map(escapeRegExp), ...patterns].join("|")})${PATH_END}`, "g");
  return (command) =>
    command.replace(pattern, (from) => {
      const known = targets.get(from);
      if (known) return known;
      // A seat folder in the store: only rewritten once it's gone.
      const item = [...targets.keys()].find((name) => !name.startsWith("/") && from.endsWith(`/${name}`))!;
      const seat = from.slice(0, -(item.length + 1));
      return existsSync(seat) ? from : targets.get(item)!;
    });
}

/**
 * Points the hook and status line commands of the shared settings file of
 * `source` at one path per shared item (see `sharedPathRewriter`), then
 * drops hooks that became the same. Returns the file, or undefined when
 * there's nothing to change.
 */
export function tidySharedHooks(
  home: string,
  source: SeatSource,
  dirs: string[],
  keep: (dir: string, item: string) => boolean,
  { dryRun = false } = {},
): string | undefined {
  const tidy = source.sessionHook?.tidy;
  const file = sharedSettingsFile(home, source, dirs, keep);
  if (!tidy || !file || !existsSync(file)) return undefined;
  let settings: Record<string, unknown> | undefined;
  try {
    settings = parseRecord(readFileSync(file));
  } catch {
    return undefined;
  }
  const next = settings && tidy(settings, sharedPathRewriter(home, source, dirs, keep));
  if (!next) return undefined;
  if (!dryRun) writeJsonAtomic(file, next);
  return realpathSync(file);
}
