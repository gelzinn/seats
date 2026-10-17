import { readdirSync } from "node:fs";
import { join } from "node:path";
import { isDirectory, isSymlink } from "./fs.ts";
import { storeDir } from "./store.ts";

export type SeatDir = { dir: string; slug: string; label: string };

const SPECIAL_LABELS: Record<string, string> = {
  primary: "Primary",
  secondary: "Secondary",
  default: "Default",
};

/** "side-project" → "Side Project"; `prefix` (e.g. ".claude") is stripped first. */
export function labelFromDirName(dirName: string, prefix: string): string {
  let slug = dirName;
  if (slug.startsWith(prefix)) slug = slug.slice(prefix.length);
  slug = slug.replace(/^\./, "").replace(/^-+/, "");
  if (!slug) return SPECIAL_LABELS.default;
  if (SPECIAL_LABELS[slug]) return SPECIAL_LABELS[slug];
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** Backups, stubs and locks that sit next to seat folders but aren't seats. */
export function isIgnoredAccountDir(name: string): boolean {
  return (
    name.endsWith(".lock") ||
    name.endsWith(".bak") ||
    name.includes("stub") ||
    name.includes(".pre-share") ||
    name.includes(".dir-backup")
  );
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isSeatDir(dir: string): boolean {
  return isDirectory(dir) && !isSymlink(dir);
}

/**
 * Seat folders for a provider: `~/.config/seats/<provider>/<slug>` first, then
 * a real `~/<liveName>` as `default`, then legacy `~/<liveName>-<slug>` folders.
 * The first folder found for a slug wins.
 */
export function discoverSeatDirs(home: string, provider: string, liveName: string): SeatDir[] {
  const found = new Map<string, string>();
  const store = storeDir(home, provider);

  for (const name of list(store)) {
    if (name.startsWith(".") || isIgnoredAccountDir(name)) continue;
    const dir = join(store, name);
    if (isSeatDir(dir)) found.set(name, dir);
  }

  const live = join(home, liveName);
  if (!found.has("default") && isSeatDir(live)) found.set("default", live);

  const prefix = `${liveName}-`;
  for (const name of list(home)) {
    if (!name.startsWith(prefix) || isIgnoredAccountDir(name)) continue;
    const slug = name.slice(prefix.length);
    const dir = join(home, name);
    if (!slug || found.has(slug) || !isSeatDir(dir)) continue;
    found.set(slug, dir);
  }

  return [...found].map(([slug, dir]) => ({ dir, slug, label: labelFromDirName(slug, "") }));
}

export function legacySeatDirs(home: string, liveName: string): Array<{ dir: string; slug: string }> {
  const prefix = `${liveName}-`;
  return list(home)
    .filter((name) => name.startsWith(prefix) && !isIgnoredAccountDir(name))
    .map((name) => ({ dir: join(home, name), slug: name.slice(prefix.length) }))
    .filter((item) => item.slug && isSeatDir(item.dir));
}
