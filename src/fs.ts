import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** True when something (even a dangling symlink) sits at `path`. */
export function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export function readLink(path: string): string | undefined {
  try {
    return readlinkSync(path);
  } catch {
    return undefined;
  }
}

/** Absolute path a symlink points at, without following further links. */
export function linkTarget(path: string): string | undefined {
  const raw = readLink(path);
  return raw === undefined ? undefined : resolve(dirname(path), raw);
}

export function isInside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir + sep);
}

export function replaceSymlink(linkPath: string, targetPath: string): void {
  // Relative to where the link really lives, in case its folder is reached through a symlink.
  let base = dirname(linkPath);
  try {
    base = realpathSync(base);
  } catch {
    // folder doesn't exist yet
  }
  const rel = relative(base, targetPath) || basename(targetPath);
  try {
    unlinkSync(linkPath);
  } catch {
    // missing is fine
  }
  symlinkSync(rel, linkPath);
}

function symlinksUnder(dir: string): string[] {
  const found: string[] = [];
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) found.push(path);
    else if (entry.isDirectory()) found.push(...symlinksUnder(path));
  }
  return found;
}

/**
 * Renames `from` to `to` and fixes symlinks inside it that would break:
 * relative links pointing outside the tree, and absolute links pointing into it.
 */
export function moveTree(from: string, to: string): void {
  const links = isSymlink(from) ? [from] : isDirectory(from) ? symlinksUnder(from) : [];
  const broken = links
    .map((link) => ({ link, raw: readlinkSync(link), target: linkTarget(link)! }))
    .filter(({ raw, target }) => isInside(target, from) === isAbsolute(raw));
  renameSync(from, to);
  for (const { link, target } of broken) {
    const moved = to + link.slice(from.length);
    replaceSymlink(moved, isInside(target, from) ? to + target.slice(from.length) : target);
  }
}

/** Writes through symlinks: the link stays, the file it points at is replaced. */
export function writeJsonAtomic(path: string, data: unknown): void {
  const real = existsSync(path) ? realpathSync(path) : path;
  mkdirSync(dirname(real), { recursive: true, mode: 0o700 });
  const tmp = join(dirname(real), `.${basename(real)}.seats-${process.pid}`);
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, real);
}

export function assertSwitchable(livePath: string, seatDir: string): void {
  if (!isDirectory(livePath) && !isSymlink(livePath)) return;
  if (isSymlink(livePath)) return;
  const liveReal = livePath.replace(/\/$/, "");
  const seatReal = seatDir.replace(/\/$/, "");
  if (liveReal === seatReal) return;
  throw new Error(
    `${livePath} is a real directory. Move it to a named seat folder first, then let seats manage ${livePath} as a symlink.`,
  );
}
