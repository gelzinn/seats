import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import pc from "picocolors";
import { version } from "../../package.json";
import { readExclusions, seatFolders } from "../exclude.ts";
import { HERDR_PLUGIN_ID, herdrPlugin } from "../herdr.ts";
import { tidySharedHooks } from "../hook-paths.ts";
import { seatSources } from "../providers/index.ts";
import { parseRecord } from "../share.ts";
import { SESSION_HOOK_COMMAND, sharedSettingsFile } from "../trust.ts";
import { tilde } from "./ui.ts";

/** `ok` undefined: skipped, shown dimmed and never a problem. */
export type Check = { ok?: boolean; text: string; fix?: string };

/** What the plugin's manifest asks for (`min_herdr_version`). */
const MIN_HERDR = [0, 9, 2];

/** Tools whose herdr integration reports the session id the plugin reads. */
const HERDR_TOOLS = ["claude", "codex"];

export type DoctorOptions = {
  which?: (command: string) => string | null;
  env?: NodeJS.ProcessEnv;
};

const run = (command: string, args: string[], env: NodeJS.ProcessEnv) =>
  spawnSync(command, args, { encoding: "utf8", env, timeout: 5_000 });

/** `seats` on the PATH, which the session hook and the herdr plugin run, and its version. */
function seatsChecks(which: DoctorOptions["which"] & {}, env: NodeJS.ProcessEnv): Check[] {
  const path = which("seats");
  if (!path) {
    return [
      {
        ok: false,
        text: "seats isn't on your PATH: the session hook and the herdr plugin can't run it",
        fix: "add the folder that holds seats to PATH",
      },
    ];
  }
  const found = run(path, ["--version"], env).stdout?.trim();
  if (found && found !== version) {
    return [
      {
        ok: false,
        text: `the seats on your PATH (${tilde(path)}) is ${found}, this one is ${version}`,
        fix: "install the same version in both places",
      },
    ];
  }
  return [{ ok: true, text: `seats is on your PATH (${tilde(path)})` }];
}

/** The session hook in each source's shared settings, and hook paths `seats sync` would tidy. */
function settingsChecks(home: string): Check[] {
  const exclusions = readExclusions(home);
  const checks: Check[] = [];
  for (const source of seatSources) {
    const hook = source.sessionHook;
    if (!hook) continue;
    const folders = seatFolders(home, source);
    if (folders.length < 2) continue;
    const dirs = folders.map((folder) => folder.dir);
    const keep = (dir: string, item: string) =>
      exclusions[folders.find((folder) => folder.dir === dir)!.id]?.includes(item) ?? false;
    const own = folders.filter((folder) => keep(folder.dir, hook.item)).map((folder) => folder.id);
    const file = sharedSettingsFile(home, source, dirs, keep);
    if (!file) {
      checks.push({
        ok: false,
        text: `every ${source.label} seat keeps its own ${hook.item}: none runs the session hook`,
        fix: `seats include ${own[0]} ${hook.item}`,
      });
      continue;
    }
    const shown = tilde(existsSync(file) ? realpathSync(file) : file);
    const settings = existsSync(file) ? readRecord(file) : {};
    if (!settings) {
      checks.push({ ok: false, text: `${shown} isn't valid JSON`, fix: "fix it, then run seats sync" });
      continue;
    }
    const without = own.length > 0 ? ` (not for ${own.join(", ")}, which keep their own)` : "";
    checks.push(
      hook.add(settings, SESSION_HOOK_COMMAND)
        ? { ok: false, text: `the session hook isn't in ${shown}`, fix: "seats sync" }
        : { ok: true, text: `the session hook is in ${shown}${without}` },
    );
    if (tidySharedHooks(home, source, dirs, keep, { dryRun: true })) {
      checks.push({
        ok: false,
        text: `${shown} runs hooks through one seat's folder, or the same hook twice`,
        fix: "seats sync",
      });
    }
  }
  return checks;
}

/** A Paseo config still loading the plugin from `integrations/paseo`, where it lived before. */
function paseoChecks(home: string): Check[] {
  const file = join(home, ".paseo", "config.json");
  const config = existsSync(file) ? readRecord(file) : undefined;
  const plugins = config?.plugins;
  if (!plugins || typeof plugins !== "object") return [];
  return Object.entries(plugins as Record<string, unknown>).flatMap(([name, plugin]): Check[] => {
    const path = (plugin as Record<string, unknown> | null)?.path;
    if (typeof path !== "string" || !/\/integrations\/paseo\/?$/.test(path)) return [];
    const next = path.replace(/\/integrations\/paseo(\/?)$/, "/plugins/paseo$1");
    return [
      {
        ok: false,
        text: `Paseo loads plugin "${name}" from ${tilde(path)}, which moved`,
        fix: `set plugins.${name}.path in ~/.paseo/config.json to ${tilde(next)}`,
      },
    ];
  });
}

