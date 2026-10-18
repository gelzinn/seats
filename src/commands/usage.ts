import * as p from "@clack/prompts";
import pc from "picocolors";
import { seatSourceById } from "../providers/index.ts";
import type { Seat, Usage, UsageError, UsageReading, UsageWindow } from "../types.ts";
import { discoverSeats, matchesFilter } from "./list.ts";
import { time } from "./run.ts";
import { fail, intro, table } from "./ui.ts";

/** Reads one seat's usage. Tests pass a stub so nothing reaches the network. */
export type ReadUsage = (seat: Seat) => Promise<UsageReading>;

export type SeatUsage = { seat: Seat; usage?: Usage; error?: UsageError };

const REASONS: Record<UsageError, string> = {
  "no-token": "no token",
  expired: "token expired: open the seat once so its CLI refreshes the token",
  failed: "request failed",
};

/** Asks the seat's source, preferring `readUsage`, which says why it failed. */
export const readUsage: ReadUsage = async (seat) => {
  const source = seatSourceById(seat.source);
  if (!seat.dir) return { error: "no-token" };
  if (source.readUsage) return source.readUsage(seat.dir);
  const usage = await source.usage?.(seat.dir);
  return usage ? { usage } : { error: "failed" };
};

/** Seats `seats usage` can read: signed-in seats whose tool reports usage, optionally filtered. */
export function readable(seats: Seat[], filter?: string): Seat[] {
  return seats.filter((seat) => {
    const source = seatSourceById(seat.source);
    return seat.signedIn && (source.readUsage || source.usage) && matchesFilter(seat, filter);
  });
}

/** Reads every seat in parallel. */
export async function readAll(seats: Seat[], read: ReadUsage = readUsage): Promise<SeatUsage[]> {
  return Promise.all(seats.map(async (seat) => ({ seat, ...(await read(seat)) })));
}

const label = (window: UsageWindow) => window.label ?? window.name;

/** "in 12m", "in 1h05", or the weekday and time once the reset is more than a day away. */
export function resetsIn(resetsAt: Date, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((+resetsAt - now) / 60_000));
  if (minutes >= 24 * 60) return time(resetsAt);
  if (minutes < 60) return `in ${minutes}m`;
  return `in ${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
}

/** `82% · resets in 1h12`, yellow from 80% and red at the limit. */
export function windowCell(window: UsageWindow, now = Date.now()): string {
  const text = `${Math.round(window.usedPercent)}%${window.resetsAt ? ` · resets ${resetsIn(window.resetsAt, now)}` : ""}`;
  if (window.usedPercent >= 100) return pc.red(text);
  if (window.usedPercent >= 80) return pc.yellow(text);
  return text;
}

/** One column per window label, 5h and Week first, then per-model windows as they come. */
export function windowLabels(results: SeatUsage[]): string[] {
  const labels = [...new Set(results.flatMap((result) => result.usage?.windows.map(label) ?? []))];
  const rank = (name: string) => {
    const at = ["5h", "Week"].indexOf(name);
    return at === -1 ? 2 : at;
  };
  return labels.sort((a, b) => rank(a) - rank(b));
}

/** The usage table. Seats that couldn't be read get a row with the reason. */
export function usageTable(results: SeatUsage[], now = Date.now()): string {
  const labels = windowLabels(results);
  const failed = results.some((result) => result.error);
  const headers = ["Seat", "Account", "Plan", ...labels, ...(failed ? ["Note"] : [])];
  const rows = results.map(({ seat, usage, error }) => {
    const cells = labels.map((name) => {
      const window = usage?.windows.find((item) => label(item) === name);
      return window ? windowCell(window, now) : pc.dim("—");
    });
    const note = error ? [(error === "expired" ? pc.yellow : pc.red)(REASONS[error])] : failed ? [""] : [];
    return [seat.id, seat.email ? pc.green(seat.email) : pc.dim("—"), seat.plan ?? pc.dim("—"), ...cells, ...note];
  });
  return table(headers, rows);
}

/** What `--json` prints: one entry per seat, with dates as ISO strings. */
export function usageJson(results: SeatUsage[]): unknown[] {
  return results.map(({ seat, usage, error }) => ({
    id: seat.id,
    email: seat.email ?? null,
    plan: seat.plan ?? null,
    windows: (usage?.windows ?? []).map((window) => ({
      name: window.name,
      label: label(window),
      usedPercent: window.usedPercent,
      resetsAt: window.resetsAt?.toISOString() ?? null,
    })),
    ...(error ? { error: REASONS[error] } : {}),
  }));
}

/**
 * `seats usage [tool|id] [--json]`: every seat's current usage, read from the
 * endpoints the tools' apps use, so no prompt is sent and no quota is spent.
 */
export async function usageCommand(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const filter = args.find((arg) => !arg.startsWith("--"));
  const none = filter ? `No signed-in seat matches ${filter}.` : "No signed-in Claude or Codex seats found.";

  // JSON goes to scripts (a statusline), so nothing else may reach stdout.
  if (json) {
    const seats = readable(await discoverSeats(undefined, "cli"), filter);
    if (seats.length === 0) {
      console.error(none);
      process.exit(1);
    }
    console.log(JSON.stringify(usageJson(await readAll(seats)), null, 2));
    return;
  }

  intro();
  const spinner = p.spinner();
  spinner.start("Discovering signed-in seats");
  const seats = readable(await discoverSeats(undefined, "cli"), filter);
  if (seats.length === 0) {
    spinner.stop("No seats to read");
    fail(none);
  }
  spinner.message(`Reading usage of ${seats.length} ${seats.length === 1 ? "seat" : "seats"}`);
  const results = await readAll(seats);
  const read = results.filter((result) => result.usage).length;
  spinner.stop(`Read ${read} of ${results.length} ${results.length === 1 ? "seat" : "seats"}`);
  console.log(usageTable(results));
  p.outro(pc.dim("No prompt was sent. Run `seats health` to check that each seat answers."));
}
