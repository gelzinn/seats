import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { ago, inFolder, listSessions, moveSession, sessionSeats } from "../../src/commands/sessions.ts";
import type { Seat } from "../../src/types.ts";
import { tempHome } from "../helpers/temp-home.ts";

let env: ReturnType<typeof tempHome>;
beforeEach(() => (env = tempHome()));
afterEach(() => env.cleanup());

const seat = (slug: string): Seat => ({
  id: `claude:${slug}`,
  source: "claude",
  provider: "claude",
  kind: "cli",
  label: slug,
  dir: join(env.home, ".config/seats/claude", slug),
  signedIn: true,
});

/** A transcript in `slug`'s seat, last written `minutesAgo` minutes ago. */
function transcript(slug: string, id: string, cwd: string, title: string, minutesAgo: number): string {
  const line = { type: "user", cwd, sessionId: id, message: { content: title } };
  const file = env.write(
    `.config/seats/claude/${slug}/projects/${cwd.replace(/\//g, "-")}/${id}.jsonl`,
    `${JSON.stringify(line)}\n`,
  );
  const when = new Date(Date.now() - minutesAgo * 60_000);
  utimesSync(file, when, when);
  return file;
}

describe("listSessions", () => {
  test("lists every seat's conversations, newest first", () => {
    transcript("work", "aaaa1111", "/p/one", "oldest", 30);
    transcript("personal", "bbbb2222", "/p/two", "newest", 1);
    transcript("work", "cccc3333", "/p/one", "middle", 10);
    const sessions = listSessions([seat("work"), seat("personal")]);
    expect(sessions.map((item) => [item.seat.id, item.title])).toEqual([
      ["claude:personal", "newest"],
      ["claude:work", "middle"],
      ["claude:work", "oldest"],
    ]);
  });

  test("keeps to the current folder unless asked for all, using the cwd the transcript recorded", () => {
    const here = join(env.home, "code", "my-app");
    mkdirSync(here, { recursive: true });
    transcript("work", "aaaa1111", here, "here", 5);
    transcript("work", "bbbb2222", join(env.home, "code", "other"), "elsewhere", 1);
    const sessions = listSessions([seat("work")]);
    expect(sessions.filter((item) => inFolder(item, here)).map((item) => item.title)).toEqual(["here"]);
    expect(sessions).toHaveLength(2);
  });
});

describe("sessionSeats", () => {
  test("includes signed-out seat folders, whose history can still move", async () => {
    env.write(".config/seats/claude/old/.claude.json", "{}");
    expect((await sessionSeats(env.home)).map((item) => [item.id, item.signedIn])).toEqual([["claude:old", false]]);
  });
});

describe("moveSession", () => {
  test("copies the transcript and its folder to the same place in the other seat, keeping the original", () => {
    const file = transcript("work", "aaaa1111-0000", "/p/one", "fix it", 5);
    env.write(".config/seats/claude/work/projects/-p-one/aaaa1111-0000/tool-results/r.txt", "result");
    const result = moveSession(listSessions([seat("work"), seat("personal")]), "aaaa", seat("personal"));
    const copied = file.replace("/work/", "/personal/");
    expect(result.file).toBe(copied);
    expect(result.from.seat.id).toBe("claude:work");
    expect(readFileSync(copied, "utf8")).toBe(readFileSync(file, "utf8"));
    expect(existsSync(copied.replace(/\.jsonl$/, "/tool-results/r.txt"))).toBe(true);
    expect(existsSync(file)).toBe(true);
  });

  test("lists the candidates when the prefix fits more than one conversation", () => {
    transcript("work", "abc11111", "/p", "first", 2);
    transcript("work", "abc22222", "/p", "second", 1);
    expect(() => moveSession(listSessions([seat("work")]), "abc", seat("personal"))).toThrow(
      /abc fits 2 conversations[\s\S]*abc22222[\s\S]*abc11111/,
    );
    expect(() => moveSession(listSessions([seat("work")]), "zzz", seat("personal"))).toThrow(/No conversation/);
  });

  test("won't replace a copy the target already has, unless forced", () => {
    transcript("work", "aaaa1111", "/p", "newer", 1);
    const theirs = transcript("personal", "aaaa1111", "/p", "older", 9);
    const seats = [seat("work"), seat("personal")];
    expect(() => moveSession(listSessions(seats), "aaaa", seat("personal"))).toThrow(/already has aaaa1111.*--force/);
    expect(readFileSync(theirs, "utf8")).toContain("older");
    moveSession(listSessions(seats), "aaaa", seat("personal"), { force: true });
    expect(readFileSync(theirs, "utf8")).toContain("newer");
  });

  test("refuses to move a conversation to the seat it's on", () => {
    transcript("work", "aaaa1111", "/p", "here", 1);
    expect(() => moveSession(listSessions([seat("work")]), "aaaa", seat("work"))).toThrow(/already on claude:work/);
  });
});

test("ago says how long ago, roughly", () => {
  const now = new Date("2030-01-10T12:00:00Z");
  const before = (minutes: number) => new Date(+now - minutes * 60_000);
  expect([0, 5, 120, 3 * 24 * 60].map((minutes) => ago(before(minutes), now))).toEqual([
    "just now",
    "5m ago",
    "2h ago",
    "3d ago",
  ]);
});
