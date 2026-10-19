import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, relative } from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { isSymlink, linkTarget } from "../fs.ts";
import { discoverSeatDirs } from "../home-dirs.ts";
import { seatSources } from "../providers/index.ts";
import { activeMetaFile, readActiveMeta } from "../store.ts";
import type { Seat, SeatKind } from "../types.ts";
import { pinLines } from "./pin.ts";
import { fail, formatSeat, intro, KINDS } from "./ui.ts";

const real = (path: string) => (existsSync(path) ? realpathSync(path) : path);

/** Signed-in seats, by kind, then in provider registry order, then by label. */
export async function discoverSeats(home = homedir(), kind?: SeatKind): Promise<Seat[]> {
  const selected = kind ? seatSources.filter((source) => source.kind === kind) : seatSources;
  const groups = await Promise.all(selected.map((source) => source.discover(home)));

  const unique: Seat[] = [];
  const seen = new Set<string>();
  for (const seat of groups.flat()) {
    // The same API key can come from two places (OpenCode and Command Code); keep the first.
    const key = seat.kind === "api" ? `api:${seat.provider}` : seat.id;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(seat);
  }

  const sourceIndex = (seat: Seat) => seatSources.findIndex((source) => source.id === seat.source);
  return unique.sort(
    (a, b) =>
      KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) ||
      sourceIndex(a) - sourceIndex(b) ||
      a.label.localeCompare(b.label),
  );
}

/**
 * True when `seat` matches what was typed after a command: a kind (`cli`), a
 * tool or API provider (`claude`, `openrouter`) or a seat id (`claude:work`).
 */
export function matchesFilter(seat: Seat, filter: string | undefined): boolean {
  if (!filter) return true;
  return seat.kind === filter || seat.provider === filter || seat.source === filter || seat.id === filter;
}

/** Shows the intro and a spinner while finding signed-in seats. Exits when there are none. */
export async function discoverWithSpinner(
  kind?: SeatKind,
  filter?: string,
  { allowNone = false } = {},
): Promise<Seat[]> {
  intro();
  const spinner = p.spinner();
  spinner.start("Discovering signed-in seats");
  const seats = (await discoverSeats(homedir(), kind)).filter((seat) => matchesFilter(seat, filter));
  spinner.stop(seats.length === 1 ? "Found 1 signed-in seat" : `Found ${seats.length} signed-in seats`);
  if (seats.length === 0 && !allowNone)
    fail(filter ? `No signed-in seat matches ${filter}.` : "No signed-in seats found.");
  return seats;
}

/**
 * Seat folders of CLIs that seats can sign in to, but that aren't signed in:
 * shown so a sign-out never goes unnoticed, with the command that fixes it.
 */
export function signedOutSeats(home: string, signedIn: Seat[], filter: string | undefined): Seat[] {
  const known = new Set(signedIn.map((seat) => seat.dir && real(seat.dir)));
  return seatSources
    .filter((source) => source.kind === "cli" && source.login && source.livePath)
    .flatMap((source) =>
      discoverSeatDirs(home, source.id, basename(source.livePath!(home)))
        .filter((item) => !known.has(real(item.dir)))
        .map(
          (item): Seat => ({
            id: `${source.id}:${item.slug}`,
            source: source.id,
            provider: source.id,
            kind: "cli",
            label: item.label,
            dir: item.dir,
            signedIn: false,
          }),
        ),
    )
    .filter((seat) => matchesFilter(seat, filter));
}

export type ActiveSeat = {
  kind: string;
  provider: string;
  livePath: string;
  target?: string;
  targetPath?: string;
};

/** Where each CLI's live path points, plus the API or cloud seat in `active.env`. */
export function currentSeats(home = homedir()): ActiveSeat[] {
  const items: ActiveSeat[] = seatSources
    .filter((source) => source.livePath)
    .map((source) => {
      const livePath = source.livePath!(home);
      if (!isSymlink(livePath)) return { kind: source.kind, provider: source.label, livePath };
      const targetPath = linkTarget(livePath);
      return {
        kind: source.kind,
        provider: source.label,
        livePath,
        target: targetPath ? relative(home, targetPath) : undefined,
        targetPath,
      };
    });

  const meta = readActiveMeta(home);
  if (meta) items.push({ kind: meta.kind, provider: meta.label, livePath: activeMetaFile(home), target: meta.id });
  return items;
}

/** `seats list [cli|api|cloud | tool | seat id]` */
export async function listCommand([filter]: string[]): Promise<void> {
  const kind = KINDS.includes(filter as SeatKind) ? (filter as SeatKind) : undefined;
  // Signed-out seats still get listed, so don't stop when no seat is signed in.
  const seats = await discoverWithSpinner(kind, kind ? undefined : filter, { allowNone: true });
  const signedOut = signedOutSeats(homedir(), seats, filter);
  if (seats.length === 0 && signedOut.length === 0) fail(filter ? `No seat matches ${filter}.` : "No seats found.");
  for (const seat of seats) p.log.message(formatSeat(seat));
  for (const seat of signedOut) {
    const slug = seat.id.slice(seat.source.length + 1);
    p.log.message(
      pc.dim(`${seat.kind}  ${seat.provider} · ${seat.label}  signed out · seats add ${seat.source} ${slug}`),
    );
  }
  p.outro(pc.dim("Run `seats` to switch."));
}

/** `seats current`: the live paths, then any seats a `.seats` file pins here. */
export async function currentCommand(): Promise<void> {
  for (const item of currentSeats()) {
    const target = item.target ? ` -> ${item.target}` : pc.dim(" (not a symlink yet)");
    console.log(`${item.kind.padEnd(6)} ${item.provider.padEnd(14)} ${item.livePath}${target}`);
  }
  const pins = pinLines();
  if (pins.length > 0)
    console.log(`\nPinned here (seats run uses these):\n${pins.map((line) => `  ${line}`).join("\n")}`);
}
