import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Usage, UsageWindow } from "../../types.ts";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
// The endpoint answers Claude Code; ai-status sends the same identification.
const USER_AGENT = "claude-cli/2.1.281 (external, cli)";

type Window = { utilization?: unknown; resets_at?: unknown };

/** `five_hour`, `seven_day` and the per-model weekly windows, as reported. */
export function parseClaudeUsage(body: unknown): Usage | undefined {
  if (!body || typeof body !== "object") return undefined;
  const windows: UsageWindow[] = [];
  for (const [name, raw] of Object.entries(body as Record<string, Window | null>)) {
    if (!raw || typeof raw !== "object" || typeof raw.utilization !== "number") continue;
    const resetsAt = typeof raw.resets_at === "string" ? new Date(raw.resets_at) : undefined;
    windows.push({
      name,
      usedPercent: raw.utilization,
      resetsAt: resetsAt && !Number.isNaN(+resetsAt) ? resetsAt : undefined,
    });
  }
  return windows.length > 0 ? { windows } : undefined;
}

/** The seat's OAuth token, unless it's missing or expired (Claude Code refreshes it on its next start). */
function accessToken(dir: string): string | undefined {
  try {
    const stored = JSON.parse(readFileSync(join(dir, ".credentials.json"), "utf8")) as {
      claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown };
    };
    const { accessToken: token, expiresAt } = stored.claudeAiOauth ?? {};
    if (typeof token !== "string" || !token) return undefined;
    if (typeof expiresAt === "number" && expiresAt <= Date.now()) return undefined;
    return token;
  } catch {
    return undefined;
  }
}

/** Reads the seat's 5-hour and weekly usage. Never logs the token. */
export async function claudeUsage(dir: string): Promise<Usage | undefined> {
  const token = accessToken(dir);
  if (!token) return undefined;
  try {
    const response = await fetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok ? parseClaudeUsage(await response.json()) : undefined;
  } catch {
    return undefined;
  }
}
