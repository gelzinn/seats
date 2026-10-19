import { type ChildProcess, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import pc from "picocolors";
import { isInside } from "../fs.ts";
import { discoverSeatDirs, type SeatDir } from "../home-dirs.ts";
import { listSeatDirs } from "../lib.ts";
import { findPin, type Pin } from "../pins.ts";
import { seatSources } from "../providers/index.ts";
import { readConfig, seatsHome, writeConfig } from "../store.ts";
import type { Seat, SeatSource, Usage } from "../types.ts";
import { fail, tilde } from "./ui.ts";

/** Sent after a mid-session switch, unless `seats auto-switch on --no-continue`. */
export const CONTINUE_PROMPT = "Continue where you left off.";
const POLL_MS = 500;

/** What the CLI's limit hook reported: Claude Code's `StopFailure` payload. */
export type LimitReport = {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  error?: string;
  last_assistant_message?: string;
};

export type UsageOf = (seat: Seat) => Promise<Usage | undefined>;

const isLimited = (usage: Usage) => usage.windows.some((window) => window.usedPercent >= 100);

/** When the seat's full windows reset, the earliest first. */
const resets = (usage: Usage | undefined) =>
  (usage?.windows ?? [])
    .filter((window) => window.usedPercent >= 100 && window.resetsAt)
    .map((window) => window.resetsAt!);

const say = (message: string) => console.error(`${pc.cyan("seats")} ${message}`);
/** A reset as weekday and time, e.g. "Mon 14:00". */
export const time = (date: Date) =>
  date.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });

/**
 * The first seat from `from` on (wrapping around) that hasn't been tried and
 * isn't at a limit. A seat whose usage can't be read is still a candidate.
 */
export async function nextAvailable(
  seats: Seat[],
  from: Seat,
  tried: Set<string>,
  usageOf: UsageOf,
): Promise<{ seat?: Seat; resets: Date[] }> {
  const start = Math.max(
    0,
    seats.findIndex((seat) => seat.id === from.id),
  );
  const seen: Date[] = [];
  for (let step = 0; step < seats.length; step++) {
    const seat = seats[(start + step) % seats.length]!;
    if (tried.has(seat.id)) continue;
    const usage = await usageOf(seat);
    if (usage && isLimited(usage)) {
      tried.add(seat.id);
      seen.push(...resets(usage));
      continue;
    }
    return { seat, resets: seen };
  }
  return { resets: seen.sort((a, b) => +a - +b) };
}

/** A real path, or the path itself when it doesn't exist. */
const real = (path: string) => (existsSync(path) ? realpathSync(path) : path);

/**
 * Copies a session from one seat to another so the next seat can resume it:
 * `<id>.jsonl` and its `<id>/` folder, at the same place under the new seat.
 */
export function copyTranscript(transcript: string, fromDir: string, toDir: string): string | undefined {
  const from = real(transcript);
  const seatDir = real(fromDir);
  if (!existsSync(from) || !isInside(from, seatDir)) return undefined;
  const to = join(toDir, relative(seatDir, from));
  mkdirSync(dirname(to), { recursive: true });
  // Keeping mtimes keeps the conversation where it was in the list of recent ones.
  cpSync(from, to, { preserveTimestamps: true });
  const folder = from.replace(/\.jsonl$/, "");
  if (folder !== from && existsSync(folder))
    cpSync(folder, to.replace(/\.jsonl$/, ""), { recursive: true, preserveTimestamps: true });
  return to;
}

/** The shell command a CLI hook runs to reach `seats hook limit`, in this same install. */
function hookShellCommand(): string {
  const quote = (part: string) => `'${part.replace(/'/g, `'\\''`)}'`;
  const exe = process.execPath;
  const self = /^bun(\.exe)?$/.test(basename(exe)) ? [exe, resolve(process.argv[1]!)] : [exe];
  return [...self, "hook", "limit"].map(quote).join(" ");
}

function readReport(marker: string): LimitReport | undefined {
  try {
    return JSON.parse(readFileSync(marker, "utf8")) as LimitReport;
  } catch {
    return undefined;
  }
}

type Ended = { code: number } | { limit: LimitReport };

/**
 * Waits for the CLI to exit. When its hook reports a rate limit and the seat
 * really is out (usage at 100%, or unreadable usage and a limit message), the
 * CLI is stopped so the session can move on. A passing 429 is ignored.
 */
function watch(child: ChildProcess, marker: string, seat: Seat, usageOf: UsageOf): Promise<Ended> {
  return new Promise((resolveEnded) => {
    let limit: LimitReport | undefined;
    let checking = false;
    const timer = setInterval(async () => {
      if (checking || limit || !existsSync(marker)) return;
      checking = true;
      const report = readReport(marker);
      rmSync(marker, { force: true });
      if (report?.error === "rate_limit") {
        const usage = await usageOf(seat);
        const out = usage ? isLimited(usage) : /\blimit\b/i.test(report.last_assistant_message ?? "");
        if (out) {
          limit = report;
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
        }
      }
      checking = false;
    }, POLL_MS);
    child.on("exit", (code) => {
      clearInterval(timer);
      // A CLI stopped mid-screen may leave the cursor hidden.
      if (limit) process.stdout.write("\x1b[?25h\n");
      resolveEnded(limit ? { limit } : { code: code ?? 1 });
    });
    child.on("error", (error) => {
      clearInterval(timer);
      say(pc.red(`couldn't start ${seat.source}: ${error.message}`));
      resolveEnded({ code: 127 });
    });
  });
}

