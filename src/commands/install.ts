import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { isInside, isSymlink, lexists, readLink, replaceSymlink, writeJsonAtomic } from "../fs.ts";
import { compact } from "../mcp/convert.ts";
import { forTool, libraryFile, readLibrary, usesEnvRefs } from "../mcp/library.ts";
import type { McpAdapter, McpServer, ToolOptions, ToolOptionValue } from "../mcp/types.ts";
import { mcpAdapters, skillsTargets } from "../providers/index.ts";
import { realPath, skillsLibrary, toolSkillsDirs, type SkillsTarget } from "../skills.ts";
import { fail, intro, table, tilde } from "./ui.ts";

const INSTALL_USAGE = `Install an MCP server or a skill into every tool you have installed.

Usage:
  seats install mcp <name> [--set tool.key=value ...] -- <command> [args...] [--env KEY=VALUE ...]
  seats install mcp <name> --url <url> [--header "Key: Value" ...] [--sse] [--set tool.key=value ...]
  seats install skill <folder | git-url> [--skill <name>]
  seats uninstall mcp <name>
  seats uninstall skill <name>

Options:
  --set tool.key=value  Add a field to one tool's entry only, e.g.
                        codex.startup_timeout_sec=30. Numbers, true/false
                        and JSON string arrays keep their type. Repeatable.
  --skill <name>        Pick one skill when the folder or repo holds several
  --force               Replace a server or skill that is already there
  --dry-run             Show what would change without changing anything

After --, the server's command and args are passed on as is, except
--env KEY=VALUE, --force and --dry-run at the very end, which are seats'.

Examples:
  seats install mcp docs -- npx -y docs-mcp --env TOKEN=your-token
  seats install mcp docs --set codex.startup_timeout_sec=30 -- npx -y docs-mcp
  seats install mcp github --url https://api.example.com/mcp --header "Authorization: Bearer your-token"
  seats install skill ./review
  seats install skill https://github.com/you/review-skill.git
  seats install skill https://github.com/you/skills.git --skill review
  seats uninstall mcp docs`;

/** What happened, or in a dry run would happen, in the library or in one tool. */
export type Status =
  | "added"
  | "replaced"
  | "linked"
  | "removed"
  | "already there"
  | "not there"
  | "reads the library"
  | "skipped"
  | "failed";

export type Outcome = { where: string; status: Status; reason?: string; path?: string };

const lower = (name: string) => name.toLowerCase();
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isTombstone = (server: McpServer) => server.skip?.includes("*") ?? false;

/** Every name in `names` equal to `name`, ignoring case, as syncMcp compares them. */
const matching = (names: string[], name: string) => names.filter((key) => lower(key) === lower(name));

/** Server names Codex accepts; the strictest rule among the tools. */
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
/** A skill name must be one safe folder name: it may come from a cloned repo. */
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SKILL_FILE = "SKILL.md";

// ---------------------------------------------------------------------------
// MCP servers

