import { homedir } from "node:os";
import { relative } from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { isSymlink, linkTarget } from "../fs.ts";
import { seatSources } from "../providers/index.ts";
import { activeMetaFile, readActiveMeta } from "../store.ts";
import type { Seat, SeatKind } from "../types.ts";
import { KINDS, fail, formatSeat, intro } from "./ui.ts";

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

/** Shows the intro and a spinner while finding signed-in seats. Exits when there are none. */
export async function discoverWithSpinner(kind?: SeatKind): Promise<Seat[]> {
  intro();
  const spinner = p.spinner();
  spinner.start("Discovering signed-in seats");
  const seats = await discoverSeats(homedir(), kind);
  spinner.stop(seats.length === 1 ? "Found 1 signed-in seat" : `Found ${seats.length} signed-in seats`);
  if (seats.length === 0) fail("No signed-in seats found.");
  return seats;
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

/** `seats list [cli|api|cloud]` */
export async function listCommand([kind]: string[]): Promise<void> {
  const filter = KINDS.includes(kind as SeatKind) ? (kind as SeatKind) : undefined;
  const seats = await discoverWithSpinner(filter);
  for (const seat of seats) p.log.message(formatSeat(seat));
  p.outro(pc.dim("Run `seats` to switch."));
}

/** `seats current` */
export async function currentCommand(): Promise<void> {
  for (const item of currentSeats()) {
    const target = item.target ? ` -> ${item.target}` : pc.dim(" (not a symlink yet)");
    console.log(`${item.kind.padEnd(6)} ${item.provider.padEnd(14)} ${item.livePath}${target}`);
  }
}
