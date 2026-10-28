import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SeatSource, Session } from "../../types.ts";

/**
 * `rollout-2026-10-15T19-25-01-<id>.jsonl`. A reverted thread's file is
 * `…-<id>_<rollout id>.jsonl`: the session id is the part before `_`.
 * Compressed `.jsonl.zst` rollouts don't match.
 */
const ROLLOUT = /^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-([^_]+)(?:_.+)?\.jsonl$/;

/**
 * Enough for the `session_meta` line, which carries the whole base
 * instructions, and the turn context that comes before the first prompt.
 */
const HEAD = 512 * 1024;

function entries(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Every rollout under `dir`, at any depth. */
function rollouts(dir: string): { file: string; id: string; stamp: string }[] {
  return entries(dir).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return rollouts(path);
    const match = ROLLOUT.exec(entry.name);
    return match ? [{ file: path, id: match[2]!, stamp: match[1]! }] : [];
  });
}

/** The newest rollout of `sessionId` under `dir`: a reverted thread has several. */
function findRollout(dir: string, sessionId: string): string | undefined {
  return rollouts(dir)
    .filter((rollout) => rollout.id === sessionId)
    .sort((a, b) => b.stamp.localeCompare(a.stamp) || b.file.localeCompare(a.file))[0]?.file;
}

/** `<seat>/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl`, else `<seat>/archived_sessions/`. Matched by name alone. */
export function findCodexSession(dir: string, sessionId: string): string | undefined {
  return findRollout(join(dir, "sessions"), sessionId) ?? findRollout(join(dir, "archived_sessions"), sessionId);
}

/** The complete lines in the first `bytes` of `file`. A line cut at the end is dropped. */
function head(file: string, bytes = HEAD): string[] {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(Math.min(bytes, statSync(file).size));
    const text = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString("utf8");
    const lines = text.split("\n");
    return buffer.length < bytes ? lines : lines.slice(0, -1);
  } finally {
    closeSync(fd);
  }
}

type Line = {
  type?: unknown;
  payload?: { type?: unknown; cwd?: unknown; source?: unknown; message?: unknown };
};

/** Sources `codex resume` lists: exec runs, subagents and the like aren't conversations to continue. */
const INTERACTIVE = new Set(["cli", "vscode"]);

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value : undefined);
const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();

/**
 * Folder and first prompt of one rollout, from its `session_meta` and first
 * `user_message` event. The `user` messages beside them also carry AGENTS.md
 * and the environment, so they aren't read. Undefined for a rollout `codex
 * resume` wouldn't list, or one with no prompt yet.
 */
export function readCodexSession(file: string): Pick<Session, "cwd" | "title"> | undefined {
  let cwd: string | undefined;
  let interactive = false;
  for (const raw of head(file)) {
    if (!raw.trim()) continue;
    let line: Line;
    try {
      line = JSON.parse(raw) as Line;
    } catch {
      continue;
    }
    if (line.type === "session_meta") {
      cwd = text(line.payload?.cwd);
      interactive = INTERACTIVE.has(line.payload?.source as string);
    }
    if (!interactive) continue;
    const prompt = line.type === "event_msg" && line.payload?.type === "user_message" && text(line.payload.message);
    if (prompt) return { cwd, title: oneLine(prompt) };
  }
  return undefined;
}

/** Names given with `/rename`, from `<seat>/session_index.jsonl`: the last one for an id wins. */
function threadNames(dir: string): Map<string, string> {
  const names = new Map<string, string>();
  let content = "";
  try {
    content = readFileSync(join(dir, "session_index.jsonl"), "utf8");
  } catch {
    return names;
  }
  for (const raw of content.split("\n")) {
    try {
      const entry = JSON.parse(raw) as { id?: unknown; thread_name?: unknown };
      const name = text(entry.thread_name);
      if (typeof entry.id === "string" && name) names.set(entry.id, oneLine(name));
    } catch {
      // cut or blank line
    }
  }
  return names;
}

/**
 * `<seat>/sessions/…/rollout-…-<id>.jsonl`, the conversations `codex resume`
 * lists. Archived ones stay out, as they do there.
 */
export function codexSessionList(dir: string): Session[] {
  const names = threadNames(dir);
  const newest = new Map<string, { file: string; stamp: string }>();
  for (const rollout of rollouts(join(dir, "sessions"))) {
    const kept = newest.get(rollout.id);
    if (!kept || rollout.stamp > kept.stamp) newest.set(rollout.id, rollout);
  }
  const sessions: Session[] = [];
  for (const [id, { file }] of newest) {
    try {
      const found = readCodexSession(file);
      if (found)
        sessions.push({ id, file, ...found, title: names.get(id) ?? found.title, updatedAt: statSync(file).mtime });
    } catch {
      // unreadable rollout: leave it out
    }
  }
  return sessions;
}

/**
 * Listed, never copied. `codex resume <id>` does find a rollout copied into
 * another seat, but the conversation keeps the reasoning Codex encrypted for
 * the account that ran it, and replaying that under another account can be
 * refused.
 */
export const codexSessions: NonNullable<SeatSource["sessions"]> = {
  list: codexSessionList,
  resumeArgs: (sessionId) => ["resume", sessionId],
  find: findCodexSession,
  resumedId: ([command, id]) => (command === "resume" && id && !id.startsWith("-") ? id : undefined),
  noMove:
    "Codex conversations stay on their seat: they carry reasoning encrypted for the account that ran them, which another account can refuse.",
};
