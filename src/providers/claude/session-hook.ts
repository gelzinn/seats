import type { SeatSource } from "../../types.ts";

type Json = Record<string, unknown>;

/**
 * `SessionStart` runs it as a session opens; `Stop` after each turn, since
 * Claude Code may not have written a new trust to `.claude.json` by then.
 */
const EVENTS = ["SessionStart", "Stop"];

const record = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};

/** True when some entry already runs `command`, whatever else it holds. */
const hasCommand = (groups: unknown[], command: string) =>
  groups.some(
    (group) =>
      Array.isArray(record(group).hooks) &&
      (record(group).hooks as unknown[]).some((hook) => record(hook).command === command),
  );

/**
 * Lives in the shared settings.json rather than in `--settings` like the limit
 * hook, so plain `claude` runs it too. Other hooks are left as they are.
 */
export const claudeSessionHook: NonNullable<SeatSource["sessionHook"]> = {
  item: "settings.json",
  add(settings, command) {
    const hooks = { ...record(settings.hooks) };
    let changed = false;
    for (const event of EVENTS) {
      const groups = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
      if (hasCommand(groups, command)) continue;
      // No matcher: SessionStart then covers startup, resume, clear and compact.
      hooks[event] = [...groups, { hooks: [{ type: "command", command }] }];
      changed = true;
    }
    return changed ? { ...settings, hooks } : undefined;
  },
};