/** A tool's config file plus each seat's own copy (Claude), once each. */
function toolFiles(adapter: McpAdapter, home: string): string[] {
  const file = adapter.file(home);
  if (!file) return [];
  const seen = new Set<string>();
  return [file, ...(adapter.seatFiles?.(home) ?? [])].filter((path) => {
    const key = realPath(path) ?? path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const sameServer = (a: McpServer, b: McpServer) =>
  Bun.deepEquals(compact({ ...a, skip: undefined }), compact({ ...b, skip: undefined }));

export type McpOptions = { dryRun?: boolean; force?: boolean; adapters?: McpAdapter[] };

/** Library outcome for an install, or an error when the library holds a different server by that name. */
function libraryInstall(name: string, existing: McpServer | undefined, server: McpServer, force: boolean, file: string): Outcome {
  const path = tilde(file);
  if (!existing) return { where: "library", status: "added", path };
  if (isTombstone(existing)) return { where: "library", status: "added", reason: "uninstall mark cleared", path };
  if (sameServer(existing, server)) return { where: "library", status: "already there", path };
  if (force) return { where: "library", status: "replaced", path };
  throw new Error(`${path} already has a different server named ${name}. Use --force to replace it.`);
}

function installInTool(
  adapter: McpAdapter,
  files: string[],
  name: string,
  server: McpServer,
  { force, dryRun, skip }: { force: boolean; dryRun: boolean; skip: string[] },
): Outcome {
  const base = { where: adapter.id, path: tilde(files[0]!) };
  if (adapter.unsupported?.includes(server.type)) {
    return { ...base, status: "skipped", reason: `${adapter.id} doesn't run ${server.type} servers` };
  }
  if (skip.includes(adapter.id)) return { ...base, status: "skipped", reason: "excluded by skip in mcp.json" };
  try {
    const present = files.map((file) => ({ file, names: matching(adapter.names(file), name) }));
    const has = present.some((item) => item.names.length > 0);
    if (has && !force) return { ...base, status: "already there" };
    if (!dryRun) {
      for (const { file, names } of present) {
        if (names.length > 0) adapter.remove(file, names);
        adapter.add(file, forTool({ [name]: server }, adapter.id));
      }
    }
    return { ...base, status: has ? "replaced" : "added" };
  } catch (error) {
    return { ...base, status: "failed", reason: message(error) };
  }
}

/**
 * Writes `server` into the shared library, then into every installed tool in
 * its own format. A tool that already has the name (ignoring case) keeps its
 * entry unless `force`. Installing clears the `skip: ["*"]` uninstall leaves;
 * tools listed in the entry's `skip` stay excluded.
 */
export function installMcp(
  home: string,
  name: string,
  server: McpServer,
  { dryRun = false, force = false, adapters = mcpAdapters }: McpOptions = {},
): Outcome[] {
  const library = readLibrary(home);
  const key = matching(Object.keys(library), name)[0];
  const existing = key ? library[key] : undefined;
  const skip = existing?.skip?.filter((id) => id !== "*") ?? [];

  const saved = libraryInstall(name, existing, server, force, libraryFile(home));
  if (saved.status !== "already there" && !dryRun) {
    if (key) delete library[key];
    library[name] = compact({ ...server, skip: skip.length > 0 ? skip : undefined });
    writeJsonAtomic(libraryFile(home), { mcpServers: library });
  }

  const tools = adapters.flatMap((adapter) => {
    const files = toolFiles(adapter, home);
    return files.length > 0 ? [installInTool(adapter, files, name, server, { force, dryRun, skip })] : [];
  });
  return [saved, ...tools];
}

/**
 * Removes the server from every installed tool, then marks it `skip: ["*"]`
 * in the library so `seats sync` doesn't bring it back from anywhere.
 */
export function uninstallMcp(
  home: string,
  name: string,
  { dryRun = false, adapters = mcpAdapters }: Omit<McpOptions, "force"> = {},
): Outcome[] {
  // Read first: a library that doesn't parse stops the uninstall before any tool changes.
  const library = readLibrary(home);
  const key = matching(Object.keys(library), name)[0];
  const existing = key ? library[key] : undefined;

  let seen: McpServer | undefined;
  const tools = adapters.flatMap((adapter): Outcome[] => {
    const files = toolFiles(adapter, home);
    if (files.length === 0) return [];
    const base = { where: adapter.id, path: tilde(files[0]!) };
    try {
      let removed = false;
      for (const file of files) {
        const names = matching(adapter.names(file), name);
        if (names.length === 0) continue;
        seen ??= Object.entries(adapter.read(file)).find(([key]) => names.includes(key))?.[1];
        if (!dryRun) adapter.remove(file, names);
        removed = true;
      }
      return [{ ...base, status: removed ? "removed" : "not there" }];
    } catch (error) {
      return [{ ...base, status: "failed", reason: message(error) }];
    }
  });

  const path = tilde(libraryFile(home));
  if (!existing && !tools.some((outcome) => outcome.status === "removed")) {
    if (!tools.some((outcome) => outcome.status === "failed")) {
      throw new Error(`No MCP server named "${name}" in the library or in any installed tool.`);
    }
    return [{ where: "library", status: "not there", path }, ...tools];
  }
  if (existing && isTombstone(existing)) {
    return [{ where: "library", status: "not there", reason: "already uninstalled", path }, ...tools];
  }
  if (!dryRun) {
    // Keeps the definition (or one a tool had) so the entry still says what it was.
    library[key ?? name] = { ...(existing ?? seen ?? { type: "stdio" }), skip: ["*"] };
    writeJsonAtomic(libraryFile(home), { mcpServers: library });
  }
  return [{ where: "library", status: "removed", reason: 'marked skip ["*"] so sync won\'t add it back', path }, ...tools];
}

// ---------------------------------------------------------------------------
// Skills

/** `name:` from SKILL.md's front matter, if it has one. */
function frontMatterName(folder: string): string | undefined {
  const text = readFileSync(join(folder, SKILL_FILE), "utf8");
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  const value = block?.match(/^name:[ \t]*(.+?)[ \t\r]*$/m)?.[1];
  return value?.replace(/^(["'])(.*)\1$/, "$2") || undefined;
}

const SKIPPED_FOLDERS = new Set([".git", "node_modules"]);
const SEARCH_DEPTH = 5;

/**
 * Every skill folder under `dir`, however deep repos keep them (`skills/x`,
 * `.agents/skills/x`, …). A skill's own subfolders aren't searched, nor are
 * `.git` and `node_modules`; symlinked folders aren't followed.
 */
function findSkills(dir: string, depth = 0): string[] {
  if (existsSync(join(dir, SKILL_FILE))) return [dir];
  if (depth >= SEARCH_DEPTH) return [];
  const folders = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !SKIPPED_FOLDERS.has(entry.name))
    .map((entry) => entry.name)
    .sort();
  return folders.flatMap((name) => findSkills(join(dir, name), depth + 1));
}

const skillName = (folder: string) => frontMatterName(folder) ?? basename(folder);

/** The skill to install: the only one found, or the one `wanted` names. */
function pickSkill(dir: string, label: string, wanted: string | undefined): string {
  const found = findSkills(dir);
  if (found.length === 0) throw new Error(`No ${SKILL_FILE} in ${label}.`);
  const names = found.map(skillName).join(", ");
  if (wanted) {
    const match = found.find((folder) => skillName(folder) === wanted || basename(folder) === wanted);
    if (!match) throw new Error(`${label} has no skill named ${wanted}. It has: ${names}.`);
    return match;
  }
  if (found.length === 1) return found[0]!;
  throw new Error(`${label} holds ${found.length} skills: ${names}. Pick one with --skill <name>.`);
}

/** `https://…`, `ssh://…`, `git://…`, `file://…`, or scp-style `git@host:org/repo`. */
const isGitUrl = (source: string) => /^(https?|ssh|git|file):\/\//.test(source) || /^[\w.-]+@[\w.-]+:/.test(source);

/** `https://host/org/review-skill.git` → `review-skill`. */
const repoName = (url: string) => url.replace(/\/+$/, "").split(/[/:]/).pop()!.replace(/\.git$/, "") || "skill";

function gitClone(url: string, dest: string): void {
  const result = spawnSync("git", ["clone", "--depth", "1", "--quiet", "--", url, dest], {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.error) throw new Error(`Couldn't run git: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`git clone failed: ${result.stderr.trim() || `exit ${result.status}`}`);
}

/** True when the symlink at `link` leads to `target`, even when one of them is missing. */
function linksTo(link: string, target: string): boolean {
  const raw = readLink(link);
  if (raw === undefined) return false;
  const reached = realPath(link);
  const realTarget = realPath(target);
  if (reached && realTarget) return isInside(reached, realTarget);
  // Links are written relative to the folder's real location (see replaceSymlink).
  return resolve(realPath(dirname(link)) ?? dirname(link), raw) === target;
}

export type SkillOptions = { dryRun?: boolean; force?: boolean; targets?: SkillsTarget[]; skill?: string };
type ResolvedSkillOptions = Required<Omit<SkillOptions, "skill">> & { skill?: string };

/** Links the library entry into every tool that doesn't read the library itself. */
function linkSkill(home: string, name: string, targets: SkillsTarget[], { dryRun, force }: { dryRun: boolean; force: boolean }): Outcome[] {
  const entry = join(skillsLibrary(home), name);
  return toolSkillsDirs(home, targets).map(({ id, dir, native }): Outcome => {
    const link = join(dir, name);
    const base = { where: id, path: tilde(link) };
    if (lexists(link) && !isSymlink(link)) return { ...base, status: "skipped", reason: `has its own ${name} folder` };
    if (isSymlink(link) && linksTo(link, entry)) return { ...base, status: "already there" };
    if (native) return { where: id, status: "reads the library" };
    // A dangling link is free to replace; a working one to somewhere else needs --force.
    if (existsSync(link) && !force) return { ...base, status: "skipped", reason: `its ${name} links elsewhere` };
    if (!dryRun) {
      mkdirSync(dir, { recursive: true });
      replaceSymlink(link, entry);
    }
    return { ...base, status: "linked" };
  });
}

function copySkill(from: string, to: string): void {
  rmSync(to, { recursive: true, force: true });
  mkdirSync(dirname(to), { recursive: true });
  // Copies what links point at, since a cloned repo's temp folder is deleted afterwards.
  cpSync(from, to, { recursive: true, dereference: true, filter: (path) => basename(path) !== ".git" });
}

function installSkillFrom(home: string, dir: string, label: string, options: ResolvedSkillOptions): { name: string; outcomes: Outcome[] } {
  const folder = pickSkill(dir, label, options.skill);
  const name = skillName(folder);
  if (!SKILL_NAME.test(name)) {
    throw new Error(`"${name}" can't name a skill folder. Use letters, numbers, dots, dashes and underscores.`);
  }
  const entry = join(skillsLibrary(home), name);
  const realEntry = realPath(entry);
  const realFolder = realPath(folder) ?? folder;
  let saved: Outcome = { where: "library", status: "added", path: tilde(entry) };
  if (realEntry === realFolder) {
    saved = { ...saved, status: "already there" };
  } else if (lexists(entry)) {
    if (realEntry && isInside(realFolder, realEntry)) throw new Error(`${label} is inside ${tilde(entry)}. Move it out first.`);
    if (!options.force) throw new Error(`${tilde(entry)} already exists. Use --force to replace it.`);
    saved = { ...saved, status: "replaced" };
  }
  if (saved.status !== "already there" && !options.dryRun) copySkill(folder, entry);
  return { name, outcomes: [saved, ...linkSkill(home, name, options.targets, options)] };
}

/**
 * Copies a skill (a local folder or a git repo) into `~/.agents/skills`, then
 * links it into every tool that doesn't read that library itself. The skill
 * can sit anywhere in the folder or repo; when there are several, `skill`
 * picks one. It is named by `name:` in its SKILL.md front matter, else by its
 * folder (for a repo whose root is the skill, the repo name).
 */
export function installSkill(
  home: string,
  source: string,
  { dryRun = false, force = false, targets = skillsTargets, skill }: SkillOptions = {},
): { name: string; outcomes: Outcome[] } {
  const options = { dryRun, force, targets, skill };
  if (existsSync(source)) {
    if (!statSync(source).isDirectory()) throw new Error(`${source} isn't a folder.`);
    return installSkillFrom(home, resolve(source), source, options);
  }
  if (!isGitUrl(source)) throw new Error(`${source} isn't a folder or a git URL.`);
  // Cloned even in a dry run: the skill's name is only known from its files.
  const temp = mkdtempSync(join(tmpdir(), "seats-skill-"));
  try {
    const dest = join(temp, repoName(source));
    gitClone(source, dest);
    return installSkillFrom(home, dest, source, options);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/**
 * Removes the links to `~/.agents/skills/<name>` from every tool, then the
 * library entry. A tool's own folder, or a link to somewhere else, stays.
 */
export function uninstallSkill(
  home: string,
  name: string,
  { dryRun = false, targets = skillsTargets }: Omit<SkillOptions, "force"> = {},
): Outcome[] {
  if (!SKILL_NAME.test(name)) throw new Error(`"${name}" isn't a skill name.`);
  const entry = join(skillsLibrary(home), name);
  const tools = toolSkillsDirs(home, targets).map(({ id, dir, native }): Outcome => {
    const link = join(dir, name);
    const base = { where: id, path: tilde(link) };
    if (lexists(link) && !isSymlink(link)) return { ...base, status: "skipped", reason: `its own ${name} folder stays` };
    if (isSymlink(link) && !linksTo(link, entry)) return { ...base, status: "skipped", reason: `its ${name} links elsewhere` };
    if (isSymlink(link)) {
      if (!dryRun) unlinkSync(link);
      return { ...base, status: "removed" };
    }
    return native ? { where: id, status: "reads the library" } : { ...base, status: "not there" };
  });

  const path = tilde(entry);
  if (!lexists(entry)) {
    if (!tools.some((outcome) => outcome.status === "removed")) {
      throw new Error(`No skill named "${name}" in ${tilde(skillsLibrary(home))}.`);
    }
    return [{ where: "library", status: "not there", path }, ...tools];
  }
  // A library entry that is a link loses only the link, never what it points at.
  if (!dryRun) rmSync(entry, { recursive: true, force: true });
  return [{ where: "library", status: "removed", path }, ...tools];
}

// ---------------------------------------------------------------------------
// Arguments

type Args = { positional: string[]; flags: Set<string>; options: Record<string, string[]>; command?: string[] };

/** Seats' own flags come before `--`; everything after it is kept as is. */
function parseArgs(argv: string[], known: { flags: string[]; options?: string[] }): Args {
  const split = argv.indexOf("--");
  const own = split === -1 ? argv : argv.slice(0, split);
  const args: Args = {
    positional: [],
    flags: new Set(),
    options: {},
    command: split === -1 ? undefined : argv.slice(split + 1),
  };
  for (let i = 0; i < own.length; i++) {
    const arg = own[i]!;
    if (!arg.startsWith("-")) {
      args.positional.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    if (known.flags.includes(flag) && equals === -1) {
      args.flags.add(flag);
      continue;
    }
    if (!known.options?.includes(flag)) throw new Error(`Unknown option ${arg}.`);
    const value = equals === -1 ? own[++i] : arg.slice(equals + 1);
    if (value === undefined) throw new Error(`${flag} needs a value.`);
    (args.options[flag] ??= []).push(value);
  }
  return args;
}

/** `KEY=VALUE` or `Key: Value` pairs, in order. */
function pairs(values: string[] | undefined, separator: string, usage: string, key: RegExp): Record<string, string> | undefined {
  if (!values) return undefined;
  return Object.fromEntries(
    values.map((item) => {
      const at = item.indexOf(separator);
      const name = item.slice(0, Math.max(at, 0)).trim();
      if (at === -1 || !key.test(name)) throw new Error(`Expected ${usage}, got "${item}".`);
      const value = item.slice(at + separator.length);
      return [name, separator === ":" ? value.trim() : value];
    }),
  );
}

function oneName(args: Args, what: string): string {
  if (args.positional.length === 0) throw new Error(`Name the ${what}.`);
  if (args.positional.length > 1) throw new Error(`Unexpected ${args.positional.slice(1).join(" ")}.`);
  return args.positional[0]!;
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_PAIR = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Takes seats' own flags off the end of a server command, as in
 * `-- npx docs-mcp --env TOKEN=t --dry-run`. Stops at the first token that
 * isn't one, so the server's own arguments stay as they were.
 */
function trailingFlags(command: string[]): { command: string[]; flags: string[]; env: string[] } {
  const flags: string[] = [];
  const env: string[] = [];
  let end = command.length;
  for (;;) {
    const last = command[end - 1] ?? "";
    if (last === "--dry-run" || last === "--force") {
      flags.push(last);
      end -= 1;
    } else if (command[end - 2] === "--env" && ENV_PAIR.test(last)) {
      env.unshift(last);
      end -= 2;
    } else {
      return { command: command.slice(0, end), flags, env };
    }
  }
}

const OPTION_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** `30` → 30, `true` → true, `["a","b"]` → array, anything else stays a string. */
function optionValue(raw: string): ToolOptionValue {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  } catch {
    // not JSON: a plain string
  }
  return raw;
}

/** `--set codex.startup_timeout_sec=30` values, grouped by tool. Tools must be ones seats writes. */
function toolOptions(values: string[] | undefined, toolIds: string[]): Record<string, ToolOptions> | undefined {
  if (!values) return undefined;
  const tools: Record<string, ToolOptions> = {};
  for (const item of values) {
    const match = /^([a-z0-9-]+)\.([^=]+)=(.*)$/s.exec(item);
    if (!match || !OPTION_KEY.test(match[2]!)) throw new Error(`Expected --set tool.key=value, got "${item}".`);
    const [, tool, key, raw] = match as unknown as [string, string, string, string];
    if (!toolIds.includes(tool)) throw new Error(`--set ${tool}: seats doesn't write MCP config for "${tool}". Use one of ${toolIds.join(", ")}.`);
    (tools[tool] ??= {})[key] = optionValue(raw);
  }
  return tools;
}

export type McpRequest = { name: string; server: McpServer; force: boolean; dryRun: boolean };

/** `seats install mcp …` arguments, or an error saying what's wrong. */
export function parseInstallMcp(argv: string[]): McpRequest {
  const args = parseArgs(argv, { flags: ["--force", "--dry-run", "--sse"], options: ["--env", "--url", "--header", "--set"] });
  const name = oneName(args, "MCP server");
  if (!SERVER_NAME.test(name)) {
    throw new Error(`"${name}" can't name an MCP server in every tool. Use letters, numbers, dashes and underscores.`);
  }
  const { options, flags } = args;
  const trailing = trailingFlags(args.command ?? []);
  for (const flag of trailing.flags) flags.add(flag);
  const command = args.command && trailing.command;
  const urls = options["--url"];
  const request = { name, force: flags.has("--force"), dryRun: flags.has("--dry-run") };
  const tools = toolOptions(options["--set"], mcpAdapters.map((adapter) => adapter.id));

  if (command && urls) throw new Error("Give either a command after -- or --url, not both.");
  if (command) {
    if (command.length === 0) throw new Error("Put the server's command after --.");
    if (options["--header"] || flags.has("--sse")) throw new Error("--header and --sse are for remote servers (--url).");
    const envPairs = [...(options["--env"] ?? []), ...trailing.env];
    const env = pairs(envPairs.length > 0 ? envPairs : undefined, "=", "--env KEY=VALUE", ENV_KEY);
    const rest = command.length > 1 ? command.slice(1) : undefined;
    return { ...request, server: compact({ type: "stdio", command: command[0], args: rest, env, tools }) };
  }
  if (!urls) throw new Error("Give the server's command after --, or its --url.");
  if (urls.length > 1) throw new Error("Give --url once.");
  if (options["--env"]) throw new Error("--env is for local servers. Remote servers take --header.");
  const url = urls[0]!;
  if (!URL.canParse(url) || !["http:", "https:"].includes(new URL(url).protocol)) {
    throw new Error(`"${url}" isn't an http(s) URL.`);
  }
  const headers = pairs(options["--header"], ":", '--header "Key: Value"', /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/);
  return { ...request, server: compact({ type: flags.has("--sse") ? "sse" : "http", url, headers, tools }) };
}

// ---------------------------------------------------------------------------
// Output

const STYLE: Record<Status, { planned?: string; color: (text: string) => string }> = {
  added: { planned: "would add", color: pc.green },
  replaced: { planned: "would replace", color: pc.green },
  linked: { planned: "would link", color: pc.green },
  removed: { planned: "would remove", color: pc.green },
  "already there": { color: pc.dim },
  "not there": { color: pc.dim },
  "reads the library": { color: pc.dim },
  skipped: { color: pc.yellow },
  failed: { color: pc.red },
};

function printOutcomes(title: string, outcomes: Outcome[], dryRun: boolean): void {
  p.log.step(title);
  const rows = outcomes.map(({ where, status, reason, path }) => {
    const { planned, color } = STYLE[status];
    const result = color(dryRun && planned ? planned : status);
    return [where, reason ? `${result}${pc.dim(`: ${reason}`)}` : result, pc.dim(path ?? "")];
  });
  console.log(table(["Where", "Result", "Path"], rows));
  const failed = outcomes.some((outcome) => outcome.status === "failed");
  if (failed) process.exitCode = 1;
  p.outro(dryRun ? pc.dim("Dry run: nothing was changed.") : failed ? pc.yellow("Some tools need attention.") : "Done.");
}

/** Runs `step`, or ends the command with its error and a pointer to the usage. */
function orFail<T>(step: () => T): T {
  try {
    return step();
  } catch (error) {
    fail(`${message(error)} ${pc.dim("Run seats install to see the usage.")}`);
  }
}

const KINDS = ["mcp", "skill"];

function kindOf(kind: string | undefined, command: string): "mcp" | "skill" {
  if (kind && KINDS.includes(kind)) return kind as "mcp" | "skill";
  return fail(`${kind ? `Unknown kind "${kind}". ` : ""}Use seats ${command} mcp or seats ${command} skill.`);
}

/** `seats install mcp|skill …`: one server or skill into every installed tool. */
export async function installCommand(argv: string[]): Promise<void> {
  const [kind, ...rest] = argv;
  if (!kind || kind === "--help" || kind === "-h") return console.log(INSTALL_USAGE);
  intro();
  const home = homedir();
  if (kindOf(kind, "install") === "mcp") {
    const request = orFail(() => parseInstallMcp(rest));
    const outcomes = orFail(() => installMcp(home, request.name, request.server, request));
    if (usesEnvRefs(request.server)) p.log.warn("Each tool spells env var references differently. Check them in each tool.");
    return printOutcomes(`Installing MCP server ${pc.cyan(request.name)}`, outcomes, request.dryRun);
  }
  const args = orFail(() => parseArgs(rest, { flags: ["--force", "--dry-run"], options: ["--skill"] }));
  const source = orFail(() => oneName(args, "skill folder or git URL"));
  const dryRun = args.flags.has("--dry-run");
  const skills = args.options["--skill"];
  if (skills && skills.length > 1) fail("Give --skill once.");
  const options = { dryRun, force: args.flags.has("--force"), skill: skills?.[0] };
  const { name, outcomes } = orFail(() => installSkill(home, source, options));
  printOutcomes(`Installing skill ${pc.cyan(name)}`, outcomes, dryRun);
}

/** `seats uninstall mcp|skill <name>`: take it out of every installed tool. */
export async function uninstallCommand(argv: string[]): Promise<void> {
  const [kind, ...rest] = argv;
  if (!kind || kind === "--help" || kind === "-h") return console.log(INSTALL_USAGE);
  intro();
  const home = homedir();
  const what = kindOf(kind, "uninstall");
  const args = orFail(() => parseArgs(rest, { flags: ["--dry-run"] }));
  const name = orFail(() => oneName(args, what === "mcp" ? "MCP server" : "skill"));
  const dryRun = args.flags.has("--dry-run");
  const outcomes = orFail(() => (what === "mcp" ? uninstallMcp(home, name, { dryRun }) : uninstallSkill(home, name, { dryRun })));
  printOutcomes(`Uninstalling ${what === "mcp" ? "MCP server" : "skill"} ${pc.cyan(name)}`, outcomes, dryRun);
}
