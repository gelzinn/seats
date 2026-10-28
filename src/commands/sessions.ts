import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { seatSourceById } from "../providers/index.ts";
import type { Seat, Session } from "../types.ts";
import { discoverSeats, matchesFilter, signedOutSeats } from "./list.ts";
import { copyTranscript, supervise } from "./run.ts";
import { cancelIfNeeded, fail, intro, table, tilde, truncate } from "./ui.ts";

/** Rows `seats sessions` shows before saying how many more there are. */
const LIMIT = 20;

export type SeatSession = Session & { seat: Seat };

const real = (path: string) => (existsSync(path) ? realpathSync(path) : path);

/**
 * Seat folders of tools that keep conversations, signed in or not: a
 * signed-out seat's history is still worth moving somewhere it can go on.
 */
export async function sessionSeats(home: string): Promise<Seat[]> {
  const signedIn = await discoverSeats(home, "cli");
  return [...signedIn, ...signedOutSeats(home, signedIn, undefined)].filter(
    (seat) => seat.dir && seatSourceById(seat.source).sessions?.list,
  );
}

/** Every conversation of `seats`, newest first. */
export function listSessions(seats: Seat[]): SeatSession[] {
  return seats
    .flatMap((seat) =>
      (seatSourceById(seat.source).sessions?.list?.(seat.dir!) ?? []).map((item) => ({ ...item, seat })),
    )
    .sort((a, b) => +b.updatedAt - +a.updatedAt);
}

/** True when the conversation ran in `cwd`: what `claude --resume` lists there. */
export function inFolder(session: Session, cwd: string): boolean {
  return session.cwd !== undefined && real(session.cwd) === real(cwd);
}

