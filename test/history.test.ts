import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  utimesSync,
} from "node:fs";
import { join } from "node:path";
import { excludeHistory, includeHistory } from "../src/commands/exclude.ts";
import { planExport } from "../src/commands/export.ts";
import { removeSeat, renameSeat } from "../src/commands/manage.ts";
import { copyTranscript } from "../src/commands/run.ts";
import { listSessions, moveSession } from "../src/commands/sessions.ts";
import { syncSeats } from "../src/commands/sync.ts";
import { linkSessionHistory, setHistorySharing } from "../src/history.ts";
import type { RunningProcess } from "../src/processes.ts";
import { claudeHistory, gitRoot } from "../src/providers/claude/history.ts";
import { seatSourceById } from "../src/providers/index.ts";
import { readConfig, writeConfig } from "../src/store.ts";
import type { Seat } from "../src/types.ts";
import { tempHome } from "./helpers/temp-home.ts";

let env: ReturnType<typeof tempHome>;
beforeEach(() => (env = tempHome()));
afterEach(() => env.cleanup());

const claude = seatSourceById("claude");
const none = () => [];
const seat = (slug: string) => join(env.home, ".config/seats/claude", slug);
const shared = (...parts: string[]) => join(env.home, ".config/seats/shared/claude", ...parts);
const isLink = (path: string) => lstatSync(path).isSymbolicLink();
const text = (path: string) => readFileSync(path, "utf8");

/** Everything in the backups a share left, files and folders alike. */
function backedUp(paths: string[]): string {
  return paths
    .map((path) =>
      lstatSync(path).isDirectory() ? backedUp(readdirSync(path).map((name) => join(path, name))) : text(path),
    )
    .join("\n");
}

/** Claude seats, each signed out but a seat folder all the same. */
function seats(...slugs: string[]): void {
  for (const slug of slugs) env.write(`.config/seats/claude/${slug}/.claude.json`, "{}");
}

/** Writes `data` at `path` with an mtime `secondsAgo` seconds back. */
function aged(path: string, data: string, secondsAgo: number): string {
  const file = env.write(path, data);
  const when = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(file, when, when);
  return file;
}

const transcript = (slug: string, id: string, line: object, secondsAgo = 60) =>
  aged(`.config/seats/claude/${slug}/projects/-repo/${id}.jsonl`, `${JSON.stringify(line)}\n`, secondsAgo);

const memory = (slug: string, name: string, data: string, secondsAgo = 60) =>
  aged(`.config/seats/claude/${slug}/projects/-repo/memory/${name}`, data, secondsAgo);

const asSeat = (slug: string): Seat => ({
  id: `claude:${slug}`,
  source: "claude",
  provider: "claude",
  kind: "cli",
  label: slug,
  dir: seat(slug),
  signedIn: true,
});

