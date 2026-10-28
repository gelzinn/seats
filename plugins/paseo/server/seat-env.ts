import { seatEnv } from "seats";

/**
 * Env for a Paseo provider named after a seat, `<cli>-<slug>` (for example
 * `claude-primary`, or `claude-primary/claude-opus-5-5` with a model). Undefined
 * for any other provider, or when seats has no such seat.
 */
export function seatEnvForProvider(provider: string): Record<string, string> | undefined {
  const id = provider.split("/")[0] ?? "";
  const dash = id.indexOf("-");
  if (dash <= 0 || dash === id.length - 1) return undefined;
  try {
    return seatEnv(id.slice(0, dash), id.slice(dash + 1));
  } catch (error) {
    console.error(`[seats] could not resolve ${id}:`, error);
    return undefined;
  }
}
