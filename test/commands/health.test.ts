import { describe, expect, test } from "bun:test";
import { checkable, checkSeat, type Capture, type Output } from "../../src/commands/health.ts";
import { table } from "../../src/commands/ui.ts";
import type { Seat } from "../../src/types.ts";

const seat = (id: string, source = id.split(":")[0]!, kind: Seat["kind"] = "cli"): Seat => ({
  id,
  source,
  provider: source,
  kind,
  label: id,
  dir: `/seats/${id.replace(":", "/")}`,
  signedIn: true,
});

const reply = (output: Partial<Output>): Capture => async () => ({
  code: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  ...output,
});

describe("checkSeat", () => {
  test("runs the tool's health command against the seat folder", async () => {
    const calls: Array<{ command: string; args: string[]; env: Record<string, string> }> = [];
    const run: Capture = async (command, args, env) => {
      calls.push({ command, args, env });
      return { code: 0, stdout: "Ok.\n", stderr: "", timedOut: false };
    };

    const result = await checkSeat(seat("claude:work"), run);

    expect(result).toMatchObject({ status: "ok", model: "haiku" });
    expect(calls[0]!.command).toBe("claude");
    expect(calls[0]!.args.slice(0, 1)).toEqual(["-p"]);
    expect(calls[0]!.env).toEqual({ CLAUDE_CONFIG_DIR: "/seats/claude/work" });
  });

  test("keeps the last line, since Codex prints progress before the answer", async () => {
    const result = await checkSeat(seat("codex:work"), reply({ stdout: "thinking…\n\nok\n" }));
    expect(result).toMatchObject({ status: "ok", reply: "ok" });
  });

  test("flags a reply that isn't ok", async () => {
    const result = await checkSeat(seat("claude:work"), reply({ stdout: "Sure! Here you go: ok\n" }));
    expect(result).toMatchObject({ status: "unexpected", reply: "Sure! Here you go: ok" });
  });

  test("reports the tool's error when it fails", async () => {
    const result = await checkSeat(
      seat("claude:work"),
      reply({ code: 1, stderr: "Starting…\nUsage limit reached, resets at 5pm\n" }),
    );
    expect(result).toMatchObject({ status: "error", reply: "Usage limit reached, resets at 5pm" });
  });

  test("shows the message of an API error dumped as JSON", async () => {
    const error = 'ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The model is not supported."}}';
    const result = await checkSeat(seat("codex:work"), reply({ code: 1, stderr: `${error}\n` }));
    expect(result).toMatchObject({ status: "error", reply: "The model is not supported." });
  });

  test("reports a timeout", async () => {
    const result = await checkSeat(seat("codex:work"), reply({ code: 1, timedOut: true }), 30_000);
    expect(result).toMatchObject({ status: "error", reply: "no reply in 30s" });
  });
});

describe("checkable", () => {
  const seats = [seat("claude:work"), seat("codex:personal"), seat("gemini:default"), seat("api:openrouter", "opencode-api", "api")];

  test("keeps CLI seats whose tool can be checked", () => {
    expect(checkable(seats).map((item) => item.id)).toEqual(["claude:work", "codex:personal"]);
  });

  test("filters by tool or seat id", () => {
    expect(checkable(seats, "codex").map((item) => item.id)).toEqual(["codex:personal"]);
    expect(checkable(seats, "claude:work").map((item) => item.id)).toEqual(["claude:work"]);
  });
});

describe("table", () => {
  test("pads columns by visible width, ignoring colors", () => {
    const text = table(["Seat", "Reply"], [["claude:work", "\x1b[32mok\x1b[39m"]]).replace(/\x1b\[[0-9;]*m/g, "");
    expect(text.split("\n")).toEqual([
      "┌─────────────┬───────┐",
      "│ Seat        │ Reply │",
      "├─────────────┼───────┤",
      "│ claude:work │ ok    │",
      "└─────────────┴───────┘",
    ]);
  });
});
