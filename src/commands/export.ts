import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import pc from "picocolors";
import { version } from "../../package.json";
import {
  isDirectory,
  isInside,
  isSymlink,
  lexists,
  linkTarget,
  replacePathPrefix,
  replaceSymlink,
  writeTextAtomic,
} from "../fs.ts";
import { discoverSeatDirs } from "../home-dirs.ts";
import { seatSources } from "../providers/index.ts";
import { type EnvVar, findLeaks, type Secret, scrubJson, secretCollector } from "../secrets.ts";
import { deepFill, isRecord, parseRecord } from "../share.ts";
import { entries, skillsLibrary } from "../skills.ts";
import { seatsHome, sharedDir } from "../store.ts";
import type { PortableText, SecretRef } from "../types.ts";
import { printSync, syncAll } from "./sync.ts";
import { fail, tilde } from "./ui.ts";

type Json = Record<string, unknown>;

export const MANIFEST = "seats-export.json";
/** What an export writes at its root. Anything else in the folder, such as a `.git`, is kept. */
const EXPORT_ENTRIES = [MANIFEST, "shared", "skills"];

/** A symlink, kept as a record. Both paths are relative to the export root. */
export type ExportLink = { path: string; target: string };

export type ExportManifest = {
  seats: string;
  exportedAt: string;
  /** Every file in the export, relative to its root. */
  paths: string[];
  links: ExportLink[];
  /** Variables to define on the new machine. Names only. */
  env: EnvVar[];
  /** What was left out because it only holds on this machine. */
  dropped: string[];
  /** Files whose home folder was written as `~`, expanded again on import. */
  homePaths: string[];
};

export type ExportPlan = {
  files: Map<string, Buffer>;
  links: ExportLink[];
  /** Source paths left out, with the reason. */
  skipped: string[];
  dropped: string[];
  homePaths: string[];
  secrets: Secret[];
  env: EnvVar[];
};

/** Backups and side files seats writes, temp files from atomic writes, and git metadata. */
const isLeftover = (name: string) => /\.seats-(backup|import)|\.seats-\d+$/.test(name) || name === ".git";

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Everything `seats export` would write, read from `shared/` and the skills
 * library: secrets taken out, machine-only items left out, the home folder as `~`.
 */
export function planExport(home: string): ExportPlan {
  const plan: ExportPlan = {
    files: new Map(),
    links: [],
    skipped: [],
    dropped: [],
    homePaths: [],
    secrets: [],
    env: [],
  };
  const collector = secretCollector();
  const shared = join(seatsHome(home), "shared");
  const library = skillsLibrary(home);

  const addFile = (rel: string, source: string, portable?: (text: string, secret: SecretRef) => PortableText) => {
    let data = readFileSync(source);
    try {
      if (portable) {
        const result = portable(data.toString("utf8"), collector.ref(rel));
        data = Buffer.from(result.text);
        plan.dropped.push(...result.dropped.map((what) => `${rel}: ${what}`));
      } else if (rel.endsWith(".json")) {
        const before = JSON.parse(data.toString("utf8"));
        const after = scrubJson(before, rel, collector);
        if (JSON.stringify(after) !== JSON.stringify(before)) data = Buffer.from(`${JSON.stringify(after, null, 2)}\n`);
      }
    } catch (error) {
      // A file seats can't read could hold anything, so it stays behind.
      plan.skipped.push(`${tilde(source)} (${reason(error)})`);
      return;
    }
    if (/\.(json|toml)$/.test(rel)) {
      const text = data.toString("utf8");
      const moved = replacePathPrefix(text, home, "~");
      if (moved !== text) {
        data = Buffer.from(moved);
        plan.homePaths.push(rel);
      }
    }
    plan.files.set(rel, data);
  };

  /** Where a link points inside the export, or undefined when it leaves what's exported. */
  const exported = (target: string) =>
    isInside(target, shared)
      ? join("shared", relative(shared, target))
      : isInside(target, library)
        ? join("skills", relative(library, target))
        : undefined;

  // `follow` copies what links point at, as for the library; otherwise links are recorded.
  const copy = (source: string, rel: string, follow: boolean) => {
    if (isSymlink(source) && !follow) {
      const target = exported(linkTarget(source)!);
      if (target) plan.links.push({ path: rel, target });
      else plan.skipped.push(`${tilde(source)} (links outside seats)`);
    } else if (!existsSync(source)) {
      plan.skipped.push(`${tilde(source)} (broken link)`);
    } else if (statSync(source).isDirectory()) {
      for (const name of readdirSync(source).sort()) {
        if (!isLeftover(name)) copy(join(source, name), join(rel, name), follow);
      }
    } else {
      addFile(rel, source);
    }
  };

  for (const name of ["mcp.json", "AGENTS.md"]) {
    if (lexists(join(shared, name))) copy(join(shared, name), join("shared", name), false);
  }
  for (const source of seatSources) {
    for (const item of source.sharedItems ?? []) {
      const path = join(sharedDir(home, source.id), item);
      const rel = join("shared", source.id, item);
      const portable = source.exportFiles?.[item];
      if (!lexists(path)) continue;
      if (source.machineItems?.includes(item)) plan.dropped.push(rel);
      else if (portable && !isSymlink(path)) addFile(rel, path, portable);
      else copy(path, rel, false);
    }
  }
  for (const name of entries(library)) copy(join(library, name), join("skills", name), true);

  plan.secrets = collector.secrets;
  plan.env = collector.vars;
  return plan;
}