/** herdr's version, the seats plugin, and herdr's own integrations for the tools that have seats. */
function herdrChecks(home: string, which: DoctorOptions["which"] & {}, env: NodeJS.ProcessEnv): Check[] {
  const herdr = which("herdr");
  if (!herdr) return [{ text: "herdr isn't installed: skipped its checks" }];
  const checks: Check[] = [];

  const shown = run(herdr, ["--version"], env).stdout?.match(/(\d+)\.(\d+)\.(\d+)/);
  const current = shown?.slice(1).map(Number);
  if (current && compare(current, MIN_HERDR) < 0) {
    checks.push({
      ok: false,
      text: `herdr ${current.join(".")} is older than the plugin needs (${MIN_HERDR.join(".")})`,
      fix: "update herdr",
    });
  }

  const plugin = herdrPlugin(herdr, env);
  if (plugin === undefined) {
    checks.push({ ok: false, text: "herdr didn't list its plugins", fix: "herdr plugin list" });
  } else if (plugin === null) {
    checks.push({ ok: false, text: "herdr doesn't have the seats plugin", fix: "seats install plugin herdr" });
  } else if (plugin.local && plugin.root && !existsSync(plugin.root)) {
    checks.push({
      ok: false,
      text: `herdr links the seats plugin from ${tilde(plugin.root)}, which is gone`,
      fix: "seats uninstall plugin herdr && seats install plugin herdr",
    });
  } else if (!plugin.enabled) {
    checks.push({
      ok: false,
      text: "herdr has the seats plugin, disabled",
      fix: `herdr plugin enable ${HERDR_PLUGIN_ID}`,
    });
  } else {
    const from = plugin.local && plugin.root ? `linked from ${tilde(plugin.root)}` : "from GitHub";
    checks.push({ ok: true, text: `herdr has the seats plugin, ${from}` });
  }

  // Without the seat's config dir, herdr looks at the live path, as it does from a plain shell.
  const { CLAUDE_CONFIG_DIR: _, CODEX_HOME: __, ...plain } = env;
  const status = run(herdr, ["integration", "status"], plain).stdout ?? "";
  for (const tool of HERDR_TOOLS) {
    const source = seatSources.find((item) => item.id === tool);
    if (!source || seatFolders(home, source).length === 0) continue;
    const state = status.match(new RegExp(`^${tool}: ([^(\\n]+?)\\s*(\\(|$)`, "m"))?.[1];
    checks.push(
      state?.startsWith("current")
        ? { ok: true, text: `herdr's ${tool} integration is installed` }
        : {
            ok: false,
            text: `herdr's ${tool} integration is ${state ?? "missing"}: the plugin can't read ${tool}'s session ids`,
            fix: `herdr integration install ${tool}`,
          },
    );
  }
  return checks;
}

/** Every check, in the order they're printed. Reads only: nothing is written. */
export function doctorChecks(home: string, { which = Bun.which, env = process.env }: DoctorOptions = {}): Check[] {
  return [...seatsChecks(which, env), ...settingsChecks(home), ...herdrChecks(home, which, env), ...paseoChecks(home)];
}

export function printChecks(checks: Check[]): void {
  for (const check of checks) {
    if (check.ok === undefined) console.log(pc.dim(`- ${check.text}`));
    else console.log(`${check.ok ? pc.green("✓") : pc.yellow("!")} ${check.text}`);
    if (check.fix) console.log(pc.dim(`    ${check.fix}`));
  }
}

/** `seats doctor`: exits 1 when something needs fixing. */
export async function doctorCommand(): Promise<void> {
  const checks = doctorChecks(homedir());
  printChecks(checks);
  if (checks.some((check) => check.ok === false)) process.exitCode = 1;
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < b.length; i++) if ((a[i] ?? 0) !== b[i]) return (a[i] ?? 0) - b[i]!;
  return 0;
}

function readRecord(file: string): Record<string, unknown> | undefined {
  try {
    return parseRecord(readFileSync(file));
  } catch {
    return undefined;
  }
}
