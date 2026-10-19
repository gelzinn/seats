import { type Json, record } from "../../mcp/convert.ts";
import type { PortableText, SecretRef } from "../../types.ts";
import { MARKER } from "./mcp.ts";
import { removeTables, tomlKey, tomlValue } from "./toml.ts";

/**
 * One server without literal secrets, or undefined when it has none. Codex
 * reads `bearer_token_env_var` and `env_http_headers` from the environment, so
 * a token or header moves there. `env` has no such field and gets `${NAME}`
 * placeholders to fill in on the new machine.
 */
function portableServer(name: string, entry: Json, secret: SecretRef): Json | undefined {
  const next: Json = { ...entry };
  let changed = false;

  if (typeof entry.bearer_token === "string") {
    const ref = secret(entry.bearer_token, `${name}_BEARER_TOKEN`);
    if (ref) {
      delete next.bearer_token;
      next.bearer_token_env_var = ref;
      changed = true;
    }
  }

  const headers: Json = { ...record(entry.http_headers) };
  const fromEnv: Json = { ...record(entry.env_http_headers) };
  for (const [header, value] of Object.entries(headers)) {
    const ref = typeof value === "string" ? secret(value, `${name}_${header}`) : undefined;
    if (!ref) continue;
    delete headers[header];
    fromEnv[header] = ref;
    changed = true;
  }
  if (Object.keys(fromEnv).length > 0) next.env_http_headers = fromEnv;
  if (Object.keys(headers).length > 0) next.http_headers = headers;
  else delete next.http_headers;

  const env: Json = { ...record(entry.env) };
  for (const [key, value] of Object.entries(env)) {
    const ref = typeof value === "string" ? secret(value, key, `${name}_${key}`) : undefined;
    if (!ref) continue;
    env[key] = `\${${ref}}`;
    changed = true;
  }
  if (entry.env) next.env = env;

  return changed ? next : undefined;
}

/**
 * `config.toml` for `seats export`. Trusted projects (absolute paths on this
 * machine) are dropped, and MCP servers holding secrets are rewritten as
 * tables without them. Everything else stays byte for byte, and the result
 * must parse to exactly the expected config, or the export stops.
 */
export function portableConfig(text: string, secret: SecretRef): PortableText {
  const config = record(Bun.TOML.parse(text));
  const { projects, ...expected } = config;
  const dropped: string[] = [];
  let out = text;

  if (projects !== undefined) {
    out = removeTables(out, (key) => key[0] === "projects");
    dropped.push("trusted projects");
  }

  const servers = record(config.mcp_servers);
  const changed: Record<string, Json> = {};
  for (const [name, raw] of Object.entries(servers)) {
    const next = portableServer(name, record(raw), secret);
    if (next) changed[name] = next;
  }

  if (Object.keys(changed).length > 0) {
    out = removeTables(out, (key) => key[0] === "mcp_servers" && key.length > 1 && key[1]! in changed, {
      marker: MARKER,
    });
    const tables = Object.entries(changed).map(([name, entry]) =>
      [
        `[mcp_servers.${tomlKey(name)}]`,
        ...Object.entries(entry).map(([key, value]) => `${tomlKey(key)} = ${tomlValue(value)}`),
      ].join("\n"),
    );
    const gap = out === "" || out.endsWith("\n\n") ? "" : out.endsWith("\n") ? "\n" : "\n\n";
    out = `${out}${gap}${tables.join("\n\n")}\n`;
    expected.mcp_servers = { ...servers, ...changed };
  }

  let clean = false;
  try {
    clean = Bun.deepEquals(Bun.TOML.parse(out), expected);
  } catch {
    // the edit left the file unparseable
  }
  if (!clean) throw new Error("can't take secrets and trusted projects out of it safely");
  return { text: out, dropped };
}
