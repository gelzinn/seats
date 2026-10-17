import { existsSync, mkdirSync, readdirSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { isSymlink, lexists, linkTarget, moveTree, replaceSymlink } from "./fs.ts";
import type { SkillsDir } from "./types.ts";

/** A tool's skills folder, tagged with the id shown in reports. */
export type SkillsTarget = SkillsDir & { id: string };

export type SkillsReport = {
  imported: string[];
  /** `tool: skill` for every link created. */
  linked: string[];
  /** `tool: skill` left alone because a different skill already uses the name. */
  conflicts: string[];
};

export function skillsLibrary(home: string): string {
  return join(home, ".agents", "skills");
}

function entries(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => !name.startsWith("."));
  } catch {
    return [];
  }
}

function real(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/**
 * Makes every tool see the same skills. Skills found only in a tool's folder
 * move to `~/.agents/skills` (links are copied as links), then each tool gets a
 * link for every skill another tool has. Library skills no tool uses stay
 * unlinked, and existing entries are never replaced.
 */
export function syncSkills(
  home: string,
  targets: SkillsTarget[],
  { dryRun = false }: { dryRun?: boolean } = {},
): SkillsReport {
  const report: SkillsReport = { imported: [], linked: [], conflicts: [] };
  const library = skillsLibrary(home);
  const libraryKey = real(library) ?? library;
  const inLibrary = new Set(entries(library));

  const dirs = new Map<string, { id: string; dir: string; native?: boolean }>();
  for (const target of targets) {
    const dir = target.dir(home);
    if (!dir) continue;
    const key = real(dir) ?? dir;
    if (key === libraryKey || dirs.has(key)) continue;
    dirs.set(key, { id: target.id, dir, native: target.native });
  }

  // Only skills some tool already uses: the library may hold many more on purpose.
  // Collected before importing, since native tools' skills leave their folder.
  const inUse = new Set([...dirs.values()].flatMap(({ dir }) => entries(dir)));

  for (const { id, dir, native } of dirs.values()) {
    for (const name of entries(dir)) {
      const local = join(dir, name);
      const shared = join(library, name);
      if (inLibrary.has(name)) {
        if (lexists(shared) && real(local) !== real(shared)) report.conflicts.push(`${id}: ${name}`);
        continue;
      }
      const isLink = isSymlink(local);
      if (isLink ? !existsSync(local) : !existsSync(join(local, "SKILL.md"))) continue;
      inLibrary.add(name);
      report.imported.push(name);
      if (dryRun) continue;
      mkdirSync(library, { recursive: true });
      if (isLink) {
        symlinkSync(linkTarget(local)!, shared);
        if (native) unlinkSync(local);
      } else {
        moveTree(local, shared);
        if (!native) replaceSymlink(local, shared);
      }
    }
  }

  for (const { id, dir, native } of dirs.values()) {
    if (native) continue;
    for (const name of inUse) {
      if (!inLibrary.has(name) || lexists(join(dir, name))) continue;
      report.linked.push(`${id}: ${name}`);
      if (dryRun) continue;
      mkdirSync(dir, { recursive: true });
      replaceSymlink(join(dir, name), join(library, name));
    }
  }

  return report;
}
