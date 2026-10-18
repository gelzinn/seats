import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { lexists } from "../fs.ts";
import { discoverSeatDirs, isIgnoredAccountDir } from "../home-dirs.ts";
import { seatSources } from "../providers/index.ts";
import { storeDir } from "../store.ts";
import type { SeatSource } from "../types.ts";
import { activateSeat } from "./switch.ts";
import { syncSeats } from "./sync.ts";
import { cancelIfNeeded, fail, formatSeat, intro, tilde } from "./ui.ts";

/** Asks for the code the CLI is waiting for; undefined when the user cancels. */
export type AskCode = (signal: AbortSignal) => Promise<string | undefined>;

/** The CLI's own code prompt, and how seats asks for that code instead. */
export type CodePrompt = { text: string; ask: AskCode };

/** Runs a CLI attached to this terminal and resolves with its exit code. */
export type Runner = (command: string, args: string[], env: Record<string, string>, codePrompt?: CodePrompt) => Promise<number>;

/**
 * Runs the CLI with its output passed through line by line. When it prints
 * `codePrompt.text`, that prompt is hidden and `ask` reads the code instead,
 * which then goes to the CLI's input. If the CLI exits first, `ask` is aborted.
 */
export function runWithCodePrompt(
  command: string,
  args: string[],
  env: Record<string, string>,
  codePrompt: CodePrompt,
  write: (text: string) => void = (text) => process.stdout.write(text),
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, ...env } });
    const done = new AbortController();
    let pending = "";
    let asked = false;

    child.stdout.on("data", (chunk: Buffer) => {
      if (asked) return write(chunk.toString());
      pending += chunk.toString();
      const at = pending.indexOf(codePrompt.text);
      if (at === -1) {
        // Hold back the last, unfinished line: it may be the prompt arriving in pieces.
        const cut = pending.lastIndexOf("\n") + 1;
        write(pending.slice(0, cut));
        pending = pending.slice(cut);
        return;
      }
      asked = true;
      write(pending.slice(0, at));
      const rest = pending.slice(at + codePrompt.text.length).replace(/^ /, "");
      pending = "";
      if (rest) write(rest);
      codePrompt.ask(done.signal).then((code) => {
        if (code === undefined) child.kill("SIGTERM");
        else child.stdin.end(`${code.trim()}\n`);
      }, reject);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      done.abort();
      if (pending) write(pending);
      resolve(code ?? 1);
    });
  });
}

export const runInTerminal: Runner = (command, args, env, codePrompt) => {
  if (codePrompt && process.stdin.isTTY) return runWithCodePrompt(command, args, env, codePrompt);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env: { ...process.env, ...env } });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
};

/** Seat sources that `seats add` can sign in to. */
export const loginSources = (): SeatSource[] =>
  seatSources.filter((source) => source.login && source.binary && source.configDirEnv && source.livePath);

/** Why `slug` can't name a new seat of `source`, or undefined when it can. */
export function invalidSlug(_home: string, _source: SeatSource, slug: string): string | undefined {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return "Use lowercase letters, numbers and dashes, like work or side-project.";
  if (slug === "default" || isIgnoredAccountDir(slug)) return `"${slug}" is reserved.`;
  return undefined;
}

/** The folder of an existing `<source>:<slug>` seat (store or legacy), if there is one. */
function existingSeatDir(home: string, source: SeatSource, slug: string): string | undefined {
  const liveName = basename(source.livePath!(home));
  const found = discoverSeatDirs(home, source.id, liveName).find((seat) => seat.slug === slug)?.dir;
  const inStore = join(storeDir(home, source.id), slug);
  return found ?? (lexists(inStore) ? inStore : undefined);
}

export type AddResult = { id: string; dir: string; shared: number; reused: boolean };

/**
 * Creates `~/.config/seats/<source>/<slug>` and runs the CLI's own sign-in
 * there (it prints the link and asks for the code). If sign-in doesn't finish,
 * the folder is removed. Otherwise the new seat gets the config every seat of
 * that tool shares.
 */
