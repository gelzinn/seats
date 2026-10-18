import { homedir } from "node:os";
import { basename, join } from "node:path";
import pc from "picocolors";
import { isSymlink, lexists } from "../fs.ts";
import { discoverSeatDirs } from "../home-dirs.ts";
import { type InstructionsReport, syncInstructions } from "../instructions.ts";
import { type McpSyncReport, syncMcp } from "../mcp/library.ts";
import { instructionsTargets, providers, seatSources, skillsTargets } from "../providers/index.ts";
import { shareItems } from "../share.ts";
import { type SkillsReport, syncSkills } from "../skills.ts";
import { sharedDir } from "../store.ts";
import { tilde } from "./ui.ts";

export type SyncReport = { linked: string[]; backups: string[]; merged: string[] };

/**
 * Shares config between seats of the same source. Providers with a single
 * seat are left alone: there is nothing to share and no reason to move files.
 * A dry run lists the seat items that would move into the shared folder.
 */
export function syncSeats(home: string, only?: string[], { dryRun = false } = {}): SyncReport {
  const report: SyncReport = { linked: [], backups: [], merged: [] };

  for (const source of seatSources) {
    if (!source.livePath || !source.sharedItems) continue;
    if (only && !only.includes(source.id)) continue;

    const liveName = basename(source.livePath(home));
    const dirs = discoverSeatDirs(home, source.id, liveName).map((item) => item.dir);
    if (dirs.length < 2) continue;

    if (dryRun) {
      for (const item of source.sharedItems) {
        const pending = dirs.map((dir) => join(dir, item)).filter((path) => lexists(path) && !isSymlink(path));
        report.linked.push(...pending);
      }
      continue;
    }

    const shared = shareItems(dirs, sharedDir(home, source.id), source.sharedItems);
    report.linked.push(...shared.linked);
    report.backups.push(...shared.backups);
    report.merged.push(...(source.mergeSeats?.(dirs) ?? []));
  }

  return report;
}

export type FullSyncReport = {
  seats: SyncReport;
  mcp: McpSyncReport;
  skills: SkillsReport;
  instructions: InstructionsReport;
};

/** `seats sync`: seats of the same provider, then MCP servers, skills and instructions across tools. */
export function syncAll(home: string, { dryRun = false } = {}): FullSyncReport {
  const seats = syncSeats(home, undefined, { dryRun });
  const mcp = syncMcp(home, { dryRun });
  const skills = syncSkills(home, skillsTargets, { dryRun });
  const instructions = syncInstructions(home, instructionsTargets, { dryRun });
  // MCP servers just written to the active seat (e.g. ~/.claude.json) reach that tool's other seats.
  const remerge = providers
    .filter((provider) => mcp.added.some((item) => item.startsWith(`${provider.id}: `)))
    .flatMap((provider) => provider.seats ?? [])
    .filter((source) => source.mergeSeats)
    .map((source) => source.id);
  if (!dryRun && remerge.length > 0) seats.merged.push(...syncSeats(home, remerge).merged);
  return { seats, mcp, skills, instructions };
}

/** Groups `tool: name` entries into one line per tool. */
function byTool(items: string[]): string[] {
  const groups = new Map<string, string[]>();
  for (const item of items) {
    const [tool, ...rest] = item.split(": ");
    groups.set(tool!, [...(groups.get(tool!) ?? []), rest.join(": ")]);
  }
  return [...groups].map(([tool, names]) => `${tool.padEnd(16)} ${names.join(", ")}`);
}

function printSync(report: FullSyncReport, dryRun: boolean): void {
  const section = (title: string, lines: string[]) => {
    if (lines.length === 0) return;
    console.log(`\n${pc.bold(title)}`);
    for (const line of lines) console.log(`  ${line}`);
  };
  const { seats, mcp, skills, instructions } = report;
  const verb = dryRun ? "would " : "";

  section("Seats", [
    ...seats.linked.map((path) => `${dryRun ? "share" : "linked"} ${tilde(path)}`),
    ...seats.merged.map((path) => `merged ${tilde(path)}`),
    ...seats.backups.map((path) => pc.dim(`kept ${tilde(path)}`)),
  ]);
  section("MCP servers", [
    ...(mcp.imported.length > 0 ? [`library  ${verb}add ${mcp.imported.join(", ")}`] : []),
    ...byTool(mcp.added).map((line) => `${pc.green("+")} ${line}`),
    ...byTool(mcp.warnings).map((line) => pc.yellow(`! ${line}`)),
    ...mcp.failed.map((tool) => pc.red(`could not read ${tool}`)),
  ]);
  section("Skills", [
    ...(skills.imported.length > 0 ? [`library  ${verb}add ${skills.imported.join(", ")}`] : []),
    ...byTool(skills.linked).map((line) => `${pc.green("+")} ${line}`),
    ...byTool(skills.conflicts).map((line) => pc.yellow(`! same name, different skill: ${line}`)),
  ]);
  section("Instructions", [
    ...(instructions.linked.length > 0
      ? [`${verb}link to ~/.config/seats/shared/AGENTS.md: ${instructions.linked.join(", ")}`]
      : []),
    ...(instructions.conflicts.length > 0
      ? [pc.yellow(`! different text, left alone: ${instructions.conflicts.join(", ")}`)]
      : []),
  ]);

  const changes = [
    seats.linked,
    seats.merged,
    mcp.imported,
    mcp.added,
    skills.imported,
    skills.linked,
    instructions.linked,
  ];
  const empty = changes.every((list) => list.length === 0);
  console.log(empty ? "Everything is already in sync." : dryRun ? pc.dim("\nDry run: nothing was changed.") : "");
}

/** `seats sync [--dry-run]` */
export async function syncCommand(args: string[]): Promise<void> {
  const dryRun = args.includes("--dry-run");
  printSync(syncAll(homedir(), { dryRun }), dryRun);
}
