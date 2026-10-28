Seats makes herdr reopen each Claude Code and Codex pane on the seat its conversation ran on. Without it, herdr restores those panes after a server restart with `claude --resume <id>` or `codex resume <id>`, which open the active seat (`~/.claude`, `~/.codex`), not the account that had the conversation.

When herdr detects Claude Code or Codex in a pane, or the pane's status changes, the plugin runs `seats hook herdr`. It reads the pane's session id from herdr, finds the seat of that tool that has the conversation and reports `seats run claude:<seat> --resume <id>` or `seats run codex:<seat> resume <id>` as the pane's resume command. herdr saves it with the session and uses it over its own on restore. When several seats have the conversation (after `seats move` or an auto-switch, or when they share their conversations with `seats share sessions`), the seat the pane's agent runs on wins: herdr's `pane process-info` names its processes, and the agent's `CLAUDE_CONFIG_DIR` or `CODEX_HOME` (else the active seat), or else the `seats run <tool>:<seat>` that started it, gives the seat; herdr is asked for them only when it detects a new agent process in the pane, which is how a pane changes seat. When that seat doesn't have it, the most recently written copy wins. A command already reported for a pane isn't sent again, and the seats are only searched again when the pane's session changes or herdr detects a new agent process in it.

## Setup

Needs herdr 0.9.2 or later and `seats` on your `PATH`.

```bash
seats install plugin herdr
# or by hand:
herdr plugin install gelzinn/seats/plugins/herdr
herdr plugin link /path/to/seats/plugins/herdr   # from a checkout
```

`seats doctor` checks the plugin, herdr's version and its integrations.

Keep herdr's own integrations for the tools you use (`herdr integration install claude`, `herdr integration install codex`): they report the session id this plugin reads.

## Limits

Claude Code and Codex only. A pane is covered from its first status change after the plugin is installed, so panes restored before that still open on the active seat once.

Seats finds Codex conversations by file name (`sessions/…/rollout-<time>-<id>.jsonl`, or `archived_sessions/`). `seats sessions` lists them, but `seats move` refuses them: a copy would carry reasoning Codex encrypted for the account that ran it. The seat the plugin reports is one that has the rollout, the pane's own when it does.

The plugin reads seat folders under your home directory and talks only to herdr. It never reads credentials and sends nothing over the network.