describe("seats share sessions", () => {
  test("merges every seat's conversations, newest wins, each older copy kept as its own backup", () => {
    seats("a", "b", "c");
    transcript("a", "s1", { type: "user", cwd: "/repo", message: { content: "from a" } }, 300);
    transcript("b", "s1", { type: "user", cwd: "/repo", message: { content: "from b" } }, 10);
    transcript("c", "s1", { type: "user", cwd: "/repo", message: { content: "from c" } }, 200);
    transcript("c", "s2", { type: "user", cwd: "/repo", message: { content: "only c" } });
    env.write(".config/seats/claude/a/file-history/s1/abc@v1", "checkpoint");

    const report = setHistorySharing(env.home, "sessions", true, { processes: none });

    expect(readConfig(env.home).shareSessions).toBe(true);
    // One line stays one line: transcripts are never merged as JSON.
    expect(text(shared("projects/-repo/s1.jsonl"))).toBe(
      '{"type":"user","cwd":"/repo","message":{"content":"from b"}}\n',
    );
    expect(text(shared("projects/-repo/s2.jsonl"))).toContain("only c");
    expect(text(shared("file-history/s1/abc@v1"))).toBe("checkpoint");
    for (const slug of ["a", "b", "c"]) {
      expect(isLink(join(seat(slug), "projects"))).toBe(true);
      expect(isLink(join(seat(slug), "file-history"))).toBe(true);
      expect(text(join(seat(slug), "projects/-repo/s1.jsonl"))).toContain("from b");
    }
    const kept = backedUp(report.backups);
    expect(kept).toContain("from a");
    expect(kept).toContain("from c");
    expect(new Set(report.backups).size).toBe(report.backups.length);
  });

  test("off gives each seat a real copy of every conversation, with its timestamps", () => {
    seats("a", "b");
    transcript("a", "s1", { type: "user", message: { content: "one" } }, 600);
    transcript("b", "s2", { type: "user", message: { content: "two" } });
    setHistorySharing(env.home, "sessions", true, { processes: none });
    const mtime = statSync(shared("projects/-repo/s1.jsonl")).mtimeMs;

    const report = setHistorySharing(env.home, "sessions", false, { processes: none });

    expect(readConfig(env.home).shareSessions).toBeUndefined();
    expect(report.copied).toContain(join(seat("a"), "projects"));
    for (const slug of ["a", "b"]) {
      expect(isLink(join(seat(slug), "projects"))).toBe(false);
      expect(readdirSync(join(seat(slug), "projects/-repo")).sort()).toEqual(["s1.jsonl", "s2.jsonl"]);
      expect(statSync(join(seat(slug), "projects/-repo/s1.jsonl")).mtimeMs).toBe(mtime);
    }
    // Nothing is deleted: the shared copy stays where it was.
    expect(existsSync(shared("projects/-repo/s1.jsonl"))).toBe(true);
  });

  test("refuses while the CLI runs on a seat whose conversations would move", () => {
    seats("a", "b");
    transcript("a", "s1", { type: "user" });
    const running = (): RunningProcess[] => [{ pid: 4242, argv: ["claude"], env: { CLAUDE_CONFIG_DIR: seat("b") } }];
    expect(() => setHistorySharing(env.home, "sessions", true, { processes: running })).toThrow(
      "claude is running on claude:b (pid 4242)",
    );
    expect(isLink(join(seat("a"), "projects"))).toBe(false);
    expect(readConfig(env.home).shareSessions).toBeUndefined();
  });

  test("a dry run lists what would move, link and back up, and changes nothing", () => {
    seats("a", "b");
    transcript("a", "s1", { type: "user", message: { content: "a" } }, 100);
    transcript("b", "s1", { type: "user", message: { content: "b" } });

    const report = setHistorySharing(env.home, "sessions", true, { dryRun: true, processes: none });

    expect(report.moved.sort()).toEqual([join(seat("a"), "projects"), join(seat("b"), "projects")]);
    expect(report.linked).toContain(join(seat("a"), "projects"));
    expect(report.backups).toEqual(["projects/-repo/s1.jsonl"]);
    expect(isLink(join(seat("a"), "projects"))).toBe(false);
    expect(existsSync(shared("projects"))).toBe(false);
    expect(readConfig(env.home).shareSessions).toBeUndefined();
  });

  test("sync links a seat added later", () => {
    seats("a", "b");
    transcript("a", "s1", { type: "user" });
    setHistorySharing(env.home, "sessions", true, { processes: none });
    seats("c");
    transcript("c", "s9", { type: "user", message: { content: "new seat" } });

    syncSeats(env.home, ["claude"]);

    expect(isLink(join(seat("c"), "projects"))).toBe(true);
    expect(text(join(seat("a"), "projects/-repo/s9.jsonl"))).toContain("new seat");
  });
});

