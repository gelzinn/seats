import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import pc from "picocolors";
import { type HistoryKind, type HistoryReport, historyPlans, setHistorySharing } from "../history.ts";
import { readConfig } from "../store.ts";
import { fail, tilde } from "./ui.ts";

const USAGE = `Share memory or conversations between the seats of a tool. Both are off by default.

Usage:
  seats share                          Show what is shared
  seats share memory on|off|status     Per-project memory: what Claude learned in a project
  seats share sessions on|off|status   Conversations (resume, rewind), memory with them
  --dry-run                            List what would move, link, copy and back up

Examples:
  seats share memory on --dry-run
  seats share sessions on
  seats exclude claude:acme sessions`;

/** Lines past this are counted, not listed, outside a dry run. */
const SHOWN = 10;

const ids = (folders: { id: string }[]) => folders.map((folder) => folder.id).join(", ") || "none";

/** Who shares what, tool by tool. */
function status(home: string): string[] {
  const config = readConfig(home);
  const lines = [
    `Memory: ${config.shareMemory ? pc.green("on") : "off"}   Conversations: ${config.shareSessions ? pc.green("on") : "off"}`,
  ];
  for (const plan of historyPlans(home, config)) {
    if (plan.sessions.length + plan.memory.length + plan.own.length === 0) continue;
    lines.push("");
    if (plan.sessions.length > 0) lines.push(`${plan.source.id}  conversations and memory: ${ids(plan.sessions)}`);
    if (plan.memory.length > 0) lines.push(`${plan.source.id}  memory only: ${ids(plan.memory)}`);
    lines.push(`${plan.source.id}  their own: ${ids(plan.own)}`);
    if (plan.sessions.length + plan.memory.length > 0)
      lines.push(pc.dim(`shared copy: ${tilde(join(plan.root, plan.history.projects))}`));
  }
  return lines;
}

function section(title: string, paths: string[], all: boolean): void {
  if (paths.length === 0) return;
  console.log(`\n${pc.bold(title)}`);
  for (const path of all ? paths : paths.slice(0, SHOWN)) console.log(`  ${tilde(path)}`);
  if (!all && paths.length > SHOWN) console.log(pc.dim(`  …and ${paths.length - SHOWN} more`));
}

function printReport(report: HistoryReport, dryRun: boolean): void {
  const verb = (now: string, later: string) => (dryRun ? later : now);
  section(verb("Merged into the shared copy", "Would merge into the shared copy"), report.moved, dryRun);
  section(verb("Linked", "Would link"), report.linked, dryRun);
  section(verb("Copied back into the seat", "Would copy back into the seat"), report.copied, dryRun);
  section(
    verb("Older copies kept as *.seats-backup", "Differ between seats: the newest wins, the others are backed up"),
    report.backups,
    true,
  );
}

/** Who sees every conversation or memory once it's on: the privacy line of `on`. */
function audience(home: string, kind: HistoryKind): string[] {
  return historyPlans(home).flatMap((plan) => {
    const seats = kind === "sessions" ? plan.sessions : [...plan.sessions, ...plan.memory];
    return seats.length > 0 ? [ids(seats)] : [];
  });
}

/** `seats share [memory|sessions] [on|off|status] [--dry-run]` */
export async function shareCommand(argv: string[]): Promise<void> {
  const dryRun = argv.includes("--dry-run");
  const [kind, mode = "status", ...extra] = argv.filter((arg) => !arg.startsWith("--"));
  const home = homedir();
  if (argv.includes("--help") || argv.includes("-h") || extra.length > 0) return console.log(USAGE);
  if (!kind) return console.log(status(home).join("\n"));
  if (kind !== "memory" && kind !== "sessions") return console.log(USAGE);
  if (mode === "status") return console.log(status(home).join("\n"));
  if (mode !== "on" && mode !== "off") fail(`Use seats share ${kind} on, off or status.`);

  const on = mode === "on";
  let report: HistoryReport;
  try {
    report = setHistorySharing(home, kind, on, { dryRun });
  } catch (error) {
    fail((error as Error).message);
  }
  printReport(report, dryRun);
  console.log("");
  const what = kind === "memory" ? "Memory" : "Conversations and memory";
  if (dryRun) return console.log(pc.dim("Dry run: nothing was changed."));
  if (on) {
    const are = kind === "memory" ? "is" : "are";
    for (const seats of audience(home, kind)) console.log(`${what} ${are} shared between ${seats}.`);
    console.log(
      pc.yellow(
        `Every one of those accounts now sees ${kind === "memory" ? "what Claude remembers about" : "every conversation in"} every project. Keep a seat out with seats exclude <seat> ${kind}.`,
      ),
    );
    return;
  }
  console.log(`${what} ${kind === "memory" ? "is" : "are"} no longer shared; each seat has a copy of what it saw.`);
  const config = readConfig(home);
  if (kind === "memory" && config.shareSessions)
    console.log(pc.dim("Conversations are still shared, and the memory inside them with them."));
  for (const plan of historyPlans(home, config)) {
    const shared = join(plan.root, plan.history.projects);
    if (existsSync(shared)) console.log(pc.dim(`The shared copy stays in ${tilde(shared)}.`));
  }
}