export type SuperviseOptions = {
  home: string;
  source: SeatSource;
  /**
   * Signed-in seats of `source`, in the order to try them. A function is only
   * called when a switch is needed, so launching stays fast.
   */
  seats: Seat[] | (() => Promise<Seat[]>);
  start: Seat;
  args: string[];
  /** Off: just run `start`. On: skip seats at their limit and move on mid-session. */
  autoSwitch: boolean;
  autoContinue?: boolean;
  usageOf?: UsageOf;
  /** Folder to launch in, e.g. where a resumed session ran. Defaults to the current one. */
  cwd?: string;
};

/**
 * Runs the seat's CLI in this terminal and returns its exit code. With
 * auto-switch on, a seat already at its limit is skipped, and a supervised
 * session that hits it mid-way reopens on the next seat with the
 * conversation. The global active seat (`~/.claude` etc.) never changes here.
 */
export async function supervise(options: SuperviseOptions): Promise<number> {
  const { home, source, autoSwitch } = options;
  let listed: Seat[] | undefined;
  const seats = async () => (listed ??= Array.isArray(options.seats) ? options.seats : await options.seats());
  const usageOf: UsageOf = options.usageOf ?? (async (seat) => (seat.dir ? source.usage?.(seat.dir) : undefined));
  const { binary, configDirEnv, failover } = source;
  if (!binary || !configDirEnv) throw new Error(`seats can't launch ${source.label}.`);

  const tried = new Set<string>();
  let seat = options.start;
  const startUsage = autoSwitch ? await usageOf(seat) : undefined;
  if (startUsage && isLimited(startUsage)) {
    tried.add(seat.id);
    const next = await nextAvailable(await seats(), seat, tried, usageOf);
    if (!next.seat) return allOut(await seats(), [...resets(startUsage), ...next.resets]);
    say(`${seat.id} is at its usage limit. Using ${pc.bold(next.seat.id)}.`);
    seat = next.seat;
  }

  mkdirSync(seatsHome(home), { recursive: true, mode: 0o700 });
  const state = mkdtempSync(join(seatsHome(home), ".run-"));
  const marker = join(state, "limit.json");
  const supervised = autoSwitch && failover !== undefined;
  const settings = join(state, "hooks.json");
  if (supervised) writeFileSync(settings, JSON.stringify(failover.hookSettings(hookShellCommand())));

  // Ctrl+C belongs to the CLI; seats stays to clean up after it.
  const ignore = () => {};
  process.on("SIGINT", ignore);
  try {
    let args = options.args;
    let cwd = options.cwd ?? process.cwd();
    for (;;) {
      const child = spawn(binary, [...(supervised ? failover.settingsArgs(settings) : []), ...args], {
        stdio: "inherit",
        cwd,
        env: { ...process.env, [configDirEnv]: seat.dir!, ...(supervised ? { SEATS_LIMIT_MARKER: marker } : {}) },
      });
      const ended = await watch(child, marker, seat, usageOf);
      if ("code" in ended) return ended.code;

      tried.add(seat.id);
      const next = await nextAvailable(await seats(), seat, tried, usageOf);
      if (!next.seat) return allOut(await seats(), next.resets);
      const { session_id: session, transcript_path: transcript } = ended.limit;
      if (!session || !transcript || !copyTranscript(transcript, seat.dir!, next.seat.dir!)) {
        say(
          pc.yellow(
            `${seat.id} hit its usage limit, but its session couldn't be moved. Starting fresh on ${next.seat.id}.`,
          ),
        );
        args = [];
      } else {
        say(`${seat.id} hit its usage limit. Continuing on ${pc.bold(next.seat.id)}…`);
        args = failover!.resumeArgs(session, options.autoContinue === false ? undefined : CONTINUE_PROMPT);
      }
      cwd = ended.limit.cwd && existsSync(ended.limit.cwd) ? ended.limit.cwd : cwd;
      seat = next.seat;
    }
  } finally {
    process.off("SIGINT", ignore);
    rmSync(state, { recursive: true, force: true });
  }
}

function allOut(seats: Seat[], resetTimes: Date[]): number {
  const first = [...resetTimes].sort((a, b) => +a - +b)[0];
  const when = first ? ` The first one resets ${time(first)}.` : "";
  say(pc.yellow(`All ${seats.length} ${seats.length === 1 ? "seat is" : "seats are"} at their usage limit.${when}`));
  return 1;
}

