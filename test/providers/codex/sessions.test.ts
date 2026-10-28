import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  codexSessionList,
  codexSessions,
  findCodexSession,
  readCodexSession,
} from "../../../src/providers/codex/sessions.ts";
import { tempHome } from "../../helpers/temp-home.ts";

let env: ReturnType<typeof tempHome>;
beforeEach(() => (env = tempHome()));
afterEach(() => env.cleanup());

const ID = "01a141ab-35b6-7ac2-8bf3-62eae17dc84b";
const OTHER = "01a141ab-0000-7000-8000-000000000002";

const meta = (id: string, extra: Record<string, unknown> = {}) => ({
  type: "session_meta",
  payload: { id, cwd: "/p/one", source: "cli", ...extra },
});
const said = (message: string) => ({ type: "event_msg", payload: { type: "user_message", message } });
/** What Codex records for AGENTS.md and the environment: a `user` message nobody typed. */
const injected = {
  type: "response_item",
  payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions" }] },
};

/** A rollout at `path` inside the seat, one JSON line per item (strings go in as they are). */
function rollout(path: string, items: unknown[]): string {
  const lines = items.map((item) => (typeof item === "string" ? item : JSON.stringify(item)));
  return env.write(`seat/${path}`, `${lines.join("\n")}\n`);
}
const live = (id: string, stamp = "2026-10-15T19-25-01") =>
  `sessions/${stamp.slice(0, 4)}/${stamp.slice(5, 7)}/${stamp.slice(8, 10)}/rollout-${stamp}-${id}.jsonl`;

describe("findCodexSession", () => {
  test("finds a rollout under sessions/YYYY/MM/DD, else in archived_sessions", () => {
    const dir = join(env.home, "seat");
    const found = env.write(`seat/sessions/2026/10/15/rollout-2026-10-15T19-25-01-${ID}.jsonl`, "{}\n");
    expect(findCodexSession(dir, ID)).toBe(found);

    const archived = env.write("seat/archived_sessions/rollout-2026-10-01T08-00-00-old-id.jsonl", "{}\n");
    expect(findCodexSession(dir, "old-id")).toBe(archived);
  });

  test("matches the whole id, never a part of it, and is undefined when no rollout has it", () => {
    const dir = join(env.home, "seat");
    env.write(`seat/sessions/2026/10/15/rollout-2026-10-15T19-25-01-${ID}.jsonl`, "{}\n");
    expect(findCodexSession(dir, ID.slice(-12))).toBeUndefined();
    expect(findCodexSession(dir, ID.slice(0, 8))).toBeUndefined();
    expect(findCodexSession(dir, "missing")).toBeUndefined();
    expect(findCodexSession(join(env.home, "no-seat"), ID)).toBeUndefined();
  });

  test("finds a reverted thread by its id, in its newest rollout", () => {
    env.write(`seat/sessions/2026/10/15/rollout-2026-10-15T19-25-01-${ID}.jsonl`, "{}\n");
    const reverted = env.write(`seat/sessions/2026/10/16/rollout-2026-10-16T08-00-00-${ID}_${OTHER}.jsonl`, "{}\n");
    expect(findCodexSession(join(env.home, "seat"), ID)).toBe(reverted);
  });
});

describe("readCodexSession", () => {
  test("takes the folder from session_meta and the title from the first typed prompt", () => {
    const file = rollout(live(ID), [meta(ID), injected, said("fix   the\nlogin"), said("and then this")]);
    expect(readCodexSession(file)).toEqual({ cwd: "/p/one", title: "fix the login" });
  });

  test("reads a session_meta line longer than any transcript chunk", () => {
    const file = rollout(live(ID), [meta(ID, { base_instructions: { text: "x".repeat(200_000) } }), said("hi")]);
    expect(readCodexSession(file)).toEqual({ cwd: "/p/one", title: "hi" });
  });

  test("skips malformed and blank lines", () => {
    const file = rollout(live(ID), ["{not json", "", meta(ID), "[1,", said("still found")]);
    expect(readCodexSession(file)?.title).toBe("still found");
  });

  test("leaves out what codex resume doesn't list: exec runs, subagents, no prompt yet", () => {
    expect(readCodexSession(rollout(live("a"), [meta("a", { source: "exec" }), said("x")]))).toBeUndefined();
    const subagent = { subagent: { thread_spawn: { parent_thread_id: ID } } };
    expect(readCodexSession(rollout(live("b"), [meta("b", { source: subagent }), said("x")]))).toBeUndefined();
    expect(readCodexSession(rollout(live("c"), [meta("c"), injected]))).toBeUndefined();
    expect(readCodexSession(rollout(live("d"), [meta("d", { source: "vscode" }), said("x")]))?.title).toBe("x");
  });
});

describe("codexSessionList", () => {
  test("lists live rollouts with id, file and folder, leaving archived ones out", () => {
    const file = rollout(live(ID), [meta(ID), said("live one")]);
    rollout(`archived_sessions/rollout-2026-10-01T08-00-00-${OTHER}.jsonl`, [meta(OTHER), said("archived")]);
    const sessions = codexSessionList(join(env.home, "seat"));
    expect(sessions.map(({ id, file, cwd, title }) => ({ id, file, cwd, title }))).toEqual([
      { id: ID, file, cwd: "/p/one", title: "live one" },
    ]);
    expect(sessions[0]!.updatedAt).toBeInstanceOf(Date);
  });

  test("prefers the latest name given with /rename, from session_index.jsonl", () => {
    rollout(live(ID), [meta(ID), said("first prompt")]);
    rollout(live(OTHER), [meta(OTHER), said("other prompt")]);
    const names = [
      { id: ID, thread_name: "old name", updated_at: "2026-10-15T19:30:00Z" },
      { id: ID, thread_name: "new name", updated_at: "2026-10-15T20:00:00Z" },
    ];
    env.write("seat/session_index.jsonl", `${names.map((entry) => JSON.stringify(entry)).join("\n")}\n{cut`);
    const titles = codexSessionList(join(env.home, "seat")).map((item) => [item.id, item.title]);
    expect(titles.sort()).toEqual([
      [OTHER, "other prompt"],
      [ID, "new name"],
    ]);
  });

  test("lists a reverted thread once, from its newest rollout", () => {
    rollout(live(ID), [meta(ID), said("before revert")]);
    const reverted = rollout(live(`${ID}_${OTHER}`, "2026-10-16T08-00-00"), [meta(ID), said("after revert")]);
    expect(codexSessionList(join(env.home, "seat")).map((item) => [item.id, item.file])).toEqual([[ID, reverted]]);
  });

  test("is empty for a seat without sessions", () => {
    expect(codexSessionList(join(env.home, "no-seat"))).toEqual([]);
  });
});

test("resumes with codex resume <id>, and won't be moved", () => {
  expect(codexSessions.resumeArgs(ID)).toEqual(["resume", ID]);
  expect(codexSessions.noMove).toMatch(/stay on their seat/);
});