export async function addSeat(
  home: string,
  source: SeatSource,
  slug: string,
  { extraArgs = [], run = runInTerminal, askCode }: { extraArgs?: string[]; run?: Runner; askCode?: AskCode } = {},
): Promise<AddResult> {
  const { login, binary, configDirEnv } = source;
  if (!login || !binary || !configDirEnv) throw new Error(`seats can't sign in to ${source.label} yet.`);
  const problem = invalidSlug(home, source, slug);
  if (problem) throw new Error(problem);

  // A seat that exists but is signed out is signed in again in place, keeping its files.
  const existing = existingSeatDir(home, source, slug);
  if (existing && (await login.signedIn(existing))) throw new Error(`${source.id}:${slug} already exists and is signed in.`);
  const dir = existing ?? join(storeDir(home, source.id), slug);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  let signedIn = false;
  try {
    const codePrompt = login.codePrompt && askCode ? { text: login.codePrompt, ask: askCode } : undefined;
    await run(binary, [...login.args, ...extraArgs], { [configDirEnv]: dir }, codePrompt);
    signedIn = await login.signedIn(dir);
  } finally {
    // The CLI writes files before sign-in completes; don't leave a half-made seat behind.
    // A seat that was already there is never removed.
    if (!signedIn && !existing) rmSync(dir, { recursive: true, force: true });
  }
  if (!signedIn) throw new Error(existing ? "Sign-in didn't finish; the seat is unchanged." : "Sign-in didn't finish, so no seat was created.");

  const shared = syncSeats(home, [source.id]);
  return { id: `${source.id}:${slug}`, dir, shared: shared.linked.length + shared.merged.length, reused: existing !== undefined };
}

async function pickSource(id: string | undefined): Promise<SeatSource> {
  const sources = loginSources();
  const names = sources.map((source) => source.id).join(", ");
  if (id) {
    const source = sources.find((item) => item.id === id);
    if (source) return source;
    const known = seatSources.some((item) => item.id === id);
    fail(
      known
        ? `seats can't sign in to ${id} yet: it doesn't keep each login in its own folder. Sign in with ${id} itself. Supported: ${names}.`
        : `Unknown tool "${id}". Supported: ${names}.`,
    );
  }
  const choice = await p.select({
    message: "Which tool is the new account for?",
    options: sources.map((source) => ({ value: source.id, label: source.label })),
  });
  cancelIfNeeded(choice);
  return sources.find((source) => source.id === choice)!;
}

async function pickName(source: SeatSource, given: string | undefined): Promise<string> {
  const home = homedir();
  if (given) {
    const problem = invalidSlug(home, source, given);
    if (problem) fail(problem);
    return given;
  }
  const name = await p.text({
    message: "Name for the new seat",
    placeholder: "work",
    validate: (value) => invalidSlug(home, source, value ?? ""),
  });
  cancelIfNeeded<string>(name);
  return name;
}

/**
 * `seats add [tool] [name] [-- login args]`: sign a new account in without
 * touching the active one. The tool's own sign-in runs in this terminal: it
 * shows a link, and you paste the code back when it asks.
 */
export async function addCommand(argv: string[]): Promise<void> {
  const split = argv.indexOf("--");
  const [toolArg, nameArg] = split === -1 ? argv : argv.slice(0, split);
  const extraArgs = split === -1 ? [] : argv.slice(split + 1);

  intro();
  const source = await pickSource(toolArg);
  const slug = await pickName(source, nameArg);

  p.log.step(
    `Signing in to ${source.label} as ${pc.cyan(`${source.id}:${slug}`)}. ` +
      "Open the link below and paste the code back here if asked.",
  );
  const home = homedir();
  const askCode: AskCode = async (signal) => {
    const code = await p.password({ message: "Paste the code from the browser", mask: "*", signal });
    return p.isCancel(code) ? undefined : code;
  };
  const result = await addSeat(home, source, slug, { extraArgs, askCode }).catch((error: Error) => fail(error.message));

  const seat = (await source.discover(home)).find((item) => item.id === result.id);
  p.log.success(`${seat ? formatSeat(seat) : result.id} is signed in`);
  p.log.message(pc.dim(tilde(result.dir)));
  if (result.shared > 0) p.log.message(pc.dim("Shared settings, skills and MCP servers from your other seats."));

  if (!seat) return p.outro(`Run ${pc.cyan(`seats use ${result.id}`)} to switch to it.`);
  const now = await p.confirm({ message: "Switch to it now?" });
  cancelIfNeeded(now);
  if (now) activateSeat(seat);
  p.outro(now ? `${formatSeat(seat)} is active` : `Run ${pc.cyan(`seats use ${result.id}`)} when you need it.`);
}