function manifestOf(plan: ExportPlan): ExportManifest {
  return {
    seats: version,
    exportedAt: new Date().toISOString(),
    paths: [...plan.files.keys()].sort(),
    links: plan.links,
    env: plan.env,
    dropped: plan.dropped,
    homePaths: plan.homePaths,
  };
}

/** The target must be empty or hold a previous export, and be apart from what it exports. */
export function checkTarget(home: string, target: string): void {
  for (const root of [seatsHome(home), skillsLibrary(home)]) {
    if (isInside(target, root) || isInside(root, target)) {
      throw new Error(`${tilde(target)} overlaps ${tilde(root)}. Export to another folder.`);
    }
  }
  if (!lexists(target)) return;
  if (!existsSync(target) || !statSync(target).isDirectory()) throw new Error(`${tilde(target)} isn't a folder.`);
  const names = readdirSync(target);
  if (names.length > 0 && !names.includes(MANIFEST)) {
    throw new Error(`${tilde(target)} isn't empty and doesn't hold a seats export. Pick an empty folder.`);
  }
}

/** Every file under `dir`, by path relative to it. */
function readTree(dir: string, rel = "", files = new Map<string, Buffer>()): Map<string, Buffer> {
  for (const name of readdirSync(join(dir, rel))) {
    const path = join(rel, name);
    if (isDirectory(join(dir, path))) readTree(dir, path, files);
    else if (!isSymlink(join(dir, path))) files.set(path, readFileSync(join(dir, path)));
  }
  return files;
}

function leakCheck(files: Map<string, Buffer>, secrets: Secret[]): void {
  const leaks = findLeaks(files, secrets);
  if (leaks.length === 0) return;
  const where = leaks.map(({ name, file }) => `${name} in ${file}`).join(", ");
  throw new Error(
    `Export stopped: a secret is still in the export (${where}). Use a reference such as \${TOKEN} there, then export again.`,
  );
}

/**
 * Writes the export, then scans the written files for every secret taken
 * out. It's built next to the target and moved in only once the scan passes,
 * so a failed export leaves nothing behind and a previous export intact.
 */
