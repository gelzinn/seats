import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** `~/.config/seats`, or `$SEATS_HOME`: seat folders, shared config and the active env. */
export function seatsHome(home: string): string {
  return process.env.SEATS_HOME || join(home, ".config", "seats");
}

export function storeDir(home: string, provider: string): string {
  return join(seatsHome(home), provider);
}

export function sharedDir(home: string, provider: string): string {
  return join(seatsHome(home), "shared", provider);
}

/** The API or cloud seat whose env is in `active.env`. */
export type ActiveMeta = {
  id: string;
  provider: string;
  kind: string;
  label: string;
  envKeys: string[];
};

export const activeMetaFile = (home: string) => join(seatsHome(home), "active.json");

/** Writes `active.env` (for the shell to source) and `active.json`, both mode 600. */
export function writeActiveEnv(home: string, env: Record<string, string>, meta: Omit<ActiveMeta, "envKeys">): void {
  mkdirSync(seatsHome(home), { recursive: true, mode: 0o700 });
  const lines = Object.entries(env).map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  writeFileSync(join(seatsHome(home), "active.env"), `${lines.join("\n")}\n`, { mode: 0o600 });
  const payload: ActiveMeta = { ...meta, envKeys: Object.keys(env) };
  writeFileSync(activeMetaFile(home), `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

export function readActiveMeta(home: string): ActiveMeta | undefined {
  try {
    return existsSync(activeMetaFile(home))
      ? (JSON.parse(readFileSync(activeMetaFile(home), "utf8")) as ActiveMeta)
      : undefined;
  } catch {
    return undefined;
  }
}