describe("seats share memory", () => {
  test("merges memory entry by entry, links it into each seat, and leaves conversations alone", () => {
    seats("a", "b");
    memory("a", "MEMORY.md", "index a", 300);
    memory("a", "only-a.md", "a");
    memory("b", "MEMORY.md", "index b", 10);
    memory("b", "only-b.md", "b");
    transcript("a", "s1", { type: "user" });

    const report = setHistorySharing(env.home, "memory", true);

    const folder = shared("projects/-repo/memory");
    expect(readdirSync(folder).sort()).toEqual(["MEMORY.md", "only-a.md", "only-b.md"]);
    expect(text(join(folder, "MEMORY.md"))).toBe("index b");
    expect(backedUp(report.backups)).toBe("index a");
    for (const slug of ["a", "b"]) {
      expect(isLink(join(seat(slug), "projects/-repo/memory"))).toBe(true);
      expect(isLink(join(seat(slug), "projects"))).toBe(false);
    }
    expect(existsSync(shared("projects/-repo/s1.jsonl"))).toBe(false);
  });

  test("a project only one seat has memory for reaches the others too", () => {
    seats("a", "b");
    memory("a", "note.md", "x");
    setHistorySharing(env.home, "memory", true);
    expect(text(join(seat("b"), "projects/-repo/memory/note.md"))).toBe("x");
  });

  test("off gives each seat a real copy", () => {
    seats("a", "b");
    memory("a", "note.md", "x");
    setHistorySharing(env.home, "memory", true);

    const report = setHistorySharing(env.home, "memory", false);

    expect(report.copied.sort()).toEqual([
      join(seat("a"), "projects/-repo/memory"),
      join(seat("b"), "projects/-repo/memory"),
    ]);
    for (const slug of ["a", "b"]) {
      expect(isLink(join(seat(slug), "projects/-repo/memory"))).toBe(false);
      expect(text(join(seat(slug), "projects/-repo/memory/note.md"))).toBe("x");
    }
  });

  test("turning conversations on afterwards keeps the memory links out of the backups", () => {
    seats("a", "b");
    memory("a", "note.md", "x");
    transcript("a", "s1", { type: "user" });
    transcript("b", "s2", { type: "user" });
    setHistorySharing(env.home, "memory", true);

    const report = setHistorySharing(env.home, "sessions", true, { processes: none });

    expect(report.backups).toEqual([]);
    expect(lstatSync(shared("projects/-repo/memory")).isDirectory()).toBe(true);
    expect(text(join(seat("b"), "projects/-repo/memory/note.md"))).toBe("x");
    expect(readdirSync(seat("a")).some((name) => name.includes("seats-backup"))).toBe(false);

    // Conversations off, memory still on: each seat has its conversations, and memory stays linked.
    setHistorySharing(env.home, "sessions", false, { processes: none });
    for (const slug of ["a", "b"]) {
      expect(isLink(join(seat(slug), "projects"))).toBe(false);
      expect(isLink(join(seat(slug), "projects/-repo/memory"))).toBe(true);
      expect(existsSync(join(seat(slug), "projects/-repo/s1.jsonl"))).toBe(true);
    }
  });

  test("the session hook links memory for a project no seat has memory for yet, keyed by the repository", () => {
    seats("a", "b");
    memory("a", "note.md", "x");
    setHistorySharing(env.home, "memory", true);
    // A worktree of ~/code/app: memory belongs to the main checkout.
    mkdirSync(join(env.home, "code/app/.git/worktrees/feat"), { recursive: true });
    env.write("code/app/.git/worktrees/feat/commondir", "../..\n");
    env.write("wt/feat/.git", `gitdir: ${join(env.home, "code/app/.git/worktrees/feat")}\n`);
    mkdirSync(join(env.home, "wt/feat/src"));
    const project = claudeHistory.memoryProject(join(env.home, "wt/feat/src"));
    expect(project).toBe(join(env.home, "code/app").replace(/[^a-zA-Z0-9]/g, "-"));

    linkSessionHistory(env.home, claude, seat("b"), join(env.home, "wt/feat/src"));

    for (const slug of ["a", "b"]) expect(isLink(join(seat(slug), "projects", project, "memory"))).toBe(true);
    expect(lstatSync(shared("projects", project, "memory")).isDirectory()).toBe(true);
  });

  test("seats hook session links a seat's new memory into the others", () => {
    seats("a", "b");
    memory("a", "note.md", "x");
    setHistorySharing(env.home, "memory", true);
    memory("b", "../../-other/memory/fresh.md", "y");

    const run = Bun.spawnSync(["bun", join(import.meta.dir, "../src/cli.ts"), "hook", "session"], {
      stdin: Buffer.from(JSON.stringify({ hook_event_name: "Stop", cwd: join(env.home, "nowhere") })),
      env: { ...process.env, HOME: env.home, CLAUDE_CONFIG_DIR: seat("b") },
    });

    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString() + run.stderr.toString()).toBe("");
    expect(text(join(seat("a"), "projects/-other/memory/fresh.md"))).toBe("y");
    expect(isLink(join(seat("b"), "projects/-other/memory"))).toBe(true);
  });
});

