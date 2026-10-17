import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { isSymlink, moveTree, replaceSymlink } from "./fs.ts";
import { seatsHome } from "./store.ts";

export type InstructionsTarget = {
  id: string;
  /** Global instructions file, or undefined when the tool isn't installed. */
  file: (home: string) => string | undefined;
};

export type InstructionsReport = { linked: string[]; conflicts: string[] };

export function instructionsFile(home: string): string {
  return join(seatsHome(home), "shared", "AGENTS.md");
}

/** Ignores HTML comments and surrounding whitespace, so an import marker isn't a difference. */
function normalized(file: string): string {
  return readFileSync(file, "utf8").replace(/<!--[\s\S]*?-->/g, "").trim();
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Points every tool's global instructions at one `AGENTS.md`. The first
 * non-empty file seeds it. Files with the same text (or empty ones) become links;
 * files with different text are reported and left alone.
 */
export function syncInstructions(
  home: string,
  targets: InstructionsTarget[],
  { dryRun = false }: { dryRun?: boolean } = {},
): InstructionsReport {
  const report: InstructionsReport = { linked: [], conflicts: [] };
  const canonical = instructionsFile(home);

  // Follow links so a seat's CLAUDE.md -> shared/claude/CLAUDE.md is handled at its real file.
  const files = targets.flatMap((target) => {
    const file = target.file(home);
    return file ? [{ id: target.id, file, path: real(file) }] : [];
  });

  let text = existsSync(canonical) ? normalized(canonical) : undefined;
  let seedPath: string | undefined;
  if (text === undefined) {
    const seed = files.find(({ path }) => existsSync(path) && !isSymlink(path) && normalized(path) !== "");
    if (!seed) return report;
    text = normalized(seed.path);
    seedPath = seed.path;
    report.linked.push(seed.id);
    if (!dryRun) {
      mkdirSync(dirname(canonical), { recursive: true, mode: 0o700 });
      moveTree(seed.path, canonical);
      replaceSymlink(seed.path, canonical);
    }
  }

  for (const { id, file, path } of files) {
    if (path === seedPath || path === real(canonical)) continue;
    if (existsSync(path)) {
      const local = normalized(path);
      if (local !== "" && local !== text) {
        report.conflicts.push(id);
        continue;
      }
    }
    report.linked.push(id);
    if (dryRun) continue;
    const target = existsSync(path) ? path : file;
    mkdirSync(dirname(target), { recursive: true });
    replaceSymlink(target, canonical);
  }

  return report;
}
