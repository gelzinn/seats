import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isInside, isSymlink, lexists, linkTarget, moveTree, replaceSymlink } from "./fs.ts";

export type ShareReport = { linked: string[]; backups: string[] };

function mtime(path: string): number {
  return lstatSync(path).mtimeMs;
}

function backupPath(path: string): string {
  let candidate = `${path}.seats-backup`;
  for (let n = 2; lexists(candidate); n++) candidate = `${path}.seats-backup-${n}`;
  return candidate;
}

function parseRecord(buffer: Buffer): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(buffer.toString("utf8"));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Newer wins on conflicts; keys only the older copy has are kept at every depth. */
function deepFill(newer: unknown, older: unknown): unknown {
  if (!isRecord(newer) || !isRecord(older)) return newer;
  const merged: Record<string, unknown> = { ...older };
  for (const [key, value] of Object.entries(newer)) merged[key] = deepFill(value, older[key]);
  return merged;
}

/** True when every value in `older` survives unchanged in `merged`. */
function covers(merged: unknown, older: unknown): boolean {
  if (isRecord(merged) && isRecord(older)) {
    return Object.keys(older).every((key) => covers(merged[key], older[key]));
  }
  return JSON.stringify(merged) === JSON.stringify(older);
}

/** Folds a file into the shared copy. Returns false when `local` must be kept as a backup. */
function absorbFile(local: string, shared: string, report: ShareReport): boolean {
  const localData = readFileSync(local);
  const sharedData = readFileSync(shared);
  if (localData.equals(sharedData)) return true;

  const localNewer = mtime(local) > mtime(shared);
  const [newer, older] = localNewer ? [localData, sharedData] : [sharedData, localData];
  const newerJson = parseRecord(newer);
  const olderJson = parseRecord(older);

  if (newerJson && olderJson) {
    const merged = deepFill(newerJson, olderJson);
    const complete = covers(merged, olderJson);
    if (!complete && !localNewer) return false;
    if (!complete) {
      const saved = `${shared}.seats-backup`; // only the previous version
      writeFileSync(saved, sharedData);
      report.backups.push(saved);
    }
    writeFileSync(shared, `${JSON.stringify(merged, null, 2)}\n`);
    return true;
  }

  if (!localNewer) return false;
  const saved = `${shared}.seats-backup`; // only the previous version
  writeFileSync(saved, sharedData);
  report.backups.push(saved);
  writeFileSync(shared, localData);
  return true;
}

/** Moves whatever fits from `local` into `shared`, leaving only conflicts behind. */
function absorb(local: string, shared: string, report: ShareReport): void {
  const from = lstatSync(local);
  const to = lstatSync(shared);

  if (from.isDirectory() && to.isDirectory()) {
    for (const name of readdirSync(local)) {
      const child = join(local, name);
      const target = join(shared, name);
      if (!lexists(target)) moveTree(child, target);
      else absorb(child, target, report);
    }
    if (readdirSync(local).length === 0) rmdirSync(local);
    return;
  }

  if (from.isFile() && to.isFile() && absorbFile(local, shared, report)) {
    rmSync(local);
  }
}

/**
 * Makes every seat folder point at one shared copy of each item.
 * The newest real copy seeds the shared folder; the rest are merged into it.
 * Anything that cannot be merged is kept next to the seat as `*.seats-backup`.
 * Symlinks that point outside all seat folders are left alone.
 */
export function shareItems(seatDirs: string[], sharedRoot: string, items: string[]): ShareReport {
  const report: ShareReport = { linked: [], backups: [] };

  for (const item of items) {
    const shared = join(sharedRoot, item);
    const locals = seatDirs
      .map((dir) => join(dir, item))
      .filter((path) => lexists(path) && !isSymlink(path))
      .sort((a, b) => mtime(b) - mtime(a));

    for (const local of locals) {
      if (!lexists(shared)) {
        mkdirSync(dirname(shared), { recursive: true, mode: 0o700 });
        moveTree(local, shared);
        continue;
      }
      absorb(local, shared, report);
      if (lexists(local)) {
        const saved = backupPath(local);
        moveTree(local, saved);
        report.backups.push(saved);
      }
    }

    if (!lexists(shared)) continue;

    for (const dir of seatDirs) {
      const link = join(dir, item);
      if (isSymlink(link)) {
        const target = linkTarget(link);
        if (target === shared) continue;
        const userManaged = existsSync(link) && target && !seatDirs.some((seat) => isInside(target, seat));
        if (userManaged) continue;
      }
      mkdirSync(dirname(link), { recursive: true });
      replaceSymlink(link, shared);
      report.linked.push(link);
    }
  }

  return report;
}
