import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { seatFolders } from "./exclude.ts";
import { programName, type RunningProcess, runningProcesses } from "./processes.ts";
import { seatSources } from "./providers/index.ts";
import type { SeatSource } from "./types.ts";

/** What herdr's own restore checks before it saves a resume command (`validate_resume_argv`). */
const MAX_ARGS = 64;
const MAX_BYTES = 8192;

/** A session id that can safely name a transcript file. */
const SESSION_ID = /^[A-Za-z0-9_-]+$/;

type Json = Record<string, unknown>;

const record = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};

function parse(text: string | undefined): Json {
  try {
    return record(JSON.parse(text ?? ""));
  } catch {
    return {};
  }
}

/** herdr types the command into the pane's shell: a plain command name first, no quotes or control characters. */
export function resumableInHerdr(argv: string[]): boolean {
  const [command = ""] = argv;
  return (
    argv.length <= MAX_ARGS &&
    argv.reduce((total, arg) => total + Buffer.byteLength(arg), 0) <= MAX_BYTES &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what's checked
    argv.every((arg) => !/[\u0000-\u001f\u007f-\u009f']/.test(arg)) &&
    /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/.test(command)
  );
}

/**
 * The command that reopens session `sessionId` of `agent` on the seat that has
 * it: `seats run claude:work --resume <id>`, `seats run codex:work resume <id>`.
 * `seat`, the one the pane's agent runs on, wins when it has the session; else,
 * when several seats have it (after `seats move` or an auto-switch, or when
 * they share their conversations), the one written to last wins.
 */
export function resumeCommand(home: string, agent: string, sessionId: string, seat?: string): string[] | undefined {
  const source = seatSources.find((item) => item.id === agent && item.sessions?.find);
  if (!source || !SESSION_ID.test(sessionId)) return undefined;
  const folders = seatFolders(home, source);
  const own = folders.find((folder) => folder.id === seat && source.sessions!.find!(folder.dir, sessionId));
  const copies = folders.flatMap((folder) => {
    const file = source.sessions!.find!(folder.dir, sessionId);
    return file ? [{ id: folder.id, mtime: statSync(file).mtimeMs }] : [];
  });
  const chosen = own ?? copies.sort((a, b) => b.mtime - a.mtime)[0];
  return chosen && ["seats", "run", chosen.id, ...source.sessions!.resumeArgs(sessionId)];
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** `claude …`, or `node …/codex.js …`: the program, past an interpreter. */
function runs(argv: string[], binary: string): boolean {
  const [first = "", second = ""] = argv;
  return programName(first) === binary || (/^(node|bun)$/.test(programName(first)) && programName(second) === binary);
}

/**
 * The seat the agent in a pane runs on, from `herdr pane process-info`'s
 * foreground processes: the folder the agent process was given in its
 * config dir variable (else its live path, the active seat), which follows
 * an auto-switch; else the seat `seats run <tool>:<seat>` started on.
 * Undefined when neither leads to a seat.
 */
export function paneSeat(
  home: string,
  source: SeatSource,
  foreground: { pid: number; name?: string; argv: string[] }[],
  processes: (pids: number[]) => RunningProcess[] = runningProcesses,
): string | undefined {
  const folders = seatFolders(home, source);
  const byDir = (dir: string | undefined) => dir && folders.find((folder) => real(folder.dir) === real(dir))?.id;
  const { binary, configDirEnv, livePath } = source;
  if (binary && configDirEnv) {
    const agents = foreground.filter((item) => item.name === binary || runs(item.argv, binary)).map((item) => item.pid);
    for (const agent of agents.length > 0 ? processes(agents) : []) {
      const seat = byDir(agent.env[configDirEnv] ?? livePath?.(home));
      if (seat) return seat;
    }
  }
  for (const { argv } of foreground) {
    const at = argv.indexOf("run");
    const named = at > 0 ? argv[at + 1] : undefined;
    if (named?.startsWith(`${source.id}:`) && folders.some((folder) => folder.id === named)) return named;
  }
  return undefined;
}

/** The foreground processes herdr sees in a pane, empty when it doesn't answer. */
function foregroundOf(run: (args: string[]) => { status: number | null; stdout: string }, paneId: string) {
  const got = run(["pane", "process-info", "--pane", paneId]);
  if (got.status !== 0) return [];
  const list = record(record(parse(got.stdout).result).process_info).foreground_processes;
  if (!Array.isArray(list)) return [];
  return list.map(record).flatMap((item) => {
    const argv = Array.isArray(item.argv) ? item.argv.filter((arg) => typeof arg === "string") : [];
    const name = typeof item.name === "string" ? item.name : undefined;
    return typeof item.pid === "number" && argv.length > 0 ? [{ pid: item.pid, name, argv }] : [];
  });
}

/**
 * `seats hook herdr`, run by the herdr plugin on `pane.agent_detected` and
 * `pane.agent_status_changed`: reports to herdr how to resume the pane's
 * conversation on its own seat, which then wins over herdr's own
 * `claude --resume` or `codex resume` (those open the active seat).
 *
 * A status change every turn costs one `pane get`: the seats are only
 * searched when the pane's session differs from the one last settled. An
 * agent process detected in the pane (a restore, or an auto-switch reopening
 * the same session on the next seat) unsettles it and is always reported;
 * the next status change searches once more, since right after a switch
 * both seats may hold the same copy, mtime included. A command already
 * reported isn't sent again except on detection.
 *
 * The seat comes from the processes running in the pane (`paneSeat`) when
 * they lead to one that has the session, so seats sharing their
 * conversations, or holding the same copy, resume where the pane ran. herdr
 * is asked for them only on a detection, or for a pane with no state yet:
 * a pane only changes seat with a new agent process (an auto-switch or a
 * restore), and status changes reuse the seat saved then.
 */
export function reportHerdrResume(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  processes: (pids: number[]) => RunningProcess[] = runningProcesses,
): void {
  const event = parse(env.HERDR_PLUGIN_EVENT_JSON);
  const paneId = record(event.data).pane_id;
  if (typeof paneId !== "string" || !paneId) return;
  const herdr = env.HERDR_BIN_PATH || "herdr";
  const run = (args: string[]) => spawnSync(herdr, args, { encoding: "utf8", env, timeout: 5_000 });

  const stateFile = env.HERDR_PLUGIN_STATE_DIR ? join(env.HERDR_PLUGIN_STATE_DIR, "reported.json") : undefined;
  const state = stateFile ? parse(readText(stateFile)) : {};
  const detected = env.HERDR_PLUGIN_EVENT === "pane.agent_detected";
  // `{ session, command }` per pane, `session` once settled; older versions kept only the command.
  const saved = state[paneId];
  const last = typeof saved === "string" ? { command: saved } : record(saved);
  const save = (entry: Json) => {
    if (!stateFile) return;
    state[paneId] = entry;
    mkdirSync(env.HERDR_PLUGIN_STATE_DIR!, { recursive: true });
    writeFileSync(stateFile, `${JSON.stringify(state)}\n`);
  };
  if (detected && last.session) save({ command: last.command });

  const got = run(["pane", "get", paneId]);
  if (got.status !== 0) return;
  const pane = record(record(parse(got.stdout).result).pane);
  const session = record(pane.agent_session);
  if (typeof pane.agent !== "string" || session.kind !== "id" || typeof session.value !== "string") return;
  const sessionKey = `${pane.agent}:${session.value}`;
  if (!detected && last.session === sessionKey) return;

  // Only a new agent process moves a pane to another seat, and herdr detects it: status changes reuse that seat.
  const source = seatSources.find((item) => item.id === pane.agent);
  const fresh = detected || saved === undefined;
  const seat = fresh
    ? source && paneSeat(home, source, foregroundOf(run, paneId), processes)
    : typeof last.seat === "string"
      ? last.seat
      : undefined;

  const argv = resumeCommand(home, pane.agent, session.value, seat);
  if (!argv || !resumableInHerdr(argv)) return;
  const command = argv.join(" ");
  const settle = () => save({ ...(detected ? {} : { session: sessionKey }), command, ...(seat ? { seat } : {}) });
  if (!detected && last.command === command) {
    settle();
    return;
  }

  // Wall-clock nanoseconds: herdr wants a higher seq each time, also after a reboot.
  const seq = (BigInt(Date.now()) * 1_000_000n).toString();
  const reported = run([
    "pane",
    "report-agent-session",
    paneId,
    "--source",
    "seats",
    "--agent",
    pane.agent,
    "--seq",
    seq,
    "--",
    ...argv,
  ]);
  // Refused (herdr hasn't detected the agent in the pane yet): the next event tries again.
  if (reported.status !== 0) return;
  settle();
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** The id in `plugins/herdr/herdr-plugin.toml`. */
export const HERDR_PLUGIN_ID = "seats.resume";
/** Where `herdr plugin install` finds the plugin on GitHub. */
export const HERDR_PLUGIN_REPO = "gelzinn/seats/plugins/herdr";

/** What `herdr plugin list --json` says about one plugin. */
export type HerdrPlugin = { enabled: boolean; root?: string; local: boolean };

/**
 * `plugins/herdr` next to the code, in a source checkout. Undefined in a
 * compiled binary, which carries no files besides itself.
 */
export function herdrPluginDir(): string | undefined {
  const dir = join(import.meta.dir, "..", "plugins", "herdr");
  return existsSync(join(dir, "herdr-plugin.toml")) ? dir : undefined;
}

/** The seats plugin as herdr has it, null when it has none, undefined when herdr didn't answer. */
export function herdrPlugin(herdr: string, env: NodeJS.ProcessEnv = process.env): HerdrPlugin | null | undefined {
  const listed = spawnSync(herdr, ["plugin", "list", "--json"], { encoding: "utf8", env, timeout: 5_000 });
  if (listed.status !== 0) return undefined;
  const plugins = record(parse(listed.stdout).result).plugins;
  if (!Array.isArray(plugins)) return undefined;
  const found = plugins.map(record).find((plugin) => plugin.plugin_id === HERDR_PLUGIN_ID);
  if (!found) return null;
  return {
    enabled: found.enabled !== false,
    root: typeof found.plugin_root === "string" ? found.plugin_root : undefined,
    local: record(found.source).kind !== "github",
  };
}
