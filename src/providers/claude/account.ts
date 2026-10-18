import { readFileSync } from "node:fs";
import { join } from "node:path";

export type ClaudeAccount = { email?: string; plan?: string };

type Credentials = {
  claudeAiOauth?: {
    accessToken?: unknown;
    refreshToken?: unknown;
    subscriptionType?: unknown;
    rateLimitTier?: unknown;
  };
};
type Config = {
  oauthAccount?: { emailAddress?: unknown; userRateLimitTier?: unknown; organizationType?: unknown };
};

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
const capitalize = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** "team" + a "…_5x" rate-limit tier → "Team 5x". */
function planName(subscription: string | undefined, tier: string | undefined): string | undefined {
  if (!subscription) return undefined;
  const multiplier = tier?.match(/_(\d+x)$/)?.[1];
  return multiplier ? `${capitalize(subscription)} ${multiplier}` : capitalize(subscription);
}

/**
 * The account signed in to a config dir, from its files alone, or undefined
 * when it's signed out. Never runs `claude`: `claude auth status` refreshes an
 * expired token, and a refresh that races another session's wipes the login.
 */
export function claudeAccount(dir: string): ClaudeAccount | undefined {
  const credentials = readJson<Credentials>(join(dir, ".credentials.json"));
  const account = readJson<Config>(join(dir, ".claude.json"))?.oauthAccount;
  const oauth = credentials?.claudeAiOauth;

  if (credentials) {
    // Claude Code blanks the tokens when it signs out or a refresh fails.
    if (!text(oauth?.refreshToken) && !text(oauth?.accessToken)) return undefined;
  } else if (!account) {
    // macOS keeps the tokens in the Keychain; the account record is the only sign on disk.
    return undefined;
  }

  const subscription = text(oauth?.subscriptionType) ?? text(account?.organizationType)?.replace(/^claude_/, "");
  const tier = text(oauth?.rateLimitTier) ?? text(account?.userRateLimitTier);
  return { email: text(account?.emailAddress), plan: planName(subscription, tier) };
}
