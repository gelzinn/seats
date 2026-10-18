/**
 * Text-level TOML edits, so a change never rewrites the rest of the file:
 * comments, order and formatting stay byte for byte.
 */

type ScanState = { depth: number; multiline?: string };

const isBlank = (line: string) => line.trim() === "";
const isComment = (line: string) => line.trimStart().startsWith("#");

/** Index just past the one-line string that opens at `i`. */
function endOfString(line: string, i: number): number {
  const quote = line[i];
  let j = i + 1;
  while (j < line.length && line[j] !== quote) j += quote === '"' && line[j] === "\\" ? 2 : 1;
  return j + 1;
}

/**
 * Tracks open arrays, inline tables and multi-line strings across lines:
 * inside them a line starting with `[` is a value, not a table header.
 */
function scanLine(line: string, state: ScanState): ScanState {
  let { depth, multiline } = state;
  let i = 0;
  while (i < line.length) {
    if (multiline) {
      if (multiline === '"""' && line[i] === "\\") {
        i += 2;
      } else if (line.startsWith(multiline, i)) {
        i += 3;
        // Up to two more quotes still belong to the string's text.
        while (line[i] === multiline[0]) i++;
        multiline = undefined;
      } else {
        i++;
      }
      continue;
    }
    const char = line[i];
    if (char === "#") break;
    if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
      multiline = line.slice(i, i + 3);
      i += 3;
    } else if (char === '"' || char === "'") {
      i = endOfString(line, i);
    } else {
      if (char === "[" || char === "{") depth++;
      else if (char === "]" || char === "}") depth = Math.max(0, depth - 1);
      i++;
    }
  }
  return { depth, multiline };
}

/** Dotted key of a `[table]` or `[[array]]` header line. The TOML parser resolves quoting and spacing. */
function headerKey(line: string): string[] | undefined {
  let node: unknown;
  try {
    node = Bun.TOML.parse(line.trim());
  } catch {
    return undefined;
  }
  const key: string[] = [];
  for (;;) {
    if (Array.isArray(node)) node = node[0];
    const entries = Object.entries(node && typeof node === "object" ? node : {});
    if (entries.length !== 1) return key.length > 0 ? key : undefined;
    const [name, value] = entries[0]!;
    key.push(name);
    node = value;
  }
}

/**
 * Removes every table and array of tables whose key `matches`, wherever it
 * sits in the file, leaving every other byte as it was. Comments right above
 * the next kept table stay with that table. `marker`, a comment seats writes
 * above the tables it appends, goes with the table right below it.
 */
export function removeTables(
  text: string,
  matches: (key: string[]) => boolean,
  { marker }: { marker?: string } = {},
): string {
  // Each line keeps its line ending, so joining them gives back the exact text.
  const lines = text.split(/(?<=\n)/);
  const headers: Array<{ index: number; removed: boolean }> = [];
  let state: ScanState = { depth: 0 };
  lines.forEach((line, index) => {
    const atTop = !state.multiline && state.depth === 0 && line.trimStart().startsWith("[");
    const key = atTop ? headerKey(line) : undefined;
    if (key) headers.push({ index, removed: matches(key) });
    else state = scanLine(line, state);
  });

  const dropped = new Set<number>();
  headers.forEach((header, n) => {
    if (!header.removed) return;
    const next = headers[n + 1];
    let start = header.index;
    let end = next?.index ?? lines.length;
    if (next && !next.removed) while (end - 1 > start && isComment(lines[end - 1]!)) end--;
    if (marker && lines[start - 1]?.trim() === marker) start--;
    // The last table: don't leave the blank lines that separated it.
    if (!next) while (start > 0 && isBlank(lines[start - 1]!)) start--;
    for (let index = start; index < end; index++) dropped.add(index);
  });
  return lines.filter((_, index) => !dropped.has(index)).join("");
}