/** "5m ago", "3h ago", "2d ago", then the date. */
export function ago(date: Date, now = new Date()): string {
  const minutes = Math.floor((+now - +date) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ago`;
  if (minutes < 30 * 24 * 60) return `${Math.floor(minutes / (24 * 60))}d ago`;
  return date.toLocaleDateString();
}

const shortId = (id: string) => id.slice(0, 8);
const describe = (session: SeatSession) => `${shortId(session.id)}  ${session.seat.id}  ${truncate(session.title, 50)}`;

/**
 * Every copy of the one conversation whose id starts with `prefix`, newest
 * first. Throws when none matches, or when the prefix fits several.
 */
export function findSession(sessions: SeatSession[], prefix: string): SeatSession[] {
  const copies = sessions.filter((session) => session.id.startsWith(prefix));
  const ids = [...new Set(copies.map((session) => session.id))];
  if (ids.length === 0)
    throw new Error(`No conversation id starts with ${prefix}. See them with seats sessions --all.`);
  if (ids.length > 1) {
    const candidates = ids.map((id) => describe(copies.find((session) => session.id === id)!));
    throw new Error(`${prefix} fits ${ids.length} conversations. Type more of the id:\n${candidates.join("\n")}`);
  }
  return copies;
}

export type MoveResult = { from: SeatSession; to: Seat; file: string };

/**
 * Copies a conversation to `target`, at the same path inside the seat, so
 * the tool there can resume it. The original stays where it was.
 */
export function moveSession(sessions: SeatSession[], prefix: string, target: Seat, { force = false } = {}): MoveResult {
  const copies = findSession(sessions, prefix);
  const { id, seat } = copies[0]!;
  if (seat.source !== target.source) throw new Error(`${id} is a ${seat.source} conversation; ${target.id} isn't.`);
  const others = copies.filter((session) => session.seat.id !== target.id);
  if (others.length === 0) throw new Error(`${shortId(id)} is already on ${target.id}. Name another seat.`);
  if (others.length < copies.length && !force)
    throw new Error(`${target.id} already has ${shortId(id)}. Add --force to replace its copy.`);
  const from = others[0]!;
  const file = copyTranscript(from.file, from.seat.dir!, target.dir!);
  if (!file) throw new Error(`Couldn't copy ${shortId(id)}: its transcript isn't inside ${tilde(from.seat.dir!)}.`);
  return { from, to: target, file };
}

/** A path to paste in a shell, quoted when it needs to be. */
const quote = (path: string) => (/^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`);

/** `seats sessions [tool|id] [--all]`: conversations from every seat, newest first. */
export async function sessionsCommand(argv: string[]): Promise<void> {
  const all = argv.includes("--all");
  const [filter] = argv.filter((arg) => !arg.startsWith("--"));
  const home = homedir();
  const cwd = process.cwd();
  intro();
  const seats = (await sessionSeats(home)).filter((seat) => matchesFilter(seat, filter));
  if (seats.length === 0) fail(filter ? `No Claude seat matches ${filter}.` : "No Claude seats found.");

  const sessions = listSessions(seats).filter((session) => all || inFolder(session, cwd));
  if (sessions.length === 0)
    return p.outro(
      all ? "No conversations yet." : `No conversations in ${tilde(cwd)}. Run seats sessions --all for every project.`,
    );

  const now = new Date();
  const titleWidth = Math.max(20, (process.stdout.columns || 120) - 80);
  const rows = sessions
    .slice(0, LIMIT)
    .map((session) => [
      session.seat.id,
      pc.dim(ago(session.updatedAt, now)),
      session.cwd ? tilde(session.cwd) : pc.dim("—"),
      truncate(session.title, titleWidth),
      pc.cyan(shortId(session.id)),
    ]);
  console.log(table(["Seat", "When", "Project", "Title", "Id"], rows));
  const more = sessions.length - LIMIT;
  if (more > 0)
    p.log.message(pc.dim(`${more} older ${more === 1 ? "conversation isn't" : "conversations aren't"} shown.`));
  p.outro(pc.dim("Continue one on another seat with seats move <id> <seat>."));
}

/**
 * `seats move <session id or prefix> <seat id> [--force]`: copies a
 * conversation to another seat and offers to reopen it there. The global
 * active seat doesn't change.
 */
export async function moveCommand(argv: string[]): Promise<void> {
  const force = argv.includes("--force");
  const [prefix, targetId] = argv.filter((arg) => !arg.startsWith("--"));
  if (!prefix || !targetId) fail("Use seats move <session id> <seat id>, e.g. seats move 3f2a claude:work.");
  const home = homedir();
  intro();
  const seats = await sessionSeats(home);
  const target =
    seats.find((seat) => seat.id === targetId) ??
    fail(`No seat ${targetId}. Seats with conversations: ${seats.map((seat) => seat.id).join(", ")}.`);

  let result: MoveResult;
  try {
    result = moveSession(listSessions(seats), prefix, target, { force });
  } catch (error) {
    fail((error as Error).message);
  }
  const { from } = result;
  p.log.success(`Copied "${truncate(from.title, 50)}" from ${from.seat.id} to ${pc.bold(target.id)}.`);
  p.log.message(pc.dim(`It's a copy: the conversation is still on ${from.seat.id}.`));

  const source = seatSourceById(target.source);
  const args = source.sessions!.resumeArgs(from.id);
  const cwd = from.cwd && existsSync(from.cwd) ? from.cwd : undefined;
  if (from.cwd && !cwd) p.log.warn(`${tilde(from.cwd)} is gone, so --resume may not find the conversation.`);
  const command = `${cwd ? `cd ${quote(cwd)} && ` : ""}${source.configDirEnv}=${quote(target.dir!)} ${source.binary} ${args.join(" ")}`;
  const later = `To continue it there: ${pc.cyan(command)}`;
  if (!process.stdout.isTTY || !target.signedIn)
    return p.outro(
      target.signedIn
        ? later
        : `${later}\nSign in first with seats add ${target.source} ${target.id.slice(target.source.length + 1)}.`,
    );

  const open = await p.confirm({ message: `Open it now on ${target.id}?` });
  cancelIfNeeded(open);
  if (!open) return p.outro(later);
  p.outro(`Opening on ${target.id}…`);
  process.exitCode = await supervise({
    home,
    source,
    seats: [target],
    start: target,
    args,
    // The seat was picked on purpose; switching away would resume where the copy isn't.
    autoSwitch: false,
    cwd,
  });
}
