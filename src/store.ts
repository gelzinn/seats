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

/** Preferences saved in `config.json`; everything is off unless set. */
export type SeatsConfig = {
  /** Move to the next seat of the same tool when one hits its usage limit. */
  autoSwitch?: boolean;
  /** After a mid-session switch, send "continue" so the work goes on by itself. */
  autoContinue?: boolean;
};

export const configFile = (home: string) => join(seatsHome(home), "config.json");

export function readConfig(home: string): SeatsConfig {
  try {
    const value: unknown = JSON.parse(readFileSync(configFile(home), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as SeatsConfig) : {};
  } catch {
    return {};
  }
}

export function writeConfig(home: string, config: SeatsConfig): void {
  mkdirSync(seatsHome(home), { recursive: true, mode: 0o700 });
  writeFileSync(configFile(home), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}
