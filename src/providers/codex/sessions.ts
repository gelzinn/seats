import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { SeatSource } from "../../types.ts";

/** `rollout-2026-10-15T19-25-01-<id>.jsonl`: the id is everything after the timestamp. */
const ROLLOUT = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/;

function entries(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** The rollout of `sessionId` under `dir`, at any depth. */
function findRollout(dir: string, sessionId: string): string | undefined {
  for (const entry of entries(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findRollout(path, sessionId);
      if (found) return found;
    } else if (ROLLOUT.exec(entry.name)?.[1] === sessionId) return path;
  }
  return undefined;
}

/** `<seat>/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl`, else `<seat>/archived_sessions/`. Matched by name alone. */
export function findCodexSession(dir: string, sessionId: string): string | undefined {
  return findRollout(join(dir, "sessions"), sessionId) ?? findRollout(join(dir, "archived_sessions"), sessionId);
}

/**
 * Finding only, for `seats hook herdr`: no `list`, so `seats sessions` and
 * `seats move` leave Codex out. It isn't confirmed that a copied rollout
 * resumes on another account.
 */
export const codexSessions: NonNullable<SeatSource["sessions"]> = {
  resumeArgs: (sessionId) => ["resume", sessionId],
  find: findCodexSession,
};
