import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { isInside, isSymlink, lexists, linkTarget, moveTree } from "../fs.ts";
import { discoverSeatDirs } from "../home-dirs.ts";
import { processesUsing, type RunningProcess, runningProcesses } from "../processes.ts";
import { seatSources } from "../providers/index.ts";
import { storeDir } from "../store.ts";
import type { SeatSource } from "../types.ts";
import { invalidSlug, type Runner, runInTerminal } from "./add.ts";
import { discoverWithSpinner } from "./list.ts";
import { repoint } from "./migrate.ts";
import { cancelIfNeeded, fail, tilde } from "./ui.ts";

/** CLIs whose seats seats can tell are in use: it launches them with a config-folder variable. */
const managedSources = () =>
  seatSources.filter((source) => source.kind === "cli" && source.livePath && source.configDirEnv && source.binary);

export type SeatFolder = { id: string; source: SeatSource; slug: string; dir: string };

/** The folder behind a `<tool>:<slug>` seat, signed in or not. */
export function findSeatFolder(home: string, id: string): SeatFolder {
  const colon = id.indexOf(":");
  if (colon <= 0 || colon === id.length - 1) throw new Error(`Pass a seat id, like claude:work.`);
  const sourceId = id.slice(0, colon);
  const slug = id.slice(colon + 1);
  const sources = managedSources();
  const source = sources.find((item) => item.id === sourceId);
  if (!source) {
    throw new Error(
      `seats can't rename or remove ${sourceId} seats. Supported: ${sources.map((item) => item.id).join(", ")}.`,
    );
  }
  const live = source.livePath!(home);
  const dir = discoverSeatDirs(home, source.id, basename(live)).find((item) => item.slug === slug)?.dir;
  if (!dir) throw new Error(`No seat named ${id}.`);
  // A real ~/.claude is the `default` seat; the CLI reads it directly, so it stays put.
  if (resolve(dir) === resolve(live)) throw new Error(`${id} is ${tilde(live)} itself, which seats doesn't move.`);
  return { id, source, slug, dir };
}

/** Every seat folder seats can rename or remove, signed in or not; the real live folder isn't one. */
export function seatFolders(home: string): SeatFolder[] {
  return managedSources().flatMap((source) => {
    const live = resolve(source.livePath!(home));
    return discoverSeatDirs(home, source.id, basename(live))
      .filter((item) => resolve(item.dir) !== live)
      .sort((a, b) => a.slug.localeCompare(b.slug, undefined, { numeric: true }))
      .map((item) => ({ id: `${source.id}:${item.slug}`, source, slug: item.slug, dir: item.dir }));
  });
}

/** True when the CLI's live path points at this seat. */
export function isActiveSeat(home: string, seat: SeatFolder): boolean {
  const target = linkTarget(seat.source.livePath!(home));
  return target !== undefined && isInside(target, resolve(seat.dir));
}

/** A running session keeps writing to its folder, and a refresh there can sign the seat out. */
function assertIdle(seat: SeatFolder, processes: () => RunningProcess[]): void {
  const { binary, configDirEnv } = seat.source;
  const busy = processesUsing(binary!, configDirEnv!, seat.dir, processes);
  if (busy.length === 0) return;
  const one = busy.length === 1;
  const pids = busy.map((item) => item.pid).join(", ");
  throw new Error(
    `${seat.id} is in use by ${binary} ${one ? "process" : "processes"} ${pids}. Close ${one ? "it" : "them"} first.`,
  );
}

/** The lock folder Claude Code leaves next to a seat (`<slug>.lock`), stale once no session uses it. */
const removeLock = (dir: string) => rmSync(`${dir}.lock`, { recursive: true, force: true });

export type RenameResult = { id: string; dir: string; active: boolean; source: SeatSource };

/**
 * Moves the seat's folder to `~/.config/seats/<tool>/<to>` and repoints
 * whatever led to the old one: the live symlinks when it's the active seat,
 * links between seats and paths in `settings.json`.
 */
export function renameSeat(
  home: string,
  id: string,
  to: string,
  { processes = runningProcesses }: { processes?: () => RunningProcess[] } = {},
): RenameResult {
  const seat = findSeatFolder(home, id);
  const problem = invalidSlug(home, seat.source, to);
  if (problem) throw new Error(problem);
  const nextId = `${seat.source.id}:${to}`;
  const target = join(storeDir(home, seat.source.id), to);
  const taken = discoverSeatDirs(home, seat.source.id, basename(seat.source.livePath!(home))).some(
    (item) => item.slug === to,
  );
  if (taken || lexists(target)) throw new Error(`${nextId} already exists.`);
  assertIdle(seat, processes);

  const active = isActiveSeat(home, seat);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  try {
    moveTree(seat.dir, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EXDEV") {
      throw new Error(`${tilde(seat.dir)} and ${tilde(target)} are on different filesystems. Move it by hand.`);
    }
    throw error;
  }
  repoint(home, seat.dir, target);
  removeLock(seat.dir);
  return { id: nextId, dir: target, active, source: seat.source };
}

export type RemoveResult = { id: string; dir: string; signedOut: boolean };

