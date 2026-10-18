#!/usr/bin/env bun
// A JSON import, so compiled binaries carry their version without reading package.json.
import { version } from "../package.json";
import { addCommand } from "./commands/add.ts";
import { healthCommand } from "./commands/health.ts";
import { currentCommand, listCommand } from "./commands/list.ts";
import { migrateCommand } from "./commands/migrate.ts";
import { pickCommand, useCommand } from "./commands/switch.ts";
import { syncCommand } from "./commands/sync.ts";

const HELP = `seats — switch the active AI CLI, API, or cloud seat

Usage:
  seats                 Interactive picker
  seats list [kind]     Show signed-in seats (cli | api | cloud)
  seats current         Show active homedirs and env
  seats use <id>        Activate a seat without launching
  seats health [tool|id]
                        Ask each signed-in seat to reply and show which work
  seats add [tool] [name]
                        Sign a new account in (claude | codex) without touching
                        the active one. Args after -- go to the tool's login.
  seats sync            Share config and trust between seats, and MCP servers,
                        skills and instructions across tools (--dry-run to preview)
  seats migrate         Move ~/.<tool>-* seat folders into ~/.config/seats
                        (--dry-run to preview)
  seats help            Show this help
  seats --version       Show the installed version

Examples:
  seats
  seats list api
  seats use claude:primary
  seats use api:openrouter
  seats health
  seats add claude work
  seats add codex personal -- --device-auth
`;

const help = async () => console.log(HELP);
const printVersion = async () => console.log(version);

/** Each command gets the arguments after its name. */
const commands: Record<string, (args: string[]) => Promise<void>> = {
  add: addCommand,
  current: currentCommand,
  health: healthCommand,
  help,
  "--help": help,
  "-h": help,
  "--version": printVersion,
  "-v": printVersion,
  list: listCommand,
  migrate: migrateCommand,
  sync: syncCommand,
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
