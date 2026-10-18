import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
  activeSeat,
  CONTINUE_PROMPT,
  copyTranscript,
  nextAvailable,
  supervise,
  type UsageOf,
} from "../../src/commands/run.ts";
import { seatSourceById } from "../../src/providers/index.ts";
import type { Seat, Usage } from "../../src/types.ts";
import { tempHome } from "../helpers/temp-home.ts";

let env: ReturnType<typeof tempHome>;
const path = process.env.PATH;
beforeEach(() => (env = tempHome()));
afterEach(() => {
  process.env.PATH = path;
  delete process.env.FAKE_LOG;
  delete process.env.FAKE_MODE;
  delete process.env.FAKE_DIR;
  env.cleanup();
});

const seat = (slug: string): Seat => ({
  id: `claude:${slug}`,
  source: "claude",
  provider: "claude",
  kind: "cli",
  label: slug,
  dir: join(env.home, ".config/seats/claude", slug),
  signedIn: true,
});

const at = (usedPercent: number, resetsAt?: string): Usage => ({
  windows: [{ name: "five_hour", usedPercent, resetsAt: resetsAt ? new Date(resetsAt) : undefined }],
});

const usageFrom =
  (map: Record<string, Usage | undefined>): UsageOf =>
  async (item) =>
    map[item.id];

describe("nextAvailable", () => {
  test("skips seats at their limit, wraps around, and keeps seats whose usage is unknown", async () => {
    const seats = [seat("a"), seat("b"), seat("c")];
    const tried = new Set<string>();
    const next = await nextAvailable(seats, seats[1]!, tried, usageFrom({ "claude:b": at(100), "claude:c": at(100) }));
    expect(next.seat?.id).toBe("claude:a");
    expect([...tried]).toEqual(["claude:b", "claude:c"]);
  });

  test("reports the earliest reset when every seat is out", async () => {
    const seats = [seat("a"), seat("b")];
    const usage = usageFrom({
      "claude:a": at(100, "2030-01-01T18:00:00Z"),
      "claude:b": at(100, "2030-01-01T15:00:00Z"),
    });
    const next = await nextAvailable(seats, seats[0]!, new Set(), usage);
    expect(next.seat).toBeUndefined();
    expect(next.resets.map((date) => date.toISOString())).toEqual([
      "2030-01-01T15:00:00.000Z",
      "2030-01-01T18:00:00.000Z",
    ]);
  });
});

describe("activeSeat", () => {
  test("follows the live path to its seat, without asking the CLI anything", () => {
    env.write(".config/seats/claude/work/.claude.json", "{}");
    env.write(".config/seats/claude/personal/.claude.json", "{}");
    symlinkSync(".config/seats/claude/personal", join(env.home, ".claude"));
    expect(activeSeat(env.home, seatSourceById("claude"))).toMatchObject({
      id: "claude:personal",
      dir: seat("personal").dir,
    });
  });
});

describe("copyTranscript", () => {
  test("puts the session and its folder at the same place under the next seat", () => {
    const transcript = env.write(".config/seats/claude/work/projects/-repo/s1.jsonl", '{"type":"user"}\n');
    env.write(".config/seats/claude/work/projects/-repo/s1/tool-results/a.txt", "result");
    const to = copyTranscript(transcript, seat("work").dir!, seat("personal").dir!);
    expect(to).toBe(join(seat("personal").dir!, "projects/-repo/s1.jsonl"));
    expect(readFileSync(to!, "utf8")).toBe('{"type":"user"}\n');
    expect(readFileSync(join(seat("personal").dir!, "projects/-repo/s1/tool-results/a.txt"), "utf8")).toBe("result");
    expect(
      copyTranscript(env.write("elsewhere/s2.jsonl", "{}"), seat("work").dir!, seat("personal").dir!),
    ).toBeUndefined();
  });
});

describe("seats hook limit", () => {
  const cli = join(import.meta.dir, "../../src/cli.ts");
  const run = (vars: Record<string, string>) =>
    Bun.spawnSync(["bun", cli, "hook", "limit"], {
      stdin: Buffer.from('{"error":"rate_limit"}'),
      env: { ...process.env, ...vars },
    });

  test("hands the report to the supervisor, and does nothing outside a supervised session", () => {
    const marker = join(env.home, "limit.json");
    expect(run({ SEATS_LIMIT_MARKER: marker }).exitCode).toBe(0);
    expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({ error: "rate_limit" });

    const unsupervised = { ...process.env } as Record<string, string>;
    delete unsupervised.SEATS_LIMIT_MARKER;
    expect(Bun.spawnSync(["bun", cli, "hook", "limit"], { stdin: Buffer.from("{}"), env: unsupervised }).exitCode).toBe(
      0,
    );
  });
});

/**
 * A fake `claude`: logs how it was launched, then in "limit" mode on the work
 * seat reports a rate limit like the StopFailure hook would and waits to be stopped.
 */
