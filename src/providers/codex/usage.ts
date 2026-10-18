import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Usage, UsageWindow } from "../../types.ts";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

type Window = { used_percent?: unknown; reset_at?: unknown; reset_after_seconds?: unknown };

/** `rate_limit.primary_window` (5 hours, or a month on Free) and `secondary_window` (weekly). */
export function parseCodexUsage(body: unknown, now = Date.now()): Usage | undefined {
  const limits = (body as { rate_limit?: Record<string, Window | null> } | null)?.rate_limit;
  if (!limits || typeof limits !== "object") return undefined;
  const windows: UsageWindow[] = [];
  for (const name of ["primary_window", "secondary_window"]) {
    const raw = limits[name];
    if (!raw || typeof raw.used_percent !== "number") continue;
    const resetsAt =
      typeof raw.reset_at === "number"
        ? new Date(raw.reset_at * 1000)
        : typeof raw.reset_after_seconds === "number"
          ? new Date(now + raw.reset_after_seconds * 1000)
          : undefined;
    windows.push({ name, usedPercent: raw.used_percent, resetsAt });
  }
  return windows.length > 0 ? { windows } : undefined;
}

/** Reads the seat's Codex usage with the ChatGPT login `codex login` saved. Never logs the token. */
export async function codexUsage(dir: string): Promise<Usage | undefined> {
  let tokens: { access_token?: unknown; account_id?: unknown } | undefined;
  try {
    tokens = (JSON.parse(readFileSync(join(dir, "auth.json"), "utf8")) as { tokens?: typeof tokens }).tokens;
  } catch {
    return undefined;
  }
  if (typeof tokens?.access_token !== "string") return undefined;
  const headers: Record<string, string> = { Authorization: `Bearer ${tokens.access_token}` };
  if (typeof tokens.account_id === "string") headers["ChatGPT-Account-Id"] = tokens.account_id;
  try {
    const response = await fetch(USAGE_URL, { headers, signal: AbortSignal.timeout(10_000) });
    return response.ok ? parseCodexUsage(await response.json()) : undefined;
  } catch {
    return undefined;
  }
}
