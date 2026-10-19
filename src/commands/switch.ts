import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { assertSwitchable, isSymlink, replaceSymlink } from "../fs.ts";
import { findPins, type Pin } from "../pins.ts";
import { seatSourceById } from "../providers/index.ts";
import { readConfig, writeActiveEnv } from "../store.ts";
import type { Seat, SeatKind } from "../types.ts";
import { currentSeats, discoverWithSpinner } from "./list.ts";
import { supervise } from "./run.ts";
import { syncSeats } from "./sync.ts";
import { cancelIfNeeded, fail, formatSeat, KINDS, tilde } from "./ui.ts";

/**
 * Makes `seat` the active one: writes its env for API/cloud seats, points the
 * CLI's live paths at its folder, and shares config with that tool's other seats.
 */
export function activateSeat(seat: Seat, home = homedir()): void {
  if (seat.env && Object.keys(seat.env).length > 0) {
    writeActiveEnv(home, seat.env, { id: seat.id, provider: seat.provider, kind: seat.kind, label: seat.label });
  }

  const source = seatSourceById(seat.source);
  const live = source.livePath?.(home);
  if (live && seat.dir && !(resolve(live) === resolve(seat.dir) && !isSymlink(live))) {
    assertSwitchable(live, seat.dir);
    replaceSymlink(live, seat.dir);
  }

  for (const extra of seat.extraLinks ?? []) {
    if (!existsSync(extra.target)) continue;
    if (resolve(extra.live) === resolve(extra.target) && !isSymlink(extra.live)) continue;
    assertSwitchable(extra.live, extra.target);
    replaceSymlink(extra.live, extra.target);
  }

  if (seat.kind === "cli") syncSeats(home, [source.id]);
}

async function pickKind(seats: Seat[]): Promise<SeatKind | "all"> {
  const available = KINDS.filter((kind) => seats.some((seat) => seat.kind === kind));
  if (available.length <= 1) return available[0] ?? "all";

  const choice = await p.select({
    message: "What kind of seat?",
    options: [
      { value: "all", label: "All", hint: `${seats.length} seats` },
      ...available.map((kind) => ({
        value: kind,
        label: kind.toUpperCase(),
        hint: `${seats.filter((seat) => seat.kind === kind).length} seats`,
      })),
    ],
  });
  cancelIfNeeded(choice);
  return choice as SeatKind | "all";
}

/** True when a `.seats` file pins `seat` for its tool in `cwd`. */
export function isPinned(seat: Seat, pins: Map<string, Pin>): boolean {
  const pin = seat.kind === "cli" ? pins.get(seat.source) : undefined;
  return pin !== undefined && seat.id === `${seat.source}:${pin.slug}`;
}

async function pickSeat(seats: Seat[]): Promise<Seat> {
  const current = currentSeats().find((item) => item.target);
  const pins = findPins();
  // A seat pinned in this project comes first, then the active one.
  const initial = (
    seats.find((seat) => isPinned(seat, pins)) ??
    seats.find(
      (seat) =>
        seat.id === current?.target || (current?.targetPath && seat.dir && resolve(seat.dir) === current.targetPath),
    )
  )?.id;

  const choice = await p.select({
    message: "Which seat do you want to use?",
    initialValue: initial,
    options: seats.map((seat) => ({
      value: seat.id,
      label: `${seat.provider} · ${seat.label}`,
      hint: [seat.email ?? seat.kind, isPinned(seat, pins) ? "pinned here" : ""].filter(Boolean).join(" · "),
    })),
  });
  cancelIfNeeded(choice);
  return seats.find((item) => item.id === choice) ?? fail("Unknown seat.");
}

/** Hands this terminal to the seat's CLI and exits with its code. */
function launch(seat: Seat, args: string[]): void {
  const source = seatSourceById(seat.source);
  if (!source.binary || seat.kind !== "cli") return;
  const child = spawn(source.binary, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      ...(source.configDirEnv && seat.dir ? { [source.configDirEnv]: seat.dir } : {}),
      ...(seat.env ?? {}),
    },
  });
  child.on("exit", (code) => process.exit(code ?? 0));
  child.on("error", (error) => {
    console.error(`Failed to launch ${source.binary}: ${error.message}`);
    process.exit(1);
  });
}

/** `seats [args…]`: pick a kind and a seat, activate it, then launch its CLI with `args`. */
export async function pickCommand(args: string[]): Promise<void> {
  const seats = await discoverWithSpinner();
  const kind = await pickKind(seats);
  const seat = await pickSeat(kind === "all" ? seats : seats.filter((item) => item.kind === kind));
  activateSeat(seat);
  const pointer = seat.dir ? `\n${pc.dim(tilde(seat.dir))}` : "";
  const env = seat.env ? `\n${pc.dim("source ~/.config/seats/active.env")}` : "";
  p.outro(`${formatSeat(seat)}${pointer}${env}`);

  const source = seatSourceById(seat.source);
  const config = readConfig(homedir());
  if (config.autoSwitch && seat.kind === "cli" && source.binary && source.configDirEnv) {
    const sameTool = seats.filter((item) => item.source === seat.source);
    process.exitCode = await supervise({
      home: homedir(),
      source,
      seats: sameTool,
      start: seat,
      args,
      autoSwitch: true,
      autoContinue: config.autoContinue,
    });
    return;
  }
  launch(seat, args);
}

/** `seats use <id>`: activate a seat without launching its CLI. */
export async function useCommand([id]: string[]): Promise<void> {
  const seats = await discoverWithSpinner();
  if (!id) fail("Pass a seat id, e.g. seats use claude:primary");
  const seat = seats.find((item) => item.id === id) ?? fail(`No signed-in seat named ${id}`);
  activateSeat(seat);
  p.outro(`${formatSeat(seat)} is active`);
  if (seat.env) p.log.step("Env keys written to ~/.config/seats/active.env");
}
