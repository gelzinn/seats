import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { codexSessions, findCodexSession } from "../../../src/providers/codex/sessions.ts";
import { tempHome } from "../../helpers/temp-home.ts";

let env: ReturnType<typeof tempHome>;
beforeEach(() => (env = tempHome()));
afterEach(() => env.cleanup());

const ID = "01a141ab-35b6-7ac2-8bf3-62eae17dc84b";

describe("findCodexSession", () => {
  test("finds a rollout under sessions/YYYY/MM/DD, else in archived_sessions", () => {
    const dir = join(env.home, "seat");
    const live = env.write(`seat/sessions/2026/10/15/rollout-2026-10-15T19-25-01-${ID}.jsonl`, "{}\n");
    expect(findCodexSession(dir, ID)).toBe(live);

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

  test("resumes with codex resume <id>, and lists nothing", () => {
    expect(codexSessions.resumeArgs(ID)).toEqual(["resume", ID]);
    expect(codexSessions.list).toBeUndefined();
  });
});