export function writeExport(home: string, dir: string, plan: ExportPlan): ExportManifest {
  const target = resolve(dir);
  checkTarget(home, target);
  mkdirSync(dirname(target), { recursive: true });
  const staging = mkdtempSync(join(dirname(target), `.${basename(target)}.seats-`));
  try {
    const manifest = manifestOf(plan);
    for (const [rel, data] of plan.files) {
      mkdirSync(dirname(join(staging, rel)), { recursive: true });
      writeFileSync(join(staging, rel), data);
    }
    writeFileSync(join(staging, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    leakCheck(readTree(staging), plan.secrets);

    mkdirSync(target, { recursive: true });
    for (const name of EXPORT_ENTRIES) rmSync(join(target, name), { recursive: true, force: true });
    for (const name of readdirSync(staging)) renameSync(join(staging, name), join(target, name));
    return manifest;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export type ImportPlan = {
  /** New files, JSON merged with the local copy winning, and `.seats-import` copies next to local files. */
  writes: Array<{ path: string; data: Buffer; kind: "add" | "merge" | "side" }>;
  links: Array<{ path: string; target: string }>;
  skills: Array<{ from: string; to: string }>;
  /** Local entries kept as they are although the export has something else. */
  kept: string[];
  /** Export entries left out: symlinks, and links that would leave seats' folders. */
  skipped: string[];
  env: EnvVar[];
};

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** A relative path under one of `roots`, without `..`: an export may come from someone else's repo. */
const safePath = (path: unknown, ...roots: string[]): path is string =>
  typeof path === "string" &&
  !isAbsolute(path) &&
  !path.split(/[\\/]/).includes("..") &&
  roots.some((root) => path.startsWith(`${root}/`));

function readManifest(dir: string): ExportManifest {
  try {
    const data = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8"));
    if (isRecord(data)) return data as ExportManifest;
  } catch {
    // reported below
  }
  throw new Error(`${tilde(dir)} isn't a seats export: ${MANIFEST} is missing.`);
}

/**
 * Local wins every conflict, since the local copy may hold the real secrets.
 * An MCP server the local file already has, by name ignoring case, is left out
 * entirely, as `seats sync` does.
 */
function mergeLocalWins(local: Json, imported: Json, file: string, kept: string[]): Json {
  if (isRecord(local.mcpServers) && isRecord(imported.mcpServers)) {
    const mine = new Map(Object.entries(local.mcpServers).map(([name, server]) => [name.toLowerCase(), server]));
    const fresh = Object.entries(imported.mcpServers).filter(([name, server]) => {
      if (!mine.has(name.toLowerCase())) return true;
      if (JSON.stringify(mine.get(name.toLowerCase())) !== JSON.stringify(server)) kept.push(`${tilde(file)}: ${name}`);
      return false;
    });
    imported = { ...imported, mcpServers: Object.fromEntries(fresh) };
  }
  return deepFill(local, imported) as Json;
}

function planFile(local: string, data: Buffer, plan: ImportPlan): void {
  if (!lexists(local)) {
    plan.writes.push({ path: local, data, kind: "add" });
    return;
  }
  if (!existsSync(local) || statSync(local).isDirectory()) {
    plan.kept.push(tilde(local));
    return;
  }
  const mine = readFileSync(local);
  if (mine.equals(data)) return;

  const localJson = parseRecord(mine);
  const importedJson = parseRecord(data);
  if (localJson && importedJson) {
    const merged = mergeLocalWins(localJson, importedJson, local, plan.kept);
    if (JSON.stringify(merged) === JSON.stringify(localJson)) return;
    plan.writes.push({ path: local, data: Buffer.from(`${JSON.stringify(merged, null, 2)}\n`), kind: "merge" });
    return;
  }

  const side = `${local}.seats-import`;
  if (existsSync(side) && readFileSync(side).equals(data)) return;
  plan.writes.push({ path: side, data, kind: "side" });
}

/** Same files with the same bytes, ignoring git metadata. */
function sameTree(a: string, b: string): boolean {
  const files = (dir: string, rel = ""): string[] =>
    readdirSync(join(dir, rel))
      .filter((name) => name !== ".git")
      .flatMap((name) =>
        statSync(join(dir, rel, name)).isDirectory() ? files(dir, join(rel, name)) : [join(rel, name)],
      )
      .sort();
  try {
    const left = files(a);
    const right = files(b);
    return (
      left.length === right.length &&
      left.every((rel, i) => rel === right[i] && readFileSync(join(a, rel)).equals(readFileSync(join(b, rel))))
    );
  } catch {
    return false;
  }
}

function symlinksUnder(dir: string, rel: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (isSymlink(path)) return [join(rel, name)];
    return isDirectory(path) ? symlinksUnder(path, join(rel, name)) : [];
  });
}

/** What `seats import` would change. Nothing local is replaced. */
export function planImport(home: string, dir: string): ImportPlan {
  const root = resolve(dir);
  const manifest = readManifest(root);
  const plan: ImportPlan = { writes: [], links: [], skills: [], kept: [], skipped: [], env: [] };
  const homePaths = new Set(list(manifest.homePaths));
  const store = seatsHome(home);
  const library = skillsLibrary(home);

  const visit = (path: string, rel: string) => {
    if (isSymlink(path)) {
      plan.skipped.push(rel);
    } else if (isDirectory(path)) {
      for (const name of readdirSync(path).sort()) visit(join(path, name), join(rel, name));
    } else {
      let data = readFileSync(path);
      if (homePaths.has(rel)) data = Buffer.from(replacePathPrefix(data.toString("utf8"), "~", home));
      planFile(join(store, rel), data, plan);
    }
  };
  if (lexists(join(root, "shared"))) visit(join(root, "shared"), "shared");

  for (const raw of list(manifest.links)) {
    const link = isRecord(raw) ? raw : {};
    if (!safePath(link.path, "shared") || !safePath(link.target, "shared", "skills")) {
      plan.skipped.push(String(link.path));
      continue;
    }
    const path = join(store, link.path);
    const target = link.target.startsWith("skills/")
      ? join(library, link.target.slice("skills/".length))
      : join(store, link.target);
    if (!lexists(path)) plan.links.push({ path, target });
    else if (linkTarget(path) !== target) plan.kept.push(tilde(path));
  }

  for (const name of entries(join(root, "skills"))) {
    const from = join(root, "skills", name);
    const to = join(library, name);
    if (isSymlink(from) || !isDirectory(from)) {
      plan.skipped.push(join("skills", name));
      continue;
    }
    plan.skipped.push(...symlinksUnder(from, join("skills", name)));
    if (!lexists(to)) plan.skills.push({ from, to });
    else if (!sameTree(from, to)) plan.kept.push(`skill ${name}`);
  }

  plan.env = list(manifest.env).filter((item): item is EnvVar => isRecord(item) && typeof item.name === "string");
  return plan;
}

/**
 * Files added from an export get an old timestamp. When sync then merges a
 * seat's own copy into `shared/`, the seat's copy is the newer one and wins.
 */
const LONG_AGO = new Date(0);

export function applyImport(plan: ImportPlan): void {
  for (const { path, data, kind } of plan.writes) {
    if (kind === "merge") {
      writeTextAtomic(path, data.toString("utf8"));
      continue;
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, data, { mode: 0o600 });
    if (kind === "add") utimesSync(path, LONG_AGO, LONG_AGO);
  }
  for (const { path, target } of plan.links) {
    mkdirSync(dirname(path), { recursive: true });
    replaceSymlink(path, target);
  }
  for (const { from, to } of plan.skills) {
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true, filter: (path) => !isSymlink(path) });
  }
}

