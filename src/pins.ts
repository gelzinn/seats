import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { writeTextAtomic } from "./fs.ts";

/** Name of the file that pins a project's seats, one `tool = "seat"` per line. */
export const PIN_FILE = ".seats";

/** The seat a `.seats` file picks for one tool. */
export type Pin = { tool: string; slug: string; file: string };

const KEY = /^[\w.-]+$/;

/** The `[tool, seat]` a line holds, or undefined for blanks, comments and lines seats doesn't know. */
function parseLine(line: string): [string, string] | undefined {
  const text = line.replace(/#.*/, "").trim();
  const equals = text.indexOf("=");
  if (equals < 0) return undefined;
  const key = text.slice(0, equals).trim();
  const value = text
    .slice(equals + 1)
    .trim()
    .replace(/^(["'])(.*)\1$/, "$2")
    .trim();
  return KEY.test(key) && value ? [key, value] : undefined;
}

/** Tool → seat slug from a `.seats` file's text. A tool named twice takes the last line. */
export function parsePins(text: string): Map<string, string> {
  const pins = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const entry = parseLine(line);
    if (entry) pins.set(entry[0], entry[1]);
  }
  return pins;
}

function readPins(file: string): Map<string, string> {
  try {
    return parsePins(readFileSync(file, "utf8"));
  } catch {
    return new Map();
  }
}

/**
 * Every pin in effect in `cwd`. Like .editorconfig, each tool takes the
 * nearest `.seats` that names it, walking up to `/`.
 */
export function findPins(cwd = process.cwd()): Map<string, Pin> {
  const found = new Map<string, Pin>();
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const file = join(dir, PIN_FILE);
    for (const [tool, slug] of readPins(file)) if (!found.has(tool)) found.set(tool, { tool, slug, file });
    if (dirname(dir) === dir) return found;
  }
}

/** The pin for `tool` in effect in `cwd`, or undefined when no `.seats` names it. */
export function findPin(tool: string, cwd = process.cwd()): Pin | undefined {
  return findPins(cwd).get(tool);
}

function save(file: string, lines: string[]): void {
  const text = `${lines.join("\n").trimEnd()}\n`;
  if (existsSync(file)) writeTextAtomic(file, text);
  else writeFileSync(file, text);
}

const linesOf = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trimEnd().split(/\r?\n/) : []);

/** Sets `tool = "slug"` in `dir/.seats`, creating it, and keeps every other line. Returns the file. */
export function writePin(dir: string, tool: string, slug: string): string {
  const file = join(dir, PIN_FILE);
  const entry = `${tool} = "${slug}"`;
  const lines = linesOf(file);
  const names = (line: string) => parseLine(line)?.[0] === tool;
  const at = lines.findIndex(names);
  // The first line for this tool is replaced in place; repeats would override it, so they go.
  save(
    file,
    at < 0 ? [...lines, entry] : lines.flatMap((line, index) => (index === at ? [entry] : names(line) ? [] : [line])),
  );
  return file;
}

/**
 * Takes `tool` out of `dir/.seats`, and deletes the file once only blanks and
 * comments are left. Returns false when the file didn't name `tool`.
 */
export function removePin(dir: string, tool: string): boolean {
  const file = join(dir, PIN_FILE);
  const lines = linesOf(file);
  const kept = lines.filter((line) => parseLine(line)?.[0] !== tool);
  if (kept.length === lines.length) return false;
  if (kept.every((line) => /^\s*(#.*)?$/.test(line))) rmSync(file, { force: true });
  else save(file, kept);
  return true;
}
