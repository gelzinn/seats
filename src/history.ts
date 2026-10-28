import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join, relative } from "node:path";
import { type SeatFolder, seatFolders } from "./exclude.ts";
import { isDirectory, isSymlink, lexists, linkTarget, moveTree } from "./fs.ts";
import { processesUsing, type RunningProcess, runningProcesses } from "./processes.ts";
import { seatSources } from "./providers/index.ts";
import { backupPath, sameFile, shareItems } from "./share.ts";
import { readConfig, type SeatsConfig, sharedDir, writeConfig } from "./store.ts";
import type { SeatSource } from "./types.ts";

export type HistoryKind = "memory" | "sessions";

type History = NonNullable<SeatSource["history"]>;

/** Who shares what for one tool: conversations (memory with them), memory alone, or neither. */
export type HistoryPlan = {
  home: string;
  source: SeatSource;
  history: History;
  /** `shared/<tool>`: shared conversations land in `projects/` there, shared memory in `projects/<folder>/memory`. */
  root: string;
  sessions: SeatFolder[];
  memory: SeatFolder[];
  own: SeatFolder[];
};

/**
 * Which seats of `source` share conversations and which share only memory,
 * from `config`. A seat that keeps its own memory keeps its own
 * conversations too: they hold the memory folders.
 */
export function historyPlan(
  home: string,
  source: SeatSource,
  config: SeatsConfig = readConfig(home),
  folders: SeatFolder[] = seatFolders(home, source),
): HistoryPlan | undefined {
  const history = source.history;
  if (!history) return undefined;
  const ownMemory = config.ownMemory ?? [];
  const ownSessions = config.ownSessions ?? [];
  const sessions = config.shareSessions
    ? folders.filter((folder) => !ownMemory.includes(folder.id) && !ownSessions.includes(folder.id))
    : [];
  const memory = config.shareMemory
    ? folders.filter((folder) => !sessions.includes(folder) && !ownMemory.includes(folder.id))
    : [];
  const own = folders.filter((folder) => !sessions.includes(folder) && !memory.includes(folder));
  return { home, source, history, root: sharedDir(home, source.id), sessions, memory, own };
}

export const historyPlans = (home: string, config?: SeatsConfig) =>
  seatSources.flatMap((source) => historyPlan(home, source, config) ?? []);

