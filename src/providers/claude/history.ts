import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { SeatSource } from "../../types.ts";

/** How Claude Code names a project folder: every character but letters and digits becomes `-`. */
export const projectFolder = (path: string) => path.replace(/[^a-zA-Z0-9]/g, "-");

function read(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return undefined;
  }
}

/**
 * The main checkout of the git repository around `cwd`, else undefined.
 * A worktree's `.git` is a file naming `<main>/.git/worktrees/<name>`,
 * whose `commondir` leads back to `<main>/.git`. Reads files only.
 */
export function gitRoot(cwd: string): string | undefined {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const dotGit = join(dir, ".git");
    let isDir: boolean | undefined;
    try {
      isDir = statSync(dotGit).isDirectory();
    } catch {
      // not here
    }
    if (isDir) return dir;
    if (isDir === false) {
      const gitdir = read(dotGit)?.match(/^gitdir:\s*(.+)$/m)?.[1];
      if (!gitdir) return dir;
      const linked = isAbsolute(gitdir) ? gitdir : resolve(dir, gitdir);
      const common = read(join(linked, "commondir"));
      // No commondir: a submodule, which is its own repository.
      return common ? dirname(resolve(linked, common)) : dir;
    }
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * Conversations live in `projects/<folder>/`, with subagents and tool output
 * in `<session id>/` beside each transcript; `/rewind` reads `file-history/`;
 * plan mode keeps a session's plan in `plans/`; older versions kept todos in
 * `todos/`. Auto-memory is `projects/<folder>/memory/`, where the folder is
 * the repository's, shared by its worktrees and subfolders, else the cwd's.
 */
export const claudeHistory: NonNullable<SeatSource["history"]> = {
  projects: "projects",
  items: ["projects", "file-history", "plans", "todos"],
  memory: "memory",
  memoryProject: (cwd) => projectFolder(gitRoot(cwd) ?? resolve(cwd)),
};
