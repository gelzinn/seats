import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { reportHerdrResume, resumableInHerdr } from "../src/herdr.ts";
import type { RunningProcess } from "../src/processes.ts";
import { tempHome } from "./helpers/temp-home.ts";

let env: ReturnType<typeof tempHome>;
beforeEach(() => (env = tempHome()));
afterEach(() => env.cleanup());

/**
 * A fake `herdr`: `pane get` answers with `pane.json`, `pane process-info`
 * with `process.json` (fails without it) and counts in `asked.log`, `report-agent-session` logs its
 * argv, one line per call, or is refused while `refuse` exists.
 */
function fakeHerdr(): { bin: string; log: string } {
  const bin = env.write(
    "bin/herdr",
    `#!/bin/bash
case "$1 $2" in
  "pane get") cat "$FAKE_DIR/pane.json" ;;
  "pane process-info") echo >> "$FAKE_DIR/asked.log"; cat "$FAKE_DIR/process.json" 2>/dev/null || exit 1 ;;
  "pane report-agent-session")
    if [ -e "$FAKE_DIR/refuse" ]; then echo '{"error":{"code":"resume_not_accepted"}}' >&2; exit 1; fi
    echo "$*" >> "$FAKE_DIR/reports.log" ;;
  *) exit 2 ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  return { bin, log: join(env.home, "reports.log") };
}

function pane(agent: string | undefined, session?: string): void {
  const info = {
    pane_id: "w1:p2",
    agent,
    agent_status: "working",
    agent_session: session && { source: "herdr:claude", agent: "claude", kind: "id", value: session },
  };
  env.write("pane.json", { id: "cli:pane:get", result: { type: "pane_info", pane: info } });
}

function transcript(slug: string, id: string, mtime: number): void {
  const file = env.write(`.config/seats/claude/${slug}/projects/-repo/${id}.jsonl`, '{"type":"user"}\n');
  utimesSync(file, mtime, mtime);
}

/** What `pane process-info` says runs in the pane: `[pid, argv]` pairs. */
function foreground(...processes: [number, string[]][]): void {
  const list = processes.map(([pid, argv]) => ({ pid, name: argv[0], argv, cmdline: argv.join(" "), cwd: "/repo" }));
  const info = { pane_id: "w1:p2", foreground_processes: list };
  env.write("process.json", { id: "cli:pane:process-info", result: { type: "pane_process_info", process_info: info } });
}

/** The processes the hook can read the env of, by pid. */
let running: RunningProcess[] = [];
beforeEach(() => (running = []));
const seatDir = (slug: string) => join(env.home, ".config/seats/claude", slug);
/** How many times the hook asked herdr which processes run in the pane. */
const asked = () => {
  const file = join(env.home, "asked.log");
  return existsSync(file) ? readFileSync(file, "utf8").length : 0;
};

/** Runs the hook as herdr would on `event` for pane `w1:p2`, and returns the reports so far. */
function hook(bin: string, log: string, event = "pane.agent_status_changed"): string[] {
  const processes = (pids: number[]) => running.filter((item) => pids.includes(item.pid));
  reportHerdrResume(
    env.home,
    {
      PATH: process.env.PATH,
      FAKE_DIR: env.home,
      HERDR_BIN_PATH: bin,
      HERDR_PLUGIN_EVENT: event,
      HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
        event: event.replace(".", "_"),
        data: { type: event.replace(".", "_"), pane_id: "w1:p2", agent_status: "working" },
      }),
      HERDR_PLUGIN_STATE_DIR: join(env.home, "state"),
    },
    processes,
  );
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
}

const report = (slug: string, id: string) =>
  expect.stringMatching(
    new RegExp(
      `^pane report-agent-session w1:p2 --source seats --agent claude --seq \\d+ -- seats run claude:${slug} --resume ${id}$`,
    ),
  );

describe("seats hook herdr", () => {
  test("reports the seat that has the conversation", () => {
    const { bin, log } = fakeHerdr();
    transcript("work", "s1", 1_000);
    env.write(".config/seats/claude/personal/.claude.json", "{}");
    pane("claude", "s1");
    expect(hook(bin, log)).toEqual([report("work", "s1")]);
  });

  test("reports the Codex seat that has the rollout, with codex resume", () => {
    const { bin, log } = fakeHerdr();
    const older = env.write(
      ".config/seats/codex/work/sessions/2026/10/15/rollout-2026-10-15T19-25-01-c1.jsonl",
      "{}\n",
    );
    const newer = env.write(".config/seats/codex/home/archived_sessions/rollout-2026-10-15T19-25-01-c1.jsonl", "{}\n");
    utimesSync(older, 1_000, 1_000);
    utimesSync(newer, 2_000, 2_000);
    pane("codex", "c1");
    expect(hook(bin, log)).toEqual([
      expect.stringMatching(
        /^pane report-agent-session w1:p2 --source seats --agent codex --seq \d+ -- seats run codex:home resume c1$/,
      ),
    ]);
  });

  test("the newest copy wins when several seats have it", () => {
    const { bin, log } = fakeHerdr();
    transcript("work", "s1", 1_000);
    transcript("personal", "s1", 2_000);
    pane("claude", "s1");
    expect(hook(bin, log)).toEqual([report("personal", "s1")]);
  });

  test("with shared conversations, every seat has it: the seat the pane's claude runs on wins", () => {
    const { bin, log } = fakeHerdr();
    env.write(".config/seats/shared/claude/projects/-repo/s1.jsonl", '{"type":"user"}\n');
    for (const slug of ["personal", "work"]) {
      mkdirSync(seatDir(slug), { recursive: true });
      symlinkSync(join(env.home, ".config/seats/shared/claude/projects"), join(seatDir(slug), "projects"));
    }
    pane("claude", "s1");
    foreground([7, ["claude", "--resume", "s1"]]);
    running = [{ pid: 7, argv: ["claude"], env: { CLAUDE_CONFIG_DIR: seatDir("work") } }];
    expect(hook(bin, log)).toEqual([report("work", "s1")]);
    expect(asked()).toBe(1);
    // An auto-switch: a new claude on another seat, which herdr detects.
    foreground([8, ["claude", "--resume", "s1"]]);
    running = [{ pid: 8, argv: ["claude"], env: { CLAUDE_CONFIG_DIR: seatDir("personal") } }];
    expect(hook(bin, log, "pane.agent_detected")).toEqual([report("work", "s1"), report("personal", "s1")]);
    expect(asked()).toBe(2);
  });

  test("status changes keep to one pane get: the seat found on detection is reused", () => {
    const { bin, log } = fakeHerdr();
    transcript("work", "s1", 1_000);
    transcript("personal", "s1", 2_000);
    transcript("work", "s2", 1_000);
    transcript("personal", "s2", 2_000);
    pane("claude", "s1");
    foreground([7, ["claude"]]);
    running = [{ pid: 7, argv: ["claude"], env: { CLAUDE_CONFIG_DIR: seatDir("work") } }];
    expect(hook(bin, log, "pane.agent_detected")).toEqual([report("work", "s1")]);
    // The search once more after a detection, then settled: neither asks herdr again.
    expect(hook(bin, log)).toHaveLength(1);
    expect(hook(bin, log)).toHaveLength(1);
    // A new conversation in the same claude (/clear): same seat, still not asked.
    pane("claude", "s2");
    expect(hook(bin, log)).toEqual([report("work", "s1"), report("work", "s2")]);
    expect(asked()).toBe(1);
    expect(JSON.parse(readFileSync(join(env.home, "state/reported.json"), "utf8"))["w1:p2"]).toEqual({
      session: "claude:s2",
      command: "seats run claude:work --resume s2",
      seat: "claude:work",
    });
  });

  test("after an auto-switch, the seat of the claude child wins over the one seats run started on", () => {
    const { bin, log } = fakeHerdr();
    transcript("work", "s1", 2_000);
    transcript("personal", "s1", 2_000);
    pane("claude", "s1");
    foreground([6, ["seats", "run", "claude:work", "--resume", "s1"]], [7, ["claude", "--resume", "s1"]]);
    running = [{ pid: 7, argv: ["claude"], env: { CLAUDE_CONFIG_DIR: seatDir("personal") } }];
    expect(hook(bin, log, "pane.agent_detected")).toEqual([report("personal", "s1")]);
    // The child's env can't be read: the seat seats run started on.
    running = [];
    expect(hook(bin, log, "pane.agent_detected")).toEqual([report("personal", "s1"), report("work", "s1")]);
  });

  test("a claude without a config dir runs on the active seat", () => {
    const { bin, log } = fakeHerdr();
    transcript("work", "s1", 1_000);
    transcript("personal", "s1", 2_000);
    symlinkSync(".config/seats/claude/work", join(env.home, ".claude"));
    pane("claude", "s1");
    foreground([7, ["claude"]]);
    running = [{ pid: 7, argv: ["claude"], env: {} }];
    expect(hook(bin, log)).toEqual([report("work", "s1")]);
  });

  test("falls back to the newest copy when process-info fails or the pane's seat lacks the session", () => {
    const { bin, log } = fakeHerdr();
    transcript("work", "s1", 1_000);
    transcript("personal", "s1", 2_000);
    env.write(".config/seats/claude/other/.claude.json", "{}");
    pane("claude", "s1");
    expect(hook(bin, log)).toEqual([report("personal", "s1")]);
    foreground([7, ["claude"]]);
    running = [{ pid: 7, argv: ["claude"], env: { CLAUDE_CONFIG_DIR: seatDir("other") } }];
    expect(hook(bin, log, "pane.agent_detected")).toEqual([report("personal", "s1"), report("personal", "s1")]);
  });

  test("reports nothing for another agent, a pane without a session, or a session no seat has", () => {
    const { bin, log } = fakeHerdr();
    transcript("work", "s1", 1_000);
    pane("codex", "s1");
    expect(hook(bin, log)).toEqual([]);
    pane("claude");
    expect(hook(bin, log)).toEqual([]);
    pane(undefined);
    expect(hook(bin, log)).toEqual([]);
    pane("claude", "other");
    expect(hook(bin, log)).toEqual([]);
    pane("claude", "../s1");
    expect(hook(bin, log)).toEqual([]);
  });

  test("doesn't report the same command twice, unless claude is detected in the pane again", () => {
    const { bin, log } = fakeHerdr();
    transcript("work", "s1", 1_000);
    pane("claude", "s1");
    hook(bin, log);
    expect(hook(bin, log)).toHaveLength(1);
    expect(hook(bin, log, "pane.agent_detected")).toHaveLength(2);

    transcript("personal", "s1", 2_000);
    expect(hook(bin, log)).toEqual([report("work", "s1"), report("work", "s1"), report("personal", "s1")]);
  });

  test("searches the seats again only when the pane's session changes", () => {
    const { bin, log } = fakeHerdr();
    transcript("work", "s1", 1_000);
    transcript("personal", "s2", 1_000);
    pane("claude", "s1");
    hook(bin, log);
    // A status change on the same session doesn't look: a newer copy elsewhere goes unseen.
    rmSync(join(env.home, ".config/seats/claude/work"), { recursive: true });
    expect(hook(bin, log)).toEqual([report("work", "s1")]);
    pane("claude", "s2");
    expect(hook(bin, log)).toEqual([report("work", "s1"), report("personal", "s2")]);
    const state = JSON.parse(readFileSync(join(env.home, "state/reported.json"), "utf8"));
    expect(state["w1:p2"]).toEqual({ session: "claude:s2", command: "seats run claude:personal --resume s2" });
  });

  test("after a detection, the next status change searches once more", () => {
    const { bin, log } = fakeHerdr();
    transcript("work", "s1", 1_000);
    pane("claude", "s1");
    hook(bin, log);
    // An auto-switch: the old claude exits and the new one starts before the copy has a newer mtime.
    expect(hook(bin, log, "pane.agent_detected")).toEqual([report("work", "s1"), report("work", "s1")]);
    transcript("personal", "s1", 2_000);
    expect(hook(bin, log)).toEqual([report("work", "s1"), report("work", "s1"), report("personal", "s1")]);
    rmSync(join(env.home, ".config/seats/claude/personal"), { recursive: true });
    expect(hook(bin, log)).toHaveLength(3);
  });

  test("reads the state older versions saved, a command per pane", () => {
    const { bin, log } = fakeHerdr();
    transcript("work", "s1", 1_000);
    pane("claude", "s1");
    env.write("state/reported.json", { "w1:p2": "seats run claude:work --resume s1" });
    expect(hook(bin, log)).toEqual([]);
    expect(JSON.parse(readFileSync(join(env.home, "state/reported.json"), "utf8"))["w1:p2"]).toEqual({
      session: "claude:s1",
      command: "seats run claude:work --resume s1",
    });
    env.write("state/reported.json", { "w1:p2": "seats run claude:old --resume s1" });
    expect(hook(bin, log)).toEqual([report("work", "s1")]);
  });

  test("swallows resume_not_accepted, and tries again on the next event", () => {
    const { bin, log } = fakeHerdr();
    transcript("work", "s1", 1_000);
    pane("claude", "s1");
    writeFileSync(join(env.home, "refuse"), "");
    expect(hook(bin, log)).toEqual([]);
    rmSync(join(env.home, "refuse"));
    expect(hook(bin, log)).toEqual([report("work", "s1")]);
  });

  test("the command is silent and exits 0, whatever herdr says", () => {
    const { bin } = fakeHerdr();
    const cli = join(import.meta.dir, "../src/cli.ts");
    const run = Bun.spawnSync(["bun", cli, "hook", "herdr"], {
      env: { ...process.env, HOME: env.home, FAKE_DIR: env.home, HERDR_BIN_PATH: bin, HERDR_PLUGIN_EVENT_JSON: "nope" },
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toBe("");
    expect(run.stderr.toString()).toBe("");
  });
});

describe("resumableInHerdr", () => {
  test("follows herdr's rules for resume commands", () => {
    expect(resumableInHerdr(["seats", "run", "claude:work", "--resume", "s1"])).toBe(true);
    expect(resumableInHerdr(["/usr/bin/seats", "run"])).toBe(false);
    expect(resumableInHerdr(["seats", "run", "claude:o'brien"])).toBe(false);
    expect(resumableInHerdr(["seats", "run", "claude:a\nb"])).toBe(false);
    expect(resumableInHerdr(["seats", ...Array(64).fill("x")])).toBe(false);
    expect(resumableInHerdr(["seats", "x".repeat(8192)])).toBe(false);
  });
});
