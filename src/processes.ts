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

/** Linux: every process of this user, from `/proc`. Undefined where there's no `/proc`. */
function fromProc(): RunningProcess[] | undefined {
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
  } catch {
    return undefined;
  }
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
function fromPs(): RunningProcess[] {
  let output: string;
  try {
    output = execFileSync("ps", ["-Eww", "-axo", "pid=,command="], { encoding: "utf8" });
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

export function runningProcesses(): RunningProcess[] {
  return fromProc() ?? fromPs();
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** `/usr/lib/node_modules/codex/bin/codex.js` → `codex`. */
const programName = (arg: string) => basename(arg).replace(/\.(c|m)?js$|\.exe$/, "");

/**
 * Processes of `binary` launched with `envName` set to `dir`: the sessions
 * still reading and writing that seat folder. Never includes this process.
 */
export function processesUsing(
  binary: string,
  envName: string,
  dir: string,
  list: () => RunningProcess[] = runningProcesses,
): RunningProcess[] {
  const target = real(dir);
  return list().filter(
    (item) =>
      item.pid !== process.pid &&
      item.env[envName] !== undefined &&
      real(item.env[envName]) === target &&
      item.argv.some((arg) => programName(arg) === binary),
  );
}
