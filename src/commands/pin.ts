import { homedir } from "node:os";
import pc from "picocolors";
import { listSeatDirs } from "../lib.ts";
import { findPin, findPins, PIN_FILE, removePin, writePin } from "../pins.ts";
import { seatSources } from "../providers/index.ts";
import { fail, tilde } from "./ui.ts";

/** The pins in effect in `cwd`, one line each with the file it comes from. */
export function pinLines(cwd = process.cwd()): string[] {
  return [...findPins(cwd).values()].map((pin) => `${pin.tool}:${pin.slug} ${pc.dim(`from ${tilde(pin.file)}`)}`);
}

/** Tools whose seats are folders, the only ones a project can pin. */
const pinnable = () => seatSources.filter((source) => source.kind === "cli" && source.livePath);

/** `seats pin [tool:seat]`: pin a seat in `./.seats`, or show the pins in effect here. */
export async function pinCommand(args: string[]): Promise<void> {
  if (args.includes("--vscode"))
    fail(
      "seats can't pin the VS Code extension: its claudeCode.environmentVariables setting is machine-scoped, so VS Code ignores it in .vscode/settings.json.",
    );
  const flag = args.find((arg) => arg.startsWith("-"));
  if (flag) fail(`seats pin doesn't take ${flag}.`);
  const [id] = args;
  if (!id) {
    const lines = pinLines();
    console.log(lines.length > 0 ? lines.join("\n") : "No seat is pinned here. Pin one with seats pin claude:work.");
    return;
  }
  const [tool = "", slug] = id.split(/:(.*)/);
  const names = pinnable()
    .map((source) => source.id)
    .join(", ");
  if (!slug) fail("Pass a seat id, e.g. seats pin claude:work.");
  if (!pinnable().some((source) => source.id === tool)) fail(`seats can't pin "${tool}". Try one of: ${names}.`);
  if (!listSeatDirs(tool, homedir()).some((item) => item.slug === slug))
    fail(`There's no ${id} seat. See seats list ${tool}.`);
  const file = writePin(process.cwd(), tool, slug);
  console.log(`Pinned ${id} in ${tilde(file)}.`);
}

/** `seats unpin <tool>`: take the tool out of `./.seats`, deleting the file once it's empty. */
export async function unpinCommand([tool]: string[]): Promise<void> {
  if (!tool) fail("Name the tool to unpin, e.g. seats unpin claude.");
  if (!removePin(process.cwd(), tool)) fail(`./${PIN_FILE} doesn't pin ${tool}.`);
  const still = findPin(tool);
  console.log(
    still
      ? `Unpinned ${tool} here. ${tool}:${still.slug} still applies, from ${tilde(still.file)}.`
      : `Unpinned ${tool}. The active seat applies here again.`,
  );
}
