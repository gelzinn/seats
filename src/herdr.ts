import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { seatFolders } from "./exclude.ts";
import { seatSources } from "./providers/index.ts";

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
 * When several seats have it (after `seats move` or an auto-switch), the one
 * written to last wins.
 */
export function resumeCommand(home: string, agent: string, sessionId: string): string[] | undefined {
  const source = seatSources.find((item) => item.id === agent && item.sessions?.find);
  if (!source || !SESSION_ID.test(sessionId)) return undefined;
  const copies = seatFolders(home, source).flatMap((folder) => {
    const file = source.sessions!.find!(folder.dir, sessionId);
    return file ? [{ id: folder.id, mtime: statSync(file).mtimeMs }] : [];
  });
  const newest = copies.sort((a, b) => b.mtime - a.mtime)[0];
  return newest && ["seats", "run", newest.id, ...source.sessions!.resumeArgs(sessionId)];
}

/**
 * `seats hook herdr`, run by the herdr plugin on `pane.agent_detected` and
 * `pane.agent_status_changed`: reports to herdr how to resume the pane's
 * conversation on its own seat, which then wins over herdr's own
 * `claude --resume` or `codex resume` (those open the active seat).
 *
 * A status change every turn costs one `pane get`: the seats are only
 * searched when the pane's session differs from the one last reported, or
 * when an agent process is detected (a restore, or an auto-switch reopening
 * the same session on the next seat), and a command already reported isn't
 * sent again except on detection.
 */
export function reportHerdrResume(home: string, env: NodeJS.ProcessEnv = process.env): void {
  const event = parse(env.HERDR_PLUGIN_EVENT_JSON);
  const paneId = record(event.data).pane_id;
  if (typeof paneId !== "string" || !paneId) return;
  const herdr = env.HERDR_BIN_PATH || "herdr";
  const run = (args: string[]) => spawnSync(herdr, args, { encoding: "utf8", env, timeout: 5_000 });

  const stateFile = env.HERDR_PLUGIN_STATE_DIR ? join(env.HERDR_PLUGIN_STATE_DIR, "reported.json") : undefined;
  const state = stateFile ? parse(readText(stateFile)) : {};
  const detected = env.HERDR_PLUGIN_EVENT === "pane.agent_detected";

  const got = run(["pane", "get", paneId]);
  if (got.status !== 0) return;
  const pane = record(record(parse(got.stdout).result).pane);
  const session = record(pane.agent_session);
  if (typeof pane.agent !== "string" || session.kind !== "id" || typeof session.value !== "string") return;
  // `{ session, command }` per pane; older versions kept only the command.
  const saved = state[paneId];
  const last = typeof saved === "string" ? { command: saved } : record(saved);
  const sessionKey = `${pane.agent}:${session.value}`;
  if (!detected && last.session === sessionKey) return;

  const argv = resumeCommand(home, pane.agent, session.value);
  if (!argv || !resumableInHerdr(argv)) return;
  const command = argv.join(" ");
  const save = () => {
    if (!stateFile) return;
    state[paneId] = { session: sessionKey, command };
    mkdirSync(env.HERDR_PLUGIN_STATE_DIR!, { recursive: true });
    writeFileSync(stateFile, `${JSON.stringify(state)}\n`);
  };
  if (!detected && last.command === command) {
    save();
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
  save();
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
