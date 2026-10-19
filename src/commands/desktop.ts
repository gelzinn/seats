import { homedir } from "node:os";
import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  desktopDir,
  invalidName,
  listProfiles,
  openProfile,
  profileDir,
  realHost,
  removeProfile,
} from "../providers/claude-desktop/index.ts";
import { cancelIfNeeded, fail, intro, table, tilde } from "./ui.ts";

const USAGE = "Usage: seats desktop open|list|remove <name>";

const when = (date: Date) =>
  date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

/** `seats desktop open <name>`: Claude Desktop on that account, beside any already open. */
async function open(name: string | undefined): Promise<void> {
  if (!name) fail(USAGE);
  const result = await openProfile(realHost(homedir()), name).catch((error: Error) => fail(error.message));
  p.log.success(`Opened Claude Desktop on ${pc.cyan(name)}`);
  p.log.message(pc.dim(tilde(result.dir)));
  if (!result.signedIn) {
    // Sign-in comes back through a claude:// link, which the system may hand to another open window.
    p.log.warn(
      "Sign in with the account for this profile. Quit every other Claude window first: " +
        "sign-in can finish in whichever window is open, and save the account there instead.",
    );
  }
  p.outro(pc.dim("Each account runs in its own window, beside the others."));
}

/** `seats desktop list` */
function list(): void {
  const profiles = listProfiles(homedir());
  if (profiles.length === 0) {
    p.log.message(`No desktop accounts yet. Run ${pc.cyan("seats desktop open <name>")} to add one.`);
    return;
  }
  const rows = profiles.map((profile) => [
    profile.signedIn ? profile.name : pc.dim(`${profile.name} (signed out)`),
    pc.dim(tilde(profile.dir)),
    when(profile.lastUsed),
  ]);
  console.log(table(["Name", "Folder", "Last used"], rows));
}

/** `seats desktop remove <name> [--yes]`: asks first, then deletes only that folder. */
async function remove(name: string | undefined, yes: boolean): Promise<void> {
  if (!name) fail(USAGE);
  const problem = invalidName(name);
  if (problem) fail(problem);
  const home = homedir();
  if (!listProfiles(home).some((profile) => profile.name === name)) fail(`No desktop account named ${name}.`);
  if (!yes) {
    const ok = await p.confirm({
      message: `Delete ${tilde(profileDir(home, name))}? Quit Claude on that account first. Its sign-in and local data go with it.`,
      initialValue: false,
    });
    cancelIfNeeded(ok);
    if (!ok) return p.outro("Nothing removed.");
  }
  const dir = removeProfile(home, name);
  p.outro(`Removed ${tilde(dir)}`);
}

/** `seats desktop open|list|remove`: Claude Desktop on several accounts, side by side. */
export async function desktopCommand([action, ...args]: string[]): Promise<void> {
  const name = args.find((arg) => !arg.startsWith("-"));
  if (action === "list") return list();
  intro();
  if (action === "open") return open(name);
  if (action === "remove") return remove(name, args.includes("--yes") || args.includes("-y"));
  fail(`${USAGE}\nAccounts live in ${tilde(desktopDir(homedir()))}.`);
}