function fakeClaude(): string {
  const log = join(env.home, "launches.log");
  const bin = join(env.home, "bin");
  const script = env.write(
    "bin/claude",
    `#!/bin/bash
echo "$(basename "$CLAUDE_CONFIG_DIR")|$*|\${SEATS_LIMIT_MARKER:+marker}" >> "$FAKE_LOG"
case "$FAKE_MODE:$(basename "$CLAUDE_CONFIG_DIR")" in
  limit:work|passing:work)
    touch "$FAKE_DIR/$FAKE_MODE-reported"
    printf '{"error":"rate_limit","session_id":"s1","transcript_path":"%s","cwd":"%s","last_assistant_message":"You have hit your limit"}' \\
      "$CLAUDE_CONFIG_DIR/projects/-repo/s1.jsonl" "$FAKE_DIR" > "$SEATS_LIMIT_MARKER"
    [ "$FAKE_MODE" = passing ] && { sleep 1.5; exit 0; }
    sleep 30 ;;
esac
exit 0
`,
  );
  chmodSync(script, 0o755);
  process.env.PATH = `${bin}:${path}`;
  process.env.FAKE_LOG = log;
  // Never $HOME: the test HOME is a folder, not the process's HOME.
  process.env.FAKE_DIR = env.home;
  return log;
}

const launches = (log: string) => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);

describe("supervise", () => {
  const claude = seatSourceById("claude");

  test("moves a session that hits its limit to the next seat, with the conversation", async () => {
    const log = fakeClaude();
    process.env.FAKE_MODE = "limit";
    env.write(".config/seats/claude/work/projects/-repo/s1.jsonl", '{"type":"user"}\n');
    const seats = [seat("work"), seat("personal")];
    // The work seat reads as limited once it has reported the limit.
    const usageOf: UsageOf = async (item) =>
      item.id === "claude:work" && existsSync(join(env.home, "limit-reported")) ? at(100) : at(20);

    const code = await supervise({
      home: env.home,
      source: claude,
      seats,
      start: seats[0]!,
      args: [],
      autoSwitch: true,
      usageOf,
    });

    expect(code).toBe(0);
    const [first, second] = launches(log).map((line) => line.split("|"));
    expect(first![0]).toBe("work");
    expect(first![1]).toStartWith("--settings ");
    expect(first![2]).toBe("marker");
    expect(second![0]).toBe("personal");
    expect(second![1]).toEndWith(`--resume s1 ${CONTINUE_PROMPT}`);
    expect(readFileSync(join(seat("personal").dir!, "projects/-repo/s1.jsonl"), "utf8")).toBe('{"type":"user"}\n');
  });

  test("leaves the session alone on a passing 429", async () => {
    const log = fakeClaude();
    process.env.FAKE_MODE = "passing";
    const seats = [seat("work"), seat("personal")];
    // The 429 came with a limit message, but usage says the seat still has room.
    const usageOf: UsageOf = async () => at(20);
    const code = await supervise({
      home: env.home,
      source: claude,
      seats,
      start: seats[0]!,
      args: [],
      autoSwitch: true,
      usageOf,
    });
    expect(code).toBe(0);
    expect(launches(log)).toHaveLength(1);
    expect(existsSync(join(env.home, "passing-reported"))).toBe(true);
  });

  test("skips a seat already at its limit, and stops when every seat is", async () => {
    const log = fakeClaude();
    const seats = [seat("work"), seat("personal")];
    const workOut = usageFrom({ "claude:work": at(100) });
    expect(
      await supervise({
        home: env.home,
        source: claude,
        seats,
        start: seats[0]!,
        args: ["-c"],
        autoSwitch: true,
        usageOf: workOut,
      }),
    ).toBe(0);
    expect(launches(log).map((line) => line.split("|")[0])).toEqual(["personal"]);

    const allOut = usageFrom({ "claude:work": at(100), "claude:personal": at(100) });
    expect(
      await supervise({
        home: env.home,
        source: claude,
        seats,
        start: seats[0]!,
        args: [],
        autoSwitch: true,
        usageOf: allOut,
      }),
    ).toBe(1);
    expect(launches(log)).toHaveLength(1);
  });

  test("with auto-switch off, just runs the seat, with no hook and no usage checks", async () => {
    const log = fakeClaude();
    const seats = [seat("work"), seat("personal")];
    let checked = false;
    const usageOf: UsageOf = async () => {
      checked = true;
      return at(100);
    };
    expect(
      await supervise({
        home: env.home,
        source: claude,
        seats,
        start: seats[0]!,
        args: ["-c"],
        autoSwitch: false,
        usageOf,
      }),
    ).toBe(0);
    expect(launches(log)).toEqual(["work|-c|"]);
    expect(checked).toBe(false);
  });
});