/** Tools whose imported settings reach no seat yet: sync shares a tool's folder between two or more seats. */
function unsharedTools(home: string, plan: ImportPlan): string[] {
  const touched = [...plan.writes, ...plan.links].map((item) => item.path);
  return seatSources
    .filter((source) => {
      if (!source.livePath || !touched.some((path) => isInside(path, sharedDir(home, source.id)))) return false;
      return discoverSeatDirs(home, source.id, basename(source.livePath(home))).length < 2;
    })
    .map((source) => source.id);
}

/** Missing env vars of an export, once each. */
export const missingVars = (env: EnvVar[]) =>
  [...new Set(env.map((item) => item.name))].filter((name) => !process.env[name]);

function section(title: string, lines: string[]): void {
  if (lines.length === 0) return;
  console.log(`\n${pc.bold(title)}`);
  for (const line of lines) console.log(`  ${line}`);
}

function printExport(plan: ExportPlan, target: string, dryRun: boolean): void {
  const skills = new Set(
    [...plan.files.keys()].filter((rel) => rel.startsWith("skills/")).map((rel) => rel.split("/")[1]),
  );
  const files = plan.files.size - [...plan.files.keys()].filter((rel) => rel.startsWith("skills/")).length;
  const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  console.log(
    `${dryRun ? "Would export" : "Exported"} ${count(files, "shared file")} and ${count(skills.size, "skill")} to ${tilde(target)}`,
  );
  section(
    "Secrets taken out",
    plan.env.map(({ name, file, dropped }) => (dropped ? `${name}  dropped from ${file}` : `\${${name}}  in ${file}`)),
  );
  section("Left out (only valid on this machine)", plan.dropped);
  section(
    "Skipped",
    plan.skipped.map((line) => pc.yellow(`! ${line}`)),
  );
  const names = [...new Set(plan.env.map((item) => item.name))];
  if (names.length > 0) console.log(`\nDefine these on the new machine: ${names.join(", ")}`);
  if (dryRun) console.log(pc.dim("\nDry run: nothing was written."));
}

