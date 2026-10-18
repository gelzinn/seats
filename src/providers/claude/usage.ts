import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Usage, UsageError, UsageReading, UsageWindow } from "../../types.ts";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
// The endpoint answers Claude Code; ai-status sends the same identification.
const USER_AGENT = "claude-cli/2.1.281 (external, cli)";

type Window = { utilization?: unknown; resets_at?: unknown };

/** `five_hour` → 5h, `seven_day` → Week, `seven_day_opus` → Week (opus). Anything else keeps its name. */
export function claudeWindowLabel(name: string): string {
  if (name === "five_hour") return "5h";
  if (name === "seven_day") return "Week";
  if (name.startsWith("seven_day_")) return `Week (${name.slice("seven_day_".length).replaceAll("_", " ")})`;
  return name;
}

/** `five_hour`, `seven_day` and the per-model weekly windows, as reported. */
export function parseClaudeUsage(body: unknown): Usage | undefined {
  if (!body || typeof body !== "object") return undefined;
  const windows: UsageWindow[] = [];
  for (const [name, raw] of Object.entries(body as Record<string, Window | null>)) {
    if (!raw || typeof raw !== "object" || typeof raw.utilization !== "number") continue;
    const resetsAt = typeof raw.resets_at === "string" ? new Date(raw.resets_at) : undefined;
    windows.push({
      name,
      label: claudeWindowLabel(name),
      usedPercent: raw.utilization,
      resetsAt: resetsAt && !Number.isNaN(+resetsAt) ? resetsAt : undefined,
    });
  }
  return windows.length > 0 ? { windows } : undefined;
}

/** The seat's OAuth token, or why there's none. An expired one is left for Claude Code to refresh on its next start. */
function accessToken(dir: string): { token: string } | { error: UsageError } {
  try {
    const stored = JSON.parse(readFileSync(join(dir, ".credentials.json"), "utf8")) as {
      claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown };
    };
    const { accessToken: token, expiresAt } = stored.claudeAiOauth ?? {};
    if (typeof token !== "string" || !token) return { error: "no-token" };
    if (typeof expiresAt === "number" && expiresAt <= Date.now()) return { error: "expired" };
    return { token };
  } catch {
    return { error: "no-token" };
  }
}

/** Reads the seat's 5-hour and weekly usage, or why it couldn't. Never logs the token. */
export async function readClaudeUsage(dir: string): Promise<UsageReading> {
  const auth = accessToken(dir);
  if ("error" in auth) return auth;
  try {
    const response = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401) return { error: "expired" };
    const usage = response.ok ? parseClaudeUsage(await response.json()) : undefined;
    return usage ? { usage } : { error: "failed" };
  } catch {
    return { error: "failed" };
  }
}

/** The seat's usage, or undefined when it can't be read. */
export const claudeUsage = async (dir: string): Promise<Usage | undefined> => (await readClaudeUsage(dir)).usage;
