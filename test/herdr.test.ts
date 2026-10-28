import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reportHerdrResume, resumableInHerdr } from "../src/herdr.ts";
import { tempHome } from "./helpers/temp-home.ts";

let env: ReturnType<typeof tempHome>;
beforeEach(() => (env = tempHome()));
afterEach(() => env.cleanup());

/**
 * A fake `herdr`: `pane get` answers with `pane.json`, `report-agent-session`
 * logs its argv, one line per call, or is refused while `refuse` exists.
 */
function fakeHerdr(): { bin: string; log: string } {
  const bin = env.write(
    "bin/herdr",
    `#!/bin/bash
case "$1 $2" in
  "pane get") cat "$FAKE_DIR/pane.json" ;;
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

/** Runs the hook as herdr would on `event` for pane `w1:p2`, and returns the reports so far. */
function hook(bin: string, log: string, event = "pane.agent_status_changed"): string[] {
  reportHerdrResume(env.home, {
    PATH: process.env.PATH,
    FAKE_DIR: env.home,
    HERDR_BIN_PATH: bin,
    HERDR_PLUGIN_EVENT: event,
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
      event: event.replace(".", "_"),
      data: { type: event.replace(".", "_"), pane_id: "w1:p2", agent_status: "working" },
    }),
    HERDR_PLUGIN_STATE_DIR: join(env.home, "state"),
  });
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

  test("the newest copy wins when several seats have it", () => {
    const { bin, log } = fakeHerdr();
    transcript("work", "s1", 1_000);
    transcript("personal", "s1", 2_000);
    pane("claude", "s1");
    expect(hook(bin, log)).toEqual([report("personal", "s1")]);
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
