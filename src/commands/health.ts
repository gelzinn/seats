import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { seatSourceById } from "../providers/index.ts";
import type { Seat } from "../types.ts";
import { discoverSeats } from "./list.ts";
import { fail, intro, table, truncate } from "./ui.ts";

const PROMPT = "Reply with exactly the word ok and nothing else.";
const TIMEOUT_MS = 120_000;

export type Output = { code: number; stdout: string; stderr: string; timedOut: boolean };

/** Runs a CLI with captured output, killing it after `timeoutMs`. */
export type Capture = (
  command: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
) => Promise<Output>;

export const capture: Capture = (command, args, env, timeoutMs) =>
  new Promise((resolve) => {
    // A temp cwd keeps project files (CLAUDE.md, AGENTS.md) out of the question.
    const child = spawn(command, args, {
      cwd: tmpdir(),
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: error.message, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });
  });

export type Health = {
  seat: Seat;
  status: "ok" | "unexpected" | "error";
  /** The reply, or why there isn't one. */
  reply: string;
  ms: number;
  /** Model the question went to; undefined when the tool used its own default. */
  model?: string;
};

const lastLine = (text: string) =>
  text
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) ?? "";

/** The `"message"` inside an API error dumped as JSON, else the text as is. */
const readable = (text: string) => text.match(/"message"\s*:\s*"((?:[^"\\]|\\.)+)"/)?.[1] ?? text;

/** Asks one seat a one-word question through its CLI and reports what came back. */
export async function checkSeat(seat: Seat, run: Capture = capture, timeoutMs = TIMEOUT_MS): Promise<Health> {
  const source = seatSourceById(seat.source);
  if (!source.health || !source.binary || !source.configDirEnv || !seat.dir) {
    return { seat, status: "error", reply: "can't check this tool", ms: 0 };
  }
  const { args, model } = source.health(PROMPT, seat.dir);
  const started = Date.now();
  const output = await run(source.binary, args, { [source.configDirEnv]: seat.dir }, timeoutMs);
  const ms = Date.now() - started;

  if (output.timedOut) return { seat, status: "error", reply: `no reply in ${timeoutMs / 1000}s`, ms, model };
  const reply = lastLine(output.stdout);
  if (output.code !== 0) {
    return {
      seat,
      status: "error",
      reply: readable(reply || lastLine(output.stderr)) || `exit ${output.code}`,
      ms,
      model,
    };
  }
  return { seat, status: /^ok\W*$/i.test(reply) ? "ok" : "unexpected", reply: reply || "(empty reply)", ms, model };
}

/** Seats `seats health` can check: signed-in CLI seats whose tool declares `health`, optionally filtered. */
export function checkable(seats: Seat[], filter?: string): Seat[] {
  return seats.filter(
    (seat) =>
      seat.kind === "cli" &&
      seatSourceById(seat.source).health &&
      (!filter || seat.source === filter || seat.id === filter),
  );
}

const color = { ok: pc.green, unexpected: pc.yellow, error: pc.red };

/** `seats health [tool|id]`: asks every signed-in seat to answer, in parallel, and shows a table. */
export async function healthCommand([filter]: string[]): Promise<void> {
  intro();
  const spinner = p.spinner();
  spinner.start("Discovering signed-in seats");
  const seats = checkable(await discoverSeats(undefined, "cli"), filter);
  if (seats.length === 0) {
    spinner.stop("No seats to check");
    fail(filter ? `No signed-in seat matches ${filter}.` : "No signed-in Claude or Codex seats found.");
  }

  spinner.message(`Asking ${seats.length} ${seats.length === 1 ? "seat" : "seats"} to reply`);
  const results = await Promise.all(seats.map((seat) => checkSeat(seat)));
  const healthy = results.filter((result) => result.status === "ok").length;
  spinner.stop(`${healthy} of ${results.length} ${results.length === 1 ? "seat" : "seats"} answered`);

  // Give the reply whatever width the terminal has left, so error messages stay readable.
  const widest = (header: string, values: Array<string | undefined>) =>
    Math.max(header.length, ...values.map((value) => value?.length ?? 1));
  const time = ({ ms, model }: Health) => `${(ms / 1000).toFixed(1)}s · ${model ?? "default model"}`;
  const fixed =
    widest(
      "Seat",
      seats.map((seat) => seat.id),
    ) +
    widest(
      "Account",
      seats.map((seat) => seat.email),
    ) +
    widest(
      "Plan",
      seats.map((seat) => seat.plan),
    ) +
    widest("Time", results.map(time));
  const replyWidth = Math.max(20, (process.stdout.columns || 120) - fixed - 16);
  const rows = results.map((result) => [
    result.seat.id,
    result.seat.email ? pc.green(result.seat.email) : pc.dim("—"),
    result.seat.plan ?? pc.dim("—"),
    color[result.status](truncate(result.reply, replyWidth)),
    pc.dim(time(result)),
  ]);
  console.log(table(["Seat", "Account", "Plan", "Reply", "Time"], rows));
  p.outro(healthy === results.length ? "All seats are working." : pc.yellow("Some seats need attention."));
  if (healthy !== results.length) process.exitCode = 1;
}