describe("gitRoot", () => {
  test("is the folder with .git, the main checkout for a worktree, else undefined", () => {
    mkdirSync(join(env.home, "repo/.git"), { recursive: true });
    mkdirSync(join(env.home, "repo/a/b"), { recursive: true });
    expect(gitRoot(join(env.home, "repo/a/b"))).toBe(join(env.home, "repo"));
    // A submodule's .git file has no commondir: it is its own repository.
    mkdirSync(join(env.home, "repo/.git/modules/sub"), { recursive: true });
    env.write("repo/sub/.git", "gitdir: ../.git/modules/sub\n");
    expect(gitRoot(join(env.home, "repo/sub"))).toBe(join(env.home, "repo/sub"));
  });
});

describe("seats exclude and include for history", () => {
  test("excluding conversations gives the seat its own copy, and sync leaves it alone", () => {
    seats("personal", "work", "acme");
    transcript("personal", "s1", { type: "user", message: { content: "personal" } });
    setHistorySharing(env.home, "sessions", true, { processes: none });

    const report = excludeHistory(env.home, "claude:acme", "sessions", { processes: none });

    expect(report?.copied).toContain(join(seat("acme"), "projects"));
    expect(isLink(join(seat("acme"), "projects"))).toBe(false);
    transcript("personal", "s2", { type: "user", message: { content: "after" } });
    syncSeats(env.home, ["claude"]);
    expect(isLink(join(seat("acme"), "projects"))).toBe(false);
    expect(existsSync(join(seat("acme"), "projects/-repo/s2.jsonl"))).toBe(false);
    expect(existsSync(join(seat("work"), "projects/-repo/s2.jsonl"))).toBe(true);
    expect(excludeHistory(env.home, "claude:acme", "sessions")).toBeUndefined();
  });

  test("a seat excluded before sharing starts never has its conversations moved", () => {
    seats("personal", "acme");
    transcript("acme", "client", { type: "user", message: { content: "secret" } });
    transcript("personal", "s1", { type: "user" });
    excludeHistory(env.home, "claude:acme", "memory", { processes: none });
    expect(readConfig(env.home).ownMemory).toEqual(["claude:acme"]);

    setHistorySharing(env.home, "sessions", true, { processes: none });
    setHistorySharing(env.home, "memory", true, { processes: none });

    expect(isLink(join(seat("acme"), "projects"))).toBe(false);
    expect(existsSync(shared("projects/-repo/client.jsonl"))).toBe(false);
    expect(existsSync(join(seat("personal"), "projects/-repo/client.jsonl"))).toBe(false);
  });

  test("excluding memory while conversations are shared gives back conversations too", () => {
    seats("a", "b");
    memory("a", "note.md", "x");
    transcript("a", "s1", { type: "user" });
    setHistorySharing(env.home, "sessions", true, { processes: none });

    excludeHistory(env.home, "claude:b", "memory", { processes: none });

    expect(isLink(join(seat("b"), "projects"))).toBe(false);
    expect(isLink(join(seat("b"), "projects/-repo/memory"))).toBe(false);
    expect(text(join(seat("b"), "projects/-repo/memory/note.md"))).toBe("x");
    expect(isLink(join(seat("a"), "projects"))).toBe(true);
  });

  test("including again moves the seat's own copy aside instead of merging it", () => {
    seats("personal", "acme");
    excludeHistory(env.home, "claude:acme", "sessions");
    transcript("acme", "client", { type: "user", message: { content: "secret" } });
    transcript("personal", "s1", { type: "user" });
    setHistorySharing(env.home, "sessions", true, { processes: none });

    const report = includeHistory(env.home, "claude:acme", "sessions", { processes: none });

    expect(report.aside).toEqual([join(seat("acme"), "projects.seats-backup")]);
    expect(isLink(join(seat("acme"), "projects"))).toBe(true);
    expect(existsSync(shared("projects/-repo/client.jsonl"))).toBe(false);
    expect(existsSync(join(seat("acme"), "projects.seats-backup/-repo/client.jsonl"))).toBe(true);
    expect(readConfig(env.home).ownSessions).toBeUndefined();
    expect(() => includeHistory(env.home, "claude:acme", "sessions")).toThrow("already shares its conversations");
  });

  test("only for tools with history seats can share", () => {
    env.write(".config/seats/codex/work/auth.json", {});
    expect(() => excludeHistory(env.home, "codex:work", "sessions")).toThrow("seats doesn't share codex history");
  });
});

