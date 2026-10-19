import { isEnvRef } from "./mcp/library.ts";
import { isRecord } from "./share.ts";
import type { SecretRef } from "./types.ts";

/** An env var the new machine must define, and the exported file that uses it. */
export type EnvVar = { name: string; file: string; dropped?: boolean };

/** A literal value taken out of an export. Kept in memory for the leak scan, never written. */
export type Secret = { name: string; value: string; file: string };

/** `docs` + `x-api-key` → `DOCS_X_API_KEY`. */
export const envName = (name: string) =>
  name
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();

/** Variable names in a reference: `${A}`, `${env:A}`, `$A`, `{env:A}`. */
export function refNames(value: string): string[] {
  const names = [...value.matchAll(/\$\{(?:env:)?(\w+)\}|\$([A-Za-z_]\w*)|\{env:(\w+)\}/g)];
  return names.map((match) => (match[1] ?? match[2] ?? match[3])!);
}

/** A file path, such as Codex's `NODE_REPL_NODE_PATH`: config, not a credential, and often repeated in `command`. */
export const isPath = (value: string) => /^(~|\.{1,2})?\//.test(value);

/** Collects the secrets and variables of one export, so names stay unique across files. */
export function secretCollector() {
  const secrets: Secret[] = [];
  const vars: EnvVar[] = [];
  const taken = new Map<string, string>();
  const need = (name: string, file: string, dropped?: boolean) => {
    if (!vars.some((item) => item.name === name && item.file === file)) vars.push({ name, file, dropped });
  };

  /** The `SecretRef` handed to the code that rewrites `file`. */
  const ref =
    (file: string): SecretRef =>
    (value, ...names) => {
      if (isEnvRef(value)) {
        for (const name of refNames(value)) need(name, file);
        return undefined;
      }
      if (isPath(value)) return undefined;
      const candidates = names.map(envName);
      const free = (name: string) => !taken.has(name) || taken.get(name) === value;
      let name = candidates.find(free);
      for (let n = 2; !name; n++) if (free(`${candidates.at(-1)}_${n}`)) name = `${candidates.at(-1)}_${n}`;
      taken.set(name, value);
      secrets.push({ name, value, file });
      need(name, file);
      return name;
    };

  /** Records a literal that is left out instead of replaced. */
  const drop = (file: string, name: string, value: string) => {
    secrets.push({ name, value, file });
    need(name, file, true);
  };

  return { secrets, vars, ref, drop };
}

export type SecretCollector = ReturnType<typeof secretCollector>;

/** Maps of credentials in MCP entries: Claude, Cursor, Gemini, Kiro, Copilot and seats' own `mcp.json`. */
const SECRET_MAPS = ["env", "headers", "http_headers"];

/**
 * A JSON config without literal credentials. Values under `env` and `headers`
 * become `${NAME}`: the key for env, `<SERVER>_<HEADER>` for headers, where the
 * server is the entry holding them. A top-level `env` is the tool's own
 * environment (Claude's `settings.json`), which doesn't expand references, so
 * its literal values are dropped instead.
 */
export function scrubJson(data: unknown, file: string, collector: SecretCollector): unknown {
  const secret = collector.ref(file);

  const walk = (node: unknown, owner: string, top: boolean): unknown => {
    if (Array.isArray(node)) return node.map((item) => walk(item, owner, false));
    if (!isRecord(node)) return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (top && key === "env" && isRecord(value)) {
        const kept = Object.entries(value).filter(([name, item]) => {
          if (typeof item !== "string" || isEnvRef(item) || isPath(item)) return true;
          collector.drop(file, name, item);
          return false;
        });
        if (kept.length > 0) out[key] = Object.fromEntries(kept);
      } else if (SECRET_MAPS.includes(key) && isRecord(value)) {
        out[key] = Object.fromEntries(
          Object.entries(value).map(([name, item]) => {
            if (typeof item !== "string") return [name, item];
            const ref = key === "env" ? secret(item, name, `${owner}_${name}`) : secret(item, `${owner}_${name}`);
            return [name, ref ? `\${${ref}}` : item];
          }),
        );
      } else if (key === "bearer_token" && typeof value === "string") {
        const ref = secret(value, `${owner}_BEARER_TOKEN`);
        out[key] = ref ? `\${${ref}}` : value;
      } else {
        out[key] = walk(value, key, false);
      }
    }
    return out;
  };

  return walk(data, "", true);
}

/** Shorter values (`1`, `true`, `debug`) can't be a credential and appear everywhere by chance. */
const MIN_SECRET_LENGTH = 8;

/** `{ name, file }` for every secret still present in `files`, as written or JSON-escaped. */
export function findLeaks(files: Map<string, Buffer>, secrets: Secret[]): Array<{ name: string; file: string }> {
  const leaks: Array<{ name: string; file: string }> = [];
  for (const { name, value } of secrets) {
    if (value.length < MIN_SECRET_LENGTH) continue;
    const needles = [...new Set([value, JSON.stringify(value).slice(1, -1)])];
    for (const [file, data] of files) {
      if (needles.some((needle) => data.includes(needle))) leaks.push({ name, file });
    }
  }
  return leaks;
}
