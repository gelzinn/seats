import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SeatSource, Session } from "../../types.ts";
import { claudeFailover } from "./failover.ts";

/** Enough for the cwd and first prompt at the start, and the latest title near the end. */
const CHUNK = 64 * 1024;

type Line = {
  type?: unknown;
  cwd?: unknown;
  isMeta?: unknown;
  isSidechain?: unknown;
  customTitle?: unknown;
  aiTitle?: unknown;
  summary?: unknown;
  message?: { content?: unknown };
};

function read(fd: number, position: number, length: number): string {
  const buffer = Buffer.alloc(length);
  return buffer.subarray(0, readSync(fd, buffer, 0, length, position)).toString("utf8");
}

/**
 * The complete lines at the start and end of a transcript, without reading
 * the middle: transcripts grow to many megabytes. Cut lines are dropped.
 */
export function headAndTail(file: string, chunk = CHUNK): string[] {
  const fd = openSync(file, "r");
  try {
    const size = statSync(file).size;
    if (size <= 2 * chunk) return read(fd, 0, size).split("\n");
    const head = read(fd, 0, chunk).split("\n").slice(0, -1);
    const tail = read(fd, size - chunk, chunk)
      .split("\n")
      .slice(1);
    return [...head, ...tail];
  } finally {
    closeSync(fd);
  }
}

/** What Claude Code wraps slash commands, shell escapes and background notices in: not typed prompts. */
const WRAPPER = /^\s*<(command-|local-command-|bash-|task-notification|system-reminder)/;

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value : undefined);
const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();

/** What the user typed: tool results, meta lines and wrappers aren't prompts. Tags are dropped. */
function prompt(line: Line): string | undefined {
  if (line.type !== "user" || line.isMeta === true || line.isSidechain === true) return undefined;
  const content = line.message?.content;
  const typed = Array.isArray(content)
    ? content.find((block) => block?.type === "text" && typeof block.text === "string")?.text
    : content;
  const value = text(typed);
  return value && !WRAPPER.test(value) ? text(value.replace(/<[^>]*>/g, " ")) : undefined;
}

/**
 * Title and folder of one transcript. The title is the latest name the user
 * gave it, else Claude's own title, else a summary, else the first prompt.
 */
export function readClaudeSession(file: string): Pick<Session, "cwd" | "title"> | undefined {
  let cwd: string | undefined;
  let first: string | undefined;
  const titles: Record<"custom" | "ai" | "summary", string | undefined> = {
    custom: undefined,
    ai: undefined,
    summary: undefined,
  };
  for (const raw of headAndTail(file)) {
    if (!raw.trim()) continue;
    let line: Line;
    try {
      line = JSON.parse(raw) as Line;
    } catch {
      continue;
    }
    cwd ??= text(line.cwd);
    first ??= prompt(line);
    if (line.type === "custom-title") titles.custom = text(line.customTitle) ?? titles.custom;
    if (line.type === "ai-title") titles.ai = text(line.aiTitle) ?? titles.ai;
    if (line.type === "summary") titles.summary = text(line.summary) ?? titles.summary;
  }
  const title = titles.custom ?? titles.ai ?? titles.summary ?? first;
  return title ? { cwd, title: oneLine(title) } : undefined;
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** `<seat>/projects/<encoded cwd>/<session id>.jsonl`. Subagent transcripts (`agent-*`) aren't sessions. */
export function claudeSessionList(dir: string): Session[] {
  const projects = join(dir, "projects");
  const sessions: Session[] = [];
  for (const project of list(projects)) {
    for (const name of list(join(projects, project))) {
      if (!name.endsWith(".jsonl") || name.startsWith("agent-")) continue;
      const file = join(projects, project, name);
      try {
        const found = readClaudeSession(file);
        if (found)
          sessions.push({ id: name.slice(0, -".jsonl".length), file, ...found, updatedAt: statSync(file).mtime });
      } catch {
        // unreadable transcript: leave it out
      }
    }
  }
  return sessions;
}

export const claudeSessions: NonNullable<SeatSource["sessions"]> = {
  list: claudeSessionList,
  resumeArgs: (sessionId) => claudeFailover.resumeArgs(sessionId),
};