function list(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** Project folders under `projects` that hold a memory folder, or a link to one. */
function memoryFolders(projects: string, memory: string): string[] {
  return list(projects).filter((name) => lexists(join(projects, name, memory)));
}

/** Seat paths of the shared memory items: `projects/<folder>/memory`, one per project anyone has memory for. */
function memoryItems(plan: HistoryPlan, extra: string[] = []): string[] {
  const { history, root } = plan;
  const names = new Set([
    ...extra,
    ...memoryFolders(join(root, history.projects), history.memory),
    // A seat whose `projects` leads to the shared one has nothing of its own here.
    ...plan.memory
      .filter((folder) => !isSymlink(join(folder.dir, history.projects)))
      .flatMap((folder) => memoryFolders(join(folder.dir, history.projects), history.memory)),
  ]);
  return [...names].sort().map((name) => join(history.projects, name, history.memory));
}

export type HistoryReport = {
  /** Seat folders and files merged into the shared copy. */
  moved: string[];
  /** Seat paths that now link to the shared copy. */
  linked: string[];
  /** Copies that lost to a newer one, kept as `*.seats-backup`. Dry run: the paths that differ between seats. */
  backups: string[];
  /** Links replaced by a real copy, so the seat keeps what it saw. */
  copied: string[];
  /** A seat's own copy moved aside before it shares again. */
  aside: string[];
};

const emptyReport = (): HistoryReport => ({ moved: [], linked: [], backups: [], copied: [], aside: [] });

/** Real copies of `items` in `dirs` that sharing would merge. */
const realCopies = (dirs: string[], items: string[]) =>
  items.flatMap((item) => dirs.map((dir) => join(dir, item))).filter((path) => lexists(path) && !isSymlink(path));

/** Seat paths of `items` that aren't links to the shared copy yet. */
function unlinked(dirs: string[], root: string, items: string[]): string[] {
  return items.flatMap((item) => {
    const shared = join(root, item);
    const hasShared = lexists(shared) || realCopies(dirs, [item]).length > 0;
    return hasShared ? dirs.map((dir) => join(dir, item)).filter((path) => linkTarget(path) !== shared) : [];
  });
}

/** Every file under `path`, relative to it. */
function filesUnder(path: string, prefix = ""): string[] {
  if (!isDirectory(path)) return lexists(path) && !isSymlink(path) ? [prefix] : [];
  return list(path).flatMap((name) => filesUnder(join(path, name), prefix ? join(prefix, name) : name));
}

/** Files that differ between the real copies of `items` (shared one included): merging backs one side up. */
function conflicts(dirs: string[], root: string, items: string[]): string[] {
  const found = new Set<string>();
  for (const item of items) {
    const copies = [root, ...dirs].map((dir) => join(dir, item)).filter((path) => lexists(path) && !isSymlink(path));
    const seen = new Map<string, string>();
    for (const copy of copies) {
      for (const rel of filesUnder(copy)) {
        const file = rel ? join(copy, rel) : copy;
        const first = seen.get(rel);
        if (!first) seen.set(rel, file);
        else if (statSync(first).size !== statSync(file).size || !readFileSync(first).equals(readFileSync(file)))
          found.add(rel ? join(item, rel) : item);
      }
    }
  }
  return [...found].sort();
}

/** The CLI's processes running on seat folder `dir` right now. Lists processes once, on first use. */
function runningOn(plan: HistoryPlan, processes: () => RunningProcess[]): (dir: string) => RunningProcess[] {
  const { binary, configDirEnv, livePath } = plan.source;
  let listed: RunningProcess[] | undefined;
  const running = () => (listed ??= processes());
  return (dir) =>
    binary && configDirEnv ? processesUsing(binary, configDirEnv, dir, running, livePath?.(plan.home)) : [];
}

/**
 * Links every seat that shares history to the shared copy, merging what it
 * has of its own first: the newest copy of a file wins and the others are
 * kept as `*.seats-backup`. `extra` names project folders to link memory for
 * even before any seat has some (the one a session just opened in). With
 * `processes`, a seat whose CLI is running keeps its own conversations until
 * it's closed, since they'd move under it; memory moves regardless.
 */
export function linkHistory(
  plan: HistoryPlan,
  {
    dryRun = false,
    extra = [] as string[],
    processes,
  }: { dryRun?: boolean; extra?: string[]; processes?: () => RunningProcess[] } = {},
): HistoryReport {
  const report = emptyReport();
  const { history, root } = plan;
  const using = processes ? runningOn(plan, processes) : () => [];
  const busy = (dir: string) => using(dir).length > 0;
  const groups = [
    {
      dirs: plan.sessions
        .map((folder) => folder.dir)
        .filter((dir) => realCopies([dir], history.items).length === 0 || !busy(dir)),
      items: history.items,
      extra: [] as string[],
    },
    {
      dirs: plan.memory.map((folder) => folder.dir).filter((dir) => !isSymlink(join(dir, history.projects))),
      items: plan.memory.length > 0 ? memoryItems(plan, extra) : [],
      extra,
    },
  ];
  for (const group of groups) {
    const { dirs, items } = group;
    if (dirs.length === 0 || items.length === 0) continue;
    report.moved.push(...realCopies(dirs, items));
    if (dryRun) {
      report.linked.push(...unlinked(dirs, root, items));
      report.backups.push(...conflicts(dirs, root, items));
      continue;
    }
    // Every item exists up front, so a seat links even what its CLI hasn't created yet.
    const made = group === groups[0] ? items : group.extra.map((name) => join(history.projects, name, history.memory));
    for (const item of made) {
      if (!lexists(join(root, item))) mkdirSync(join(root, item), { recursive: true, mode: 0o700 });
    }
    const shared = shareItems(dirs, root, items, undefined, { opaque: true });
    report.linked.push(...shared.linked);
    report.backups.push(...shared.backups);
  }
  return report;
}

/** Turns a link to a shared folder into a real copy of it, timestamps kept so resume order holds. */
function ownCopy(path: string): boolean {
  if (!isSymlink(path) || !existsSync(path)) return false;
  const copy = `${path}.seats-copy-${process.pid}`;
  cpSync(realpathSync(path), copy, { recursive: true, preserveTimestamps: true });
  unlinkSync(path);
  renameSync(copy, path);
  return true;
}

/** Memory links in a seat that leads its own `projects`, e.g. one that stopped sharing conversations. */
function memoryLinks(history: History, dir: string, root: string): string[] {
  const projects = join(dir, history.projects);
  if (isSymlink(projects)) return [];
  return memoryFolders(projects, history.memory)
    .map((name) => join(projects, name, history.memory))
    .filter((path) => isSymlink(path) && sameFile(path, join(root, relative(dir, path))));
}

/** Shared items of `history` that `dir` reaches through links into `root`. */
const sharedLinks = (history: History, dir: string, root: string) =>
  history.items
    .filter((item) => isSymlink(join(dir, item)) && sameFile(join(dir, item), join(root, item)))
    .map((item) => join(dir, item));

const ids = (folders: SeatFolder[]) => folders.map((folder) => folder.id);

/** Seats whose conversations would change hands: they start or stop sharing them. */
function movingSessions(before: HistoryPlan, after: HistoryPlan): SeatFolder[] {
  const was = ids(before.sessions);
  const is = ids(after.sessions);
  const moving = [...before.sessions, ...after.sessions].filter(
    (folder) => was.includes(folder.id) !== is.includes(folder.id),
  );
  return moving.filter((folder, index) => moving.findIndex((other) => other.id === folder.id) === index);
}

/**
 * Conversations are appended to while their CLI runs, so they don't move
 * then: a session writing on in a moved-away copy would lose its turns.
 */
function assertIdle(plan: HistoryPlan, folders: SeatFolder[], processes: () => RunningProcess[]): void {
  const using = runningOn(plan, processes);
  const busy = folders.flatMap((folder) => using(folder.dir).map((item) => `${folder.id} (pid ${item.pid})`));
  if (busy.length > 0)
    throw new Error(
      `${plan.source.binary} is running on ${busy.join(", ")}. Close it first: its conversations would move under it.`,
    );
}

export type HistoryOptions = {
  dryRun?: boolean;
  processes?: () => RunningProcess[];
  /** Seat whose own copies move aside, unmerged, before it shares again (`seats include`). */
  aside?: string;
};

/**
 * Moves from `config.json` as it is to `next`: seats that stop sharing get
 * a real copy of what they saw, a seat named by `aside` moves its own copy
 * out of the way, then every seat that shares is linked. Writes `next`.
 */
export function applyHistory(
  home: string,
  next: SeatsConfig,
  { dryRun = false, processes = runningProcesses, aside }: HistoryOptions = {},
): HistoryReport {
  const report = emptyReport();
  const current = readConfig(home);
  const plans = historyPlans(home, current).map((before) => ({
    before,
    after: historyPlan(home, before.source, next)!,
  }));
  for (const { before, after } of plans) assertIdle(after, movingSessions(before, after), processes);

  for (const { before, after } of plans) {
    const { history, root } = after;
    const wasMemory = ids([...before.sessions, ...before.memory]);
    for (const folder of [...after.memory, ...after.own]) {
      const copies = ids(before.sessions).includes(folder.id) ? sharedLinks(history, folder.dir, root) : [];
      // Memory links stay for a seat that keeps sharing memory alone.
      const memory = after.own.includes(folder) && wasMemory.includes(folder.id);
      if (dryRun) {
        report.copied.push(...copies);
        if (memory) report.copied.push(...memoryLinks(history, folder.dir, root));
        continue;
      }
      for (const path of copies) if (ownCopy(path)) report.copied.push(path);
      if (!memory) continue;
      for (const path of memoryLinks(history, folder.dir, root)) if (ownCopy(path)) report.copied.push(path);
    }

    const joining = [...after.sessions, ...after.memory].find((folder) => folder.id === aside);
    if (joining) {
      const items = after.sessions.includes(joining)
        ? history.items
        : memoryFolders(join(joining.dir, history.projects), history.memory).map((name) =>
            join(history.projects, name, history.memory),
          );
      for (const path of realCopies([joining.dir], items)) {
        const saved = backupPath(path);
        if (!dryRun) moveTree(path, saved);
        report.aside.push(saved);
      }
    }

    const linked = linkHistory(after, { dryRun });
    for (const key of ["moved", "linked", "backups"] as const) report[key].push(...linked[key]);
  }
  if (!dryRun) writeConfig(home, next);
  return report;
}

/** Turns sharing of `kind` on or off for every seat that doesn't keep its own. */
export function setHistorySharing(
  home: string,
  kind: HistoryKind,
  on: boolean,
  options: HistoryOptions = {},
): HistoryReport {
  const config = readConfig(home);
  const key = kind === "memory" ? "shareMemory" : "shareSessions";
  return applyHistory(home, { ...config, [key]: on ? true : undefined }, options);
}

/**
 * Links what a running session needs right away: the memory of the project
 * it opened in (`cwd`), and anything new since the last sync. For the
 * session hook and launches. Never throws.
 */
export function linkSessionHistory(home: string, source: SeatSource, dir: string, cwd?: string): void {
  try {
    const config = readConfig(home);
    if (!config.shareMemory && !config.shareSessions) return;
    const plan = historyPlan(home, source, config);
    if (!plan) return;
    const memory = plan.memory.some((folder) => sameFile(folder.dir, dir));
    linkHistory(plan, { extra: memory && cwd ? [plan.history.memoryProject(cwd)] : [], processes: runningProcesses });
  } catch {
    // A session starts whether or not its history could be linked.
  }
}

/** `seats hook session`: the seat the CLI runs on, named by its config dir env var or else its live path. */
export function linkFromSession(home: string, cwd: string | undefined, env: NodeJS.ProcessEnv = process.env): void {
  for (const source of seatSources) {
    if (!source.history || !source.sessionHook || !source.configDirEnv || !source.livePath) continue;
    linkSessionHistory(home, source, env[source.configDirEnv] || source.livePath(home), cwd);
  }
}
