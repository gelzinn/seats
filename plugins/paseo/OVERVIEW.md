Seats points Paseo providers named after a seat at that seat's folder, as resolved by the `seats` library. A provider `claude-primary` opens its sessions with `CLAUDE_CONFIG_DIR` set to the `claude:primary` seat, wherever seats keeps it: `~/.config/seats/claude/primary` after `seats migrate`, or a legacy `~/.claude-primary`.

It runs on every session open (create, resume, refresh and import), so moving or migrating seats no longer breaks agents that still carry an old path in `config.json`.

## Setup

Define each provider in `agents.providers` as `<cli>-<seat slug>` extending the CLI, for example `"claude-primary": { "extends": "claude", "label": "Claude · Primary" }`. Seats with no matching folder, providers without a dash, and CLIs without a config folder variable are left unchanged. Only Claude has one today (`CLAUDE_CONFIG_DIR`).

## Limits

Provider diagnostics and model listing do not open a session, so they still use the `env` in `config.json`. Keep it there as a fallback, or those screens use `~/.claude`, which is the active seat.

The plugin reads seat folders under your home directory. It never reads credentials and sends nothing over the network.
