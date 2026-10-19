#!/usr/bin/env bun
// A JSON import, so compiled binaries carry their version without reading package.json.
import { version } from "../package.json";
import { addCommand } from "./commands/add.ts";
import { desktopCommand } from "./commands/desktop.ts";
import { healthCommand } from "./commands/health.ts";
import { installCommand, uninstallCommand } from "./commands/install.ts";
import { currentCommand, listCommand } from "./commands/list.ts";
import { migrateCommand } from "./commands/migrate.ts";
import { pinCommand, unpinCommand } from "./commands/pin.ts";
import { autoSwitchCommand, hookCommand, runCommand } from "./commands/run.ts";
import { moveCommand, sessionsCommand } from "./commands/sessions.ts";
import { pickCommand, useCommand } from "./commands/switch.ts";
import { syncCommand } from "./commands/sync.ts";
import { usageCommand } from "./commands/usage.ts";

const HELP = `seats — switch the active AI CLI, API, or cloud seat

Usage:
  seats                 Interactive picker
  seats list [filter]   Show seats: all, or one kind (cli | api | cloud), tool
                        (claude, openrouter…) or seat id. Signed-out ones show dimmed
  seats current         Show active homedirs and env, and seats pinned here
  seats use <id>        Activate a seat without launching
  seats run <tool> [args...]
                        Launch the seat pinned here, else the active seat of a
                        tool, without the picker
  seats pin [tool:seat] Pin a seat for this project in ./.seats; with no seat,
                        show the pins in effect here and their files
  seats unpin <tool>    Take a tool's pin out of ./.seats
  seats auto-switch [on|off]
                        Off by default. When on, a seat at its usage limit is
                        skipped, and a Claude Code session that hits it moves
                        to the next seat with --resume
  seats health [tool|id]
                        Ask each signed-in seat to reply and show which work
  seats usage [tool|id] [--json]
                        Show each seat's 5-hour and weekly usage, without
                        sending a prompt (--json for scripts)
  seats sessions [tool|id] [--all]
                        Conversations from every Claude seat, newest first:
                        this folder's, or every project's with --all
  seats move <session> <seat>
                        Copy a conversation to another seat (the original
                        stays) and offer to reopen it there (--force to replace)
  seats add [tool] [name]
                        Sign a new account in (claude | codex) without touching
                        the active one. Args after -- go to the tool's login.
  seats desktop open|list|remove <name>
                        Open Claude Desktop on another account, side by side
                        with the ones already open (macOS and Linux)
  seats sync            Share config and trust between seats, and MCP servers,
                        skills and instructions across tools (--dry-run to preview)
  seats install mcp <name> -- <command> [args...] [--env KEY=VALUE ...]
  seats install mcp <name> --url <url> [--header "Key: Value" ...] [--sse]
  seats install skill <folder | git-url> [--skill <name>]
                        Add an MCP server or a skill to every installed tool
                        (--set tool.key=value for one tool's entry, --force to
                        replace, --dry-run to preview)
  seats uninstall mcp|skill <name>
                        Remove it from every tool; a server is marked so sync
                        won't add it back (--dry-run to preview)
  seats migrate         Move ~/.<tool>-* seat folders into ~/.config/seats
                        (--dry-run to preview)
  seats help            Show this help
  seats --version       Show the installed version

Examples:
  seats
  seats list api
  seats list claude
  seats use claude:primary
  seats use api:openrouter
  seats health
  seats usage
  seats usage codex --json
  seats run claude --continue
  seats pin claude:work
  seats unpin claude
  seats auto-switch on
  seats sessions --all
  seats move 3f2a claude:work
  seats add claude work
  seats add codex personal -- --device-auth
  seats desktop open work
  seats install mcp docs -- npx -y docs-mcp
  seats install skill ./review --dry-run
  seats uninstall mcp docs
`;

const help = async () => console.log(HELP);
const printVersion = async () => console.log(version);

/** Each command gets the arguments after its name. */
const commands: Record<string, (args: string[]) => Promise<void>> = {
  add: addCommand,
  "auto-switch": autoSwitchCommand,
  current: currentCommand,
  desktop: desktopCommand,
  health: healthCommand,
  hook: hookCommand,
  help,
  "--help": help,
  "-h": help,
  "--version": printVersion,
  "-v": printVersion,
  install: installCommand,
  list: listCommand,
  migrate: migrateCommand,
  move: moveCommand,
  pin: pinCommand,
  run: runCommand,
  sessions: sessionsCommand,
  sync: syncCommand,
  uninstall: uninstallCommand,
  unpin: unpinCommand,
  usage: usageCommand,
  use: useCommand,
};

async function main(): Promise<void> {
  const [name, ...args] = process.argv.slice(2);
  const command = name ? commands[name] : undefined;
  // Anything else goes to the picker and on to the chosen CLI, e.g. `seats --resume`.
  await (command ? command(args) : pickCommand(process.argv.slice(2)));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
