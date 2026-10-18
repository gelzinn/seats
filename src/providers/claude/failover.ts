import type { SeatSource } from "../../types.ts";

/**
 * Claude Code runs a `StopFailure` hook when a turn ends on an API error, and
 * `--settings` adds it to supervised launches only: the shared settings.json
 * and sessions started without seats never see it.
 */
export const claudeFailover: NonNullable<SeatSource["failover"]> = {
  hookSettings: (command) => ({
    hooks: { StopFailure: [{ matcher: "rate_limit", hooks: [{ type: "command", command }] }] },
  }),
  settingsArgs: (file) => ["--settings", file],
  resumeArgs: (sessionId, prompt) => ["--resume", sessionId, ...(prompt ? [prompt] : [])],
};
