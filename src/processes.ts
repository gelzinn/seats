import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, resolve } from "node:path";

export type RunningProcess = { pid: number; argv: string[]; env: Record<string, string> };

function parseEnv(entries: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of entries) {
    const eq = entry.indexOf("=");
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}

/** Linux: every process of this user (or those in `only`), from `/proc`. Undefined where there's no `/proc`. */
function fromProc(only?: number[]): RunningProcess[] | undefined {
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
  } catch {
    return undefined;
  }
  if (only) pids = pids.filter((pid) => only.includes(Number(pid)));
  const found: RunningProcess[] = [];
  for (const pid of pids) {
    try {
      const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
      const env = parseEnv(readFileSync(`/proc/${pid}/environ`, "utf8").split("\0"));
      found.push({ pid: Number(pid), argv, env });
    } catch {
      // Exited meanwhile, or belongs to another user.
    }
  }
  return found;
}

/** macOS: `ps -E` appends the env to the command line. Best effort: paths with spaces split. */
function fromPs(only?: number[]): RunningProcess[] {
  let output: string;
  const which = only ? ["-p", only.join(",")] : ["-ax"];
  try {
    output = execFileSync("ps", ["-Eww", ...which, "-o", "pid=,command="], { encoding: "utf8" });
  } catch {
    return [];
  }
  return output.split("\n").flatMap((line) => {
    const [pid, ...words] = line.trim().split(/\s+/);
    if (!pid || !/^\d+$/.test(pid)) return [];
    const firstEnv = words.findIndex((word, index) => index > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
    const argv = firstEnv === -1 ? words : words.slice(0, firstEnv);
    const env = firstEnv === -1 ? {} : parseEnv(words.slice(firstEnv));
    return [{ pid: Number(pid), argv, env }];
  });
}

/** Every process of this user, or only those of `pids`. */
export function runningProcesses(pids?: number[]): RunningProcess[] {
  if (pids?.length === 0) return [];
  return fromProc(pids) ?? fromPs(pids);
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** `/usr/lib/node_modules/codex/bin/codex.js` → `codex`. */
export const programName = (arg: string) => basename(arg).replace(/\.(c|m)?js$|\.exe$/, "");

/**
 * Processes of `binary` launched with `envName` set to `dir`: the sessions
 * still reading and writing that seat folder. With `fallback`, the folder the
 * CLI uses when `envName` isn't set (its live path), a process without it
 * counts too when `fallback` leads to `dir`. Never includes this process.
 */
export function processesUsing(
  binary: string,
  envName: string,
  dir: string,
  list: () => RunningProcess[] = runningProcesses,
  fallback?: string,
): RunningProcess[] {
  const target = real(dir);
  const folder = (item: RunningProcess) => item.env[envName] ?? fallback;
  return list().filter((item) => {
    const used = folder(item);
    return (
      item.pid !== process.pid &&
      used !== undefined &&
      real(used) === target &&
      item.argv.some((arg) => programName(arg) === binary)
    );
  });
}