function printImport(plan: ImportPlan, dryRun: boolean): void {
  const verb = dryRun ? "would " : "";
  section("Import", [
    ...plan.writes
      .filter((item) => item.kind !== "side")
      .map(({ path, kind }) => `${pc.green("+")} ${verb}${kind === "add" ? "add" : "merge into"} ${tilde(path)}`),
    ...plan.links.map(({ path }) => `${pc.green("+")} ${verb}link ${tilde(path)}`),
    ...plan.skills.map(({ to }) => `${pc.green("+")} ${verb}add skill ${basename(to)}`),
    ...plan.writes
      .filter((item) => item.kind === "side")
      .map(({ path }) => pc.yellow(`! kept yours, ${verb}save the export's copy as ${tilde(path)}`)),
    ...plan.kept.map((what) => pc.yellow(`! kept yours: ${what}`)),
    ...plan.skipped.map((what) => pc.dim(`skipped ${what} (a symlink in the export)`)),
  ]);
}

function folderArg(args: string[], command: string): string {
  const dir = args.find((arg) => !arg.startsWith("--"));
  return dir ?? fail(`Usage: seats ${command} <folder> [--dry-run]`);
}

/** `seats export`, for the user's `home`. Throws, writing nothing, when the folder is refused or a secret survives. */
export function runExport(home: string, folder: string, dryRun: boolean): void {
  const target = resolve(folder);
  const plan = planExport(home);
  if (dryRun) {
    checkTarget(home, target);
    leakCheck(plan.files, plan.secrets);
  } else {
    writeExport(home, target, plan);
  }
  printExport(plan, target, dryRun);
}

/** `seats import`, for the user's `home`: the export's files, then the same sync as `seats sync`. */
export function runImport(home: string, folder: string, dryRun: boolean): void {
  const plan = planImport(home, folder);
  if (!dryRun) applyImport(plan);
  printImport(plan, dryRun);
  if (dryRun)
    console.log(
      pc.dim("\nThe sync preview below reads your current files; without --dry-run it runs on the imported ones."),
    );
  printSync(syncAll(home, { dryRun }), dryRun);

  const unshared = unsharedTools(home, plan);
  if (unshared.length > 0) {
    console.log(pc.dim(`${unshared.join(", ")}: settings in shared/ reach a tool's seats once it has two or more.`));
  }
  const missing = missingVars(plan.env);
  if (missing.length > 0) {
    console.log(pc.yellow(`Define these env vars, which the imported config uses: ${missing.join(", ")}`));
  }
}

/** `seats export <folder> [--dry-run]` */
export async function exportCommand(args: string[]): Promise<void> {
  runExport(homedir(), folderArg(args, "export"), args.includes("--dry-run"));
}

/** `seats import <folder> [--dry-run]` */
export async function importCommand(args: string[]): Promise<void> {
  runImport(homedir(), folderArg(args, "import"), args.includes("--dry-run"));
}
