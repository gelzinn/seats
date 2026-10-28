Seats makes herdr reopen each Claude Code pane on the seat its conversation ran on. Without it, herdr restores a Claude pane after a server restart with `claude --resume <id>`, which opens the active seat (`~/.claude`), not the account that had the conversation.

When herdr detects Claude in a pane, or the pane's status changes, the plugin runs `seats hook herdr`. It reads the pane's session id from herdr, finds the Claude seat that has that conversation (the most recently written copy when several do, e.g. after `seats move` or an auto-switch) and reports `seats run claude:<seat> --resume <id>` as the pane's resume command. herdr saves it with the session and uses it over its own on restore. A command already reported for a pane isn't sent again.

## Setup

Needs herdr 0.9.2 or later and `seats` on your `PATH`.

```bash
herdr plugin install gelzinn/seats/plugins/herdr
# or, from a checkout:
herdr plugin link /path/to/seats/plugins/herdr
```

Keep herdr's own Claude integration (`herdr integration install claude`): it reports the session id this plugin reads.

## Limits

Only Claude Code. A pane is covered from its first status change after the plugin is installed, so panes restored before that still open on the active seat once.

The plugin reads seat folders under your home directory and talks only to herdr. It never reads credentials and sends nothing over the network.