describe("with shared history", () => {
  function sharedSeats() {
    seats("a", "b");
    transcript("a", "s1abcdef", { type: "user", cwd: "/repo", message: { content: "hello" } });
    setHistorySharing(env.home, "sessions", true, { processes: none });
  }

  test("seats sessions lists a conversation once, with every seat that sees it", () => {
    sharedSeats();
    const sessions = listSessions([asSeat("a"), asSeat("b")]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.seats.map((item) => item.id)).toEqual(["claude:a", "claude:b"]);
  });

  test("seats move to a seat that already sees it says so, --force too", () => {
    sharedSeats();
    const sessions = listSessions([asSeat("a"), asSeat("b")]);
    for (const force of [false, true])
      expect(() => moveSession(sessions, "s1ab", asSeat("b"), { force })).toThrow(
        "claude:b already sees s1abcdef: it shares its conversations with claude:a.",
      );
  });

  test("copyTranscript doesn't copy a file onto itself, whichever path the hook reported", () => {
    sharedSeats();
    const through = join(seat("a"), "projects/-repo/s1abcdef.jsonl");
    for (const path of [through, shared("projects/-repo/s1abcdef.jsonl")]) {
      expect(copyTranscript(path, seat("a"), seat("b"))).toBe(join(seat("b"), "projects/-repo/s1abcdef.jsonl"));
    }
    expect(text(through)).toContain("hello");
  });

  test("copyTranscript still copies from a shared seat to one with its own conversations", () => {
    sharedSeats();
    seats("own");
    writeConfig(env.home, { ...readConfig(env.home), ownSessions: ["claude:own"] });
    const to = copyTranscript(shared("projects/-repo/s1abcdef.jsonl"), seat("a"), seat("own"));
    expect(to).toBe(join(seat("own"), "projects/-repo/s1abcdef.jsonl"));
    expect(isLink(join(seat("own"), "projects"))).toBe(false);
    expect(text(to!)).toContain("hello");
  });

  test("removing a seat leaves the shared conversations", async () => {
    sharedSeats();
    await removeSeat(env.home, "claude:b", { processes: none, keepLogin: true });
    expect(existsSync(seat("b"))).toBe(false);
    expect(text(shared("projects/-repo/s1abcdef.jsonl"))).toContain("hello");
    expect(text(join(seat("a"), "projects/-repo/s1abcdef.jsonl"))).toContain("hello");
  });

  test("renaming a seat keeps its links to the shared conversations and memory", () => {
    seats("a", "b");
    memory("a", "note.md", "x");
    transcript("b", "s1", { type: "user", message: { content: "b's" } });
    setHistorySharing(env.home, "memory", true);
    renameSeat(env.home, "claude:a", "renamed", { processes: none });
    expect(text(join(seat("renamed"), "projects/-repo/memory/note.md"))).toBe("x");

    setHistorySharing(env.home, "sessions", true, { processes: none });
    renameSeat(env.home, "claude:b", "other", { processes: none });
    expect(text(join(seat("other"), "projects/-repo/s1.jsonl"))).toContain("b's");
    expect(text(shared("projects/-repo/memory/note.md"))).toBe("x");
  });

  test("seats export leaves conversations and memory out", () => {
    sharedSeats();
    memory("a", "../../-repo/memory/note.md", "x");
    env.write(".config/seats/shared/claude/settings.json", "{}");
    symlinkSync("../../shared/claude/settings.json", join(seat("a"), "settings.json"));
    const files = [...planExport(env.home).files.keys()];
    expect(files).toContain("shared/claude/settings.json");
    expect(files.some((path) => /projects|file-history|memory/.test(path))).toBe(false);
  });
});