const cliSeat = (source: SeatSource, found: SeatDir): Seat => ({
  id: `${source.id}:${found.slug}`,
  source: source.id,
  provider: source.id,
  kind: "cli",
  label: found.label,
  dir: found.dir,
  signedIn: true,
});

/**
 * The seat a CLI's live path points at (else its first seat), found from the
 * folders alone: no CLI is asked whether it's signed in, so this is instant.
 */
export function activeSeat(home: string, source: SeatSource): Seat | undefined {
  const live = source.livePath?.(home);
  if (!live) return undefined;
  const dirs = discoverSeatDirs(home, source.id, basename(live));
  const found = dirs.find((item) => real(item.dir) === real(live)) ?? dirs[0];
  return found && cliSeat(source, found);
}

/**
 * The seat `seats run` starts in `cwd`: the one a `.seats` file pins, else the
 * active one. A pin to a seat that doesn't exist throws rather than falling
 * back, so a project never runs on the wrong account.
 */
export function seatToRun(home: string, source: SeatSource, cwd = process.cwd()): { seat?: Seat; pin?: Pin } {
  const pin = findPin(source.id, cwd);
  if (!pin) return { seat: activeSeat(home, source) };
  const found = listSeatDirs(source.id, home).find((item) => item.slug === pin.slug);
  if (!found)
    throw new Error(
      `${tilde(pin.file)} pins ${source.id}:${pin.slug}, but there's no such seat. See seats list ${source.id}.`,
    );
  return { seat: cliSeat(source, found), pin };
}

/**
 * `seats run <tool> [args…]`: the seat pinned in this project, else the active
 * seat of `tool`, supervised when auto-switch is on.
 */
export async function runCommand([tool, ...args]: string[]): Promise<void> {
  const runnable = seatSources.filter((source) => source.kind === "cli" && source.binary && source.configDirEnv);
  const names = runnable.map((source) => source.id).join(", ");
  if (!tool) fail(`Name the tool to run: ${names}.`);
  const source = runnable.find((item) => item.id === tool) ?? fail(`seats can't run "${tool}". Try one of: ${names}.`);
  const home = homedir();
  let picked: ReturnType<typeof seatToRun>;
  try {
    picked = seatToRun(home, source);
  } catch (error) {
    fail((error as Error).message);
  }
  const { seat, pin } = picked;
  if (!seat) fail(`No ${source.label} seat. Add one with seats add ${source.id}.`);
  if (pin) console.error(pc.dim(`seats ${seat.id} (from ${tilde(pin.file)})`));
  const config = readConfig(home);
  process.exitCode = await supervise({
    home,
    source,
    // Asking every seat whether it's signed in is slow; only needed to switch.
    seats: () => source.discover(home),
    start: seat,
    args,
    autoSwitch: config.autoSwitch === true,
    autoContinue: config.autoContinue,
  });
}

/** `seats auto-switch [on|off|status] [--no-continue]` */
export async function autoSwitchCommand(argv: string[]): Promise<void> {
  const home = homedir();
  const [mode = "status"] = argv.filter((arg) => !arg.startsWith("--"));
  const config = readConfig(home);
  if (mode === "on") {
    writeConfig(home, { ...config, autoSwitch: true, autoContinue: !argv.includes("--no-continue") });
  } else if (mode === "off") {
    writeConfig(home, { ...config, autoSwitch: false });
  } else if (mode !== "status") {
    fail("Use seats auto-switch on, off or status.");
  }
  const now = readConfig(home);
  if (!now.autoSwitch) {
    console.log("Auto-switch is off. Turn it on with seats auto-switch on.");
    return;
  }
  console.log(`Auto-switch is on.

When you launch a tool through seats (seats, or seats run <tool>):
  - a seat already at its usage limit is skipped for the next one of that tool (Claude Code, Codex);
  - if a Claude Code session hits the limit mid-way, seats closes it, copies the
    conversation to the next seat and reopens it there with --resume${
      now.autoContinue === false
        ? ""
        : `,
    sending "${CONTINUE_PROMPT}" so the work goes on by itself (turn that off with
    seats auto-switch on --no-continue)`
    }.

Your active seat (~/.claude and friends) stays as it was; only that session moves.
To get this for plain \`claude\`, add to your shell config: alias claude='seats run claude'`);
}

/**
 * `seats hook limit`: run by the CLI's own hook. Hands the report to the
 * supervising seats process; outside a supervised session it does nothing.
 */
export async function hookCommand(argv: string[]): Promise<void> {
  const marker = process.env.SEATS_LIMIT_MARKER;
  if (argv[0] !== "limit" || !marker) return;
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  // Write then rename, so the supervisor never reads half a report.
  writeFileSync(`${marker}.tmp`, input || "{}");
  renameSync(`${marker}.tmp`, marker);
}
