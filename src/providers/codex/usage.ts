import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Usage, UsageReading, UsageWindow } from "../../types.ts";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

type Window = {
  used_percent?: unknown;
  reset_at?: unknown;
  reset_after_seconds?: unknown;
  limit_window_seconds?: unknown;
};

const HOUR = 3600;
const DAY = 24 * HOUR;

/** The window's length as a label ("5h", "Week", "Month"), else what the window usually is. */
export function codexWindowLabel(name: string, seconds?: number): string {
  if (!seconds || seconds <= 0) return name === "primary_window" ? "5h" : name === "secondary_window" ? "Week" : name;
  if (seconds >= 28 * DAY) return "Month";
  if (seconds === 7 * DAY) return "Week";
  if (seconds >= DAY) return `${Math.round(seconds / DAY)}d`;
  return `${Math.round(seconds / HOUR)}h`;
}

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
    const seconds = typeof raw.limit_window_seconds === "number" ? raw.limit_window_seconds : undefined;
    windows.push({ name, label: codexWindowLabel(name, seconds), usedPercent: raw.used_percent, resetsAt });
  }
  return windows.length > 0 ? { windows } : undefined;
}

/** Reads the seat's Codex usage with the ChatGPT login `codex login` saved, or why it couldn't. Never logs the token. */
export async function readCodexUsage(dir: string): Promise<UsageReading> {
  let tokens: { access_token?: unknown; account_id?: unknown } | undefined;
  try {
    tokens = (JSON.parse(readFileSync(join(dir, "auth.json"), "utf8")) as { tokens?: typeof tokens }).tokens;
  } catch {
    return { error: "no-token" };
  }
  if (typeof tokens?.access_token !== "string") return { error: "no-token" };
  const headers: Record<string, string> = { Authorization: `Bearer ${tokens.access_token}` };
  if (typeof tokens.account_id === "string") headers["ChatGPT-Account-Id"] = tokens.account_id;
  try {
    const response = await fetch(USAGE_URL, { headers, signal: AbortSignal.timeout(10_000) });
    if (response.status === 401) return { error: "expired" };
    const usage = response.ok ? parseCodexUsage(await response.json()) : undefined;
    return usage ? { usage } : { error: "failed" };
  } catch {
    return { error: "failed" };
  }
}

/** The seat's usage, or undefined when it can't be read. */
export const codexUsage = async (dir: string): Promise<Usage | undefined> => (await readCodexUsage(dir)).usage;
