import type { SeatSource } from "../../types.ts";

type Json = Record<string, unknown>;

/**
 * `SessionStart` runs it as a session opens; `Stop` after each turn, since
 * Claude Code may not have written a new trust to `.claude.json` by then.
 */
const EVENTS = ["SessionStart", "Stop"];

const record = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};

const hooksOf = (group: unknown): unknown[] =>
  Array.isArray(record(group).hooks) ? (record(group).hooks as unknown[]) : [];

/** True when some entry already runs `command`, whatever else it holds. */
const hasCommand = (groups: unknown[], command: string) =>
  groups.some((group) => hooksOf(group).some((hook) => record(hook).command === command));

/** No matcher, `""` and `"*"` all match every event. */
const matchesAll = (matcher: unknown) => matcher === undefined || matcher === "" || matcher === "*";

/** Same type and command: Claude Code would run both. */
const sameHook = (a: unknown, b: unknown) =>
  record(a).type === record(b).type && record(a).command === record(b).command;

/**
 * Drops hooks an earlier entry of the same event already runs. When their
 * matchers differ, the one entry left must cover both: one that matches
 * everything wins, else the first gets `a|b` when it runs nothing else.
 * Duplicates that can't be merged that way stay.
 */
function dedupe(groups: unknown[]): unknown[] {
  type Group = Json & { hooks: unknown[] };
  const next = groups.map((group) =>
    Array.isArray(record(group).hooks) ? ({ ...record(group), hooks: [...hooksOf(group)] } as Group) : group,
  );
  const entries = next.filter((group): group is Group => Array.isArray(record(group).hooks));
  const emptied = new Set<Group>();
  for (const [index, group] of entries.entries()) {
    for (const hook of [...group.hooks]) {
      const holders = entries.slice(index).filter((other) => other.hooks.some((item) => sameHook(item, hook)));
      if (holders.length < 2) continue;
      const matchers = [...new Set(holders.map((holder) => (matchesAll(holder.matcher) ? "*" : holder.matcher)))];
      let keeper = holders.find((holder) => matchesAll(holder.matcher)) ?? (matchers.length === 1 ? group : undefined);
      if (!keeper && group.hooks.length === 1 && matchers.every((matcher) => typeof matcher === "string")) {
        keeper = group;
        group.matcher = matchers.join("|");
      }
      if (!keeper) continue;
      for (const holder of holders) {
        if (holder === keeper) continue;
        holder.hooks = holder.hooks.filter((item) => !sameHook(item, hook));
        if (holder.hooks.length === 0) emptied.add(holder);
      }
    }
  }
  return next.filter((group) => !emptied.has(group as Group));
}

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
  tidy(settings, rewrite) {
    const hooks: Json = {};
    for (const [event, groups] of Object.entries(record(settings.hooks))) {
      if (!Array.isArray(groups)) {
        hooks[event] = groups;
        continue;
      }
      const rewritten = groups.map((group) =>
        Array.isArray(record(group).hooks)
          ? {
              ...record(group),
              hooks: hooksOf(group).map((hook) =>
                typeof record(hook).command === "string"
                  ? { ...record(hook), command: rewrite(record(hook).command as string) }
                  : hook,
              ),
            }
          : group,
      );
      hooks[event] = dedupe(rewritten);
    }
    const next: Json = { ...settings };
    if (settings.hooks !== undefined && Object.keys(record(settings.hooks)).length > 0) next.hooks = hooks;
    const statusLine = record(settings.statusLine);
    if (typeof statusLine.command === "string") {
      next.statusLine = { ...statusLine, command: rewrite(statusLine.command) };
    }
    return JSON.stringify(next) === JSON.stringify(settings) ? undefined : next;
  },
};