/**
 * Signs the seat's account out with the CLI's own logout, then deletes its
 * folder. Links inside it are removed, never what they point at, so shared
 * config stays. The active seat is refused: switch away from it first.
 */
export async function removeSeat(
  home: string,
  id: string,
  {
    processes = runningProcesses,
    run = runInTerminal,
    keepLogin = false,
  }: { processes?: () => RunningProcess[]; run?: Runner; keepLogin?: boolean } = {},
): Promise<RemoveResult> {
  const seat = findSeatFolder(home, id);
  const { source } = seat;
  if (isActiveSeat(home, seat)) {
    throw new Error(`${id} is the active ${source.label} seat. Switch to another one with seats use first.`);
  }
  assertIdle(seat, processes);

  const logoutArgs = source.login?.logoutArgs;
  const signedIn = (await source.login?.signedIn(seat.dir)) ?? false;
  let signedOut = false;
  if (!keepLogin && logoutArgs && signedIn) {
    const code = await run(source.binary!, logoutArgs, { [source.configDirEnv!]: seat.dir });
    if (code !== 0) {
      throw new Error(
        `${source.binary} ${logoutArgs.join(" ")} failed, so ${id} was kept. Pass --keep-login to remove it anyway.`,
      );
    }
    signedOut = true;
  }

  rmSync(seat.dir, { recursive: true, force: true });
  removeLock(seat.dir);
  return { id, dir: seat.dir, signedOut };
}

const orFail = <T>(action: () => T): T => {
  try {
    return action();
  } catch (error) {
    return fail((error as Error).message);
  }
};

/** Asks which seat to act on, listing each with its account; the active one can't be picked when `skipActive`. */
async function pickSeatFolder(message: string, { skipActive = false } = {}): Promise<string> {
  const home = homedir();
  const folders = seatFolders(home);
  if (folders.length === 0) fail("No seat to pick. Add one with seats add.");
  const signedIn = await discoverWithSpinner("cli", undefined, { allowNone: true });
  const emailOf = (dir: string) => signedIn.find((seat) => seat.dir && resolve(seat.dir) === resolve(dir))?.email;
  const choice = await p.select({
    message,
    options: folders.map((seat) => {
      const active = isActiveSeat(home, seat);
      const label = `${seat.id}  ${pc.dim(emailOf(seat.dir) ?? "signed out")}`;
      return { value: seat.id, label, hint: active ? "active" : undefined, disabled: skipActive && active };
    }),
  });
  cancelIfNeeded<string>(choice);
  return choice;
}

const interactive = () => process.stdin.isTTY && process.stdout.isTTY;

/** `seats rename [tool:slug] [new-slug]`: asks for whatever is missing. */
export async function renameCommand([id, to]: string[]): Promise<void> {
  if ((!id || !to) && !interactive()) fail("Pass a seat id and its new name, e.g. seats rename claude:primary work");
  id ??= await pickSeatFolder("Which seat do you want to rename?");
  if (!to) {
    const seat = orFail(() => findSeatFolder(homedir(), id));
    const name = await p.text({
      message: `New name for ${id}`,
      placeholder: seat.slug,
      validate: (value) => (value ? invalidSlug(homedir(), seat.source, value) : "Type a name."),
    });
    cancelIfNeeded<string>(name);
    to = name;
  }
  const result = orFail(() => renameSeat(homedir(), id, to));
  p.log.success(`${id} is now ${pc.cyan(result.id)}`);
  p.log.message(pc.dim(tilde(result.dir)));
  if (result.active) p.log.message(pc.dim("Still the active seat; the live paths point at the new folder."));
  p.outro(
    pc.dim(`Update any ${result.source.configDirEnv} set to the old folder, in your shell config or other tools.`),
  );
}

/** `seats remove [tool:slug] [--yes] [--keep-login]`: with no id, asks which seat. */
export async function removeCommand(args: string[]): Promise<void> {
  let id = args.find((arg) => !arg.startsWith("-"));
  if (!id && !interactive()) fail("Pass a seat id, e.g. seats remove claude:work. See seats list for the ids.");
  id ??= await pickSeatFolder("Which seat do you want to remove?", { skipActive: true });
  const yes = args.includes("--yes") || args.includes("-y");
  const keepLogin = args.includes("--keep-login");
  const home = homedir();
  const seat = orFail(() => findSeatFolder(home, id));

  if (!yes) {
    if (!process.stdin.isTTY) fail("Pass --yes to remove a seat without being asked.");
    const projects = seat.source.history?.projects;
    const shared = projects !== undefined && isSymlink(join(seat.dir, projects));
    const goes = shared
      ? "Its login goes with it; shared conversations stay."
      : "Its login, sessions and history go with it.";
    const sure = await p.confirm({
      message: `Delete ${tilde(seat.dir)}? ${goes}`,
      initialValue: false,
    });
    cancelIfNeeded(sure);
    if (!sure) return p.outro("Nothing removed.");
  }

  const result = await removeSeat(home, id, { keepLogin }).catch((error: Error) => fail(error.message));
  if (result.signedOut) p.log.step(`Signed ${id} out`);
  p.outro(`Removed ${id}`);
}
