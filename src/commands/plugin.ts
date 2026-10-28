import { spawnSync } from "node:child_process";
import { join } from "node:path";
import pc from "picocolors";
import { version } from "../../package.json";
import { HERDR_PLUGIN_ID, HERDR_PLUGIN_REPO, herdrPlugin, herdrPluginDir } from "../herdr.ts";
import { fail, tilde } from "./ui.ts";

const PLUGINS = ["herdr", "paseo"];

/** Where the plugin comes from: the checkout's folder when there is one, else GitHub at this version's tag. */
export function herdrInstallArgs(dir: string | undefined): string[] {
  return dir ? ["plugin", "link", dir] : ["plugin", "install", HERDR_PLUGIN_REPO, "--ref", `v${version}`, "--yes"];
}

/**
 * Why the herdr plugin can't be set up here, or undefined when it can: it
 * needs `herdr`, and `seats` on the PATH, since herdr runs `seats hook herdr`.
 */
function herdrMissing(which: (command: string) => string | null): string | undefined {
  if (!which("herdr")) return "herdr isn't on your PATH. Install it first: https://herdr.dev";
  if (!which("seats")) {
    return "seats isn't on your PATH, and herdr runs `seats hook herdr`. Add the folder that holds seats to PATH, then restart the herdr server so it sees it.";
  }
  return undefined;
}

export type PluginOptions = {
  dryRun?: boolean;
  /** The plugin folder to link; given as undefined, there's no checkout. */
  dir?: string;
  which?: (command: string) => string | null;
  env?: NodeJS.ProcessEnv;
};

/** Runs herdr with `args`, its output on the terminal; its exit status becomes ours. */
function runHerdr(args: string[], env: NodeJS.ProcessEnv): void {
  const ran = spawnSync("herdr", args, { stdio: "inherit", env });
  if (ran.status !== 0) process.exitCode = ran.status ?? 1;
}

/** `seats install plugin herdr`: links or installs the herdr plugin, unless herdr has it already. */
export function installHerdrPlugin(options: PluginOptions = {}): void {
  const { dryRun = false, which = Bun.which, env = process.env } = options;
  const missing = herdrMissing(which);
  if (missing) fail(missing);
  const args = herdrInstallArgs("dir" in options ? options.dir : herdrPluginDir());
  const present = herdrPlugin("herdr", env);
  if (present) {
    const from = present.root ? ` from ${tilde(present.root)}` : "";
    console.log(`herdr already has ${HERDR_PLUGIN_ID}${from}.`);
    if (!present.enabled) console.log(pc.yellow(`It's disabled: herdr plugin enable ${HERDR_PLUGIN_ID}`));
    console.log(pc.dim("To change where it comes from: seats uninstall plugin herdr, then install it again."));
    return;
  }
  console.log(`${dryRun ? "Would run" : "Running"}: herdr ${args.join(" ")}`);
  if (dryRun) return;
  runHerdr(args, env);
}

/** `seats uninstall plugin herdr`: unlinks a linked plugin, uninstalls one from GitHub. */
export function uninstallHerdrPlugin({
  dryRun = false,
  which = Bun.which,
  env = process.env,
}: PluginOptions = {}): void {
  if (!which("herdr")) fail("herdr isn't on your PATH.");
  const present = herdrPlugin("herdr", env);
  if (present === undefined) fail("herdr didn't list its plugins.");
  if (!present) {
    console.log(`herdr doesn't have ${HERDR_PLUGIN_ID}.`);
    return;
  }
  const args = ["plugin", present.local ? "unlink" : "uninstall", HERDR_PLUGIN_ID];
  console.log(`${dryRun ? "Would run" : "Running"}: herdr ${args.join(" ")}`);
  if (dryRun) return;
  runHerdr(args, env);
}

/** Paseo has no command to add a plugin, and seats doesn't edit Paseo's config: it says how. */
function paseoSteps(command: "install" | "uninstall"): void {
  if (command === "uninstall") {
    console.log('Take "seats" out of "plugins" in ~/.paseo/config.json, then restart Paseo.');
    return;
  }
  const dir = herdrPluginDir();
  const paseo = dir ? join(dir, "..", "paseo") : "<seats checkout>/plugins/paseo";
  console.log(`The Paseo plugin runs from a seats checkout. In ~/.paseo/config.json, set:

  "plugins": { "seats": { "source": "directory", "path": "${paseo}" } }

then run npm install in ${tilde(paseo)} and reload the plugin in Paseo.`);
}

/** `seats install|uninstall plugin <name> [--dry-run]` */
export async function pluginCommand(command: "install" | "uninstall", args: string[]): Promise<void> {
  const dryRun = args.includes("--dry-run");
  const [name] = args.filter((arg) => !arg.startsWith("--"));
  if (!name || !PLUGINS.includes(name)) {
    fail(
      `${name ? `Unknown plugin "${name}". ` : ""}Use seats ${command} plugin herdr or seats ${command} plugin paseo.`,
    );
  }
  if (name === "paseo") return paseoSteps(command);
  if (command === "install") installHerdrPlugin({ dryRun });
  else uninstallHerdrPlugin({ dryRun });
}
