import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { claudeSessionList, headAndTail, readClaudeSession } from "../../../src/providers/claude/sessions.ts";
import { tempHome } from "../../helpers/temp-home.ts";

let env: ReturnType<typeof tempHome>;
beforeEach(() => (env = tempHome()));
afterEach(() => env.cleanup());

const jsonl = (...lines: unknown[]) => `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
const user = (content: unknown, extra: object = {}) => ({
  type: "user",
  cwd: "/work/app",
  message: { content },
  ...extra,
});

describe("readClaudeSession", () => {
  test("titles a conversation with its first typed prompt, on one line", () => {
    const file = env.write(
      "t.jsonl",
      jsonl(
        { type: "queue-operation" },
        user("<command-name>/clear</command-name>"),
        user("Caveat: injected", { isMeta: true }),
        user([{ type: "tool_result", content: "output" }]),
        user("<task-notification>done</task-notification>"),
        user("<pasted></pasted>"),
        user([{ type: "text", text: "<pasted>Fix the\n  login   bug</pasted>" }]),
        user("second prompt"),
      ),
    );
    expect(readClaudeSession(file)).toEqual({ cwd: "/work/app", title: "Fix the login bug" });
  });

  test("prefers a name the user gave over Claude's title, a summary or the prompt", () => {
    const lines: unknown[] = [user("first prompt"), { type: "summary", summary: "A summary" }];
    expect(readClaudeSession(env.write("a.jsonl", jsonl(...lines)))?.title).toBe("A summary");
    lines.push({ type: "ai-title", aiTitle: "Old title" }, { type: "ai-title", aiTitle: "Claude's title" });
    expect(readClaudeSession(env.write("b.jsonl", jsonl(...lines)))?.title).toBe("Claude's title");
    lines.push({ type: "custom-title", customTitle: "My name" });
    expect(readClaudeSession(env.write("c.jsonl", jsonl(...lines)))?.title).toBe("My name");
  });

  test("leaves out transcripts with nothing to show", () => {
    expect(readClaudeSession(env.write("empty.jsonl", jsonl({ type: "queue-operation" })))).toBeUndefined();
  });

  test("reads the cwd from the start and the title from the end of a large file, skipping the middle", () => {
    const filler = { type: "attachment", cwd: "/elsewhere", data: "x".repeat(300_000) };
    const file = env.write(
      "big.jsonl",
      jsonl(
        user("hello"),
        filler,
        { type: "assistant", cwd: "/elsewhere" },
        { type: "custom-title", customTitle: "Late" },
      ),
    );
    expect(readClaudeSession(file)).toEqual({ cwd: "/work/app", title: "Late" });
    expect(headAndTail(file, 1024).some((line) => line.includes("xxxx"))).toBe(false);
  });
});

describe("claudeSessionList", () => {
  test("finds <seat>/projects/*/<id>.jsonl, with the cwd from the transcript, not the folder name", () => {
    env.write("seat/projects/-work-my-app/abc.jsonl", jsonl(user("hi", { cwd: "/work/my-app" })));
    env.write("seat/projects/-work-my-app/agent-1.jsonl", jsonl(user("subagent")));
    env.write("seat/projects/-work-my-app/abc/subagents/x.jsonl", jsonl(user("nested")));
    const sessions = claudeSessionList(`${env.home}/seat`);
    expect(sessions.map(({ id, cwd, title }) => ({ id, cwd, title }))).toEqual([
      { id: "abc", cwd: "/work/my-app", title: "hi" },
    ]);
  });

  test("returns nothing for a seat without projects", () => {
    expect(claudeSessionList(`${env.home}/none`)).toEqual([]);
  });
});
