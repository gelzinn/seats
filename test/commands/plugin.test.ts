import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { version } from "../../package.json";
import { herdrInstallArgs, installHerdrPlugin, uninstallHerdrPlugin } from "../../src/commands/plugin.ts";
import { herdrPluginDir } from "../../src/herdr.ts";
import { fakeHerdr, herdrHasPlugin } from "../helpers/fake-herdr.ts";
import { tempHome } from "../helpers/temp-home.ts";

let env: ReturnType<typeof tempHome>;
let herdr: ReturnType<typeof fakeHerdr>;
let printed: string[];
beforeEach(() => {
  env = tempHome();
  herdr = fakeHerdr(env);
  printed = [];
  spyOn(console, "log").mockImplementation((...args) => void printed.push(args.join(" ")));
});
afterEach(() => {
  env.cleanup();
  (console.log as unknown as { mockRestore: () => void }).mockRestore();
  process.exitCode = 0;
});

const options = () => ({
  env: { ...process.env, PATH: `${herdr.bin}:${process.env.PATH}`, FAKE_DIR: env.home },
  which: (command: string) => (command === "herdr" ? join(herdr.bin, "herdr") : `/usr/bin/${command}`),
});

describe("seats install plugin herdr", () => {
  test("links the checkout's plugin folder", () => {
    expect(herdrPluginDir()).toBe(join(import.meta.dir, "../../plugins/herdr"));
    installHerdrPlugin({ ...options(), dir: "/src/seats/plugins/herdr" });
    expect(herdr.calls()).toEqual(["plugin list --json", "plugin link /src/seats/plugins/herdr"]);
  });

  test("installs from GitHub at this version's tag without a checkout", () => {
    expect(herdrInstallArgs(undefined)).toEqual([
      "plugin",
      "install",
      "gelzinn/seats/plugins/herdr",
      "--ref",
      `v${version}`,
      "--yes",
    ]);
    installHerdrPlugin({ ...options(), dir: undefined });
    expect(herdr.calls()[1]).toBe(`plugin install gelzinn/seats/plugins/herdr --ref v${version} --yes`);
  });

  test("--dry-run prints the command and runs nothing but the list", () => {
    installHerdrPlugin({ ...options(), dir: "/p", dryRun: true });
    expect(printed).toEqual(["Would run: herdr plugin link /p"]);
    expect(herdr.calls()).toEqual(["plugin list --json"]);
  });

  test("leaves a plugin herdr already has", () => {
    herdrHasPlugin(env, { plugin_root: "/elsewhere", enabled: false });
    installHerdrPlugin({ ...options(), dir: "/p" });
    expect(herdr.calls()).toEqual(["plugin list --json"]);
    expect(printed[0]).toBe("herdr already has seats.resume from /elsewhere.");
    expect(printed[1]).toContain("herdr plugin enable seats.resume");
  });
});

describe("seats uninstall plugin herdr", () => {
  test("unlinks a linked plugin and uninstalls one from GitHub", () => {
    herdrHasPlugin(env, { plugin_root: "/p" });
    uninstallHerdrPlugin(options());
    herdrHasPlugin(env, { source: { kind: "github" } });
    uninstallHerdrPlugin(options());
    expect(herdr.calls().filter((call) => !call.includes("list"))).toEqual([
      "plugin unlink seats.resume",
      "plugin uninstall seats.resume",
    ]);
  });

  test("says so when herdr doesn't have it", () => {
    uninstallHerdrPlugin(options());
    expect(printed).toEqual(["herdr doesn't have seats.resume."]);
  });
});

describe("the command", () => {
  const cli = join(import.meta.dir, "../../src/cli.ts");
  const run = (args: string[], path: string) =>
    Bun.spawnSync(["bun", cli, ...args], { env: { ...process.env, HOME: env.home, FAKE_DIR: env.home, PATH: path } });
  const bun = Bun.which("bun")!;

  test("fails clearly without herdr, or without seats on PATH", () => {
    const noHerdr = run(["install", "plugin", "herdr"], join(bun, ".."));
    expect(noHerdr.exitCode).toBe(1);
    expect(noHerdr.stdout.toString()).toContain("herdr isn't on your PATH");

    const noSeats = run(["install", "plugin", "herdr"], `${herdr.bin}:${join(bun, "..")}`);
    expect(noSeats.exitCode).toBe(1);
    expect(noSeats.stdout.toString()).toContain("seats isn't on your PATH");
    expect(herdr.calls()).toEqual([]);
  });

  test("names the plugins it knows", () => {
    const unknown = run(["install", "plugin", "tmux"], process.env.PATH!);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stdout.toString()).toContain("seats install plugin herdr");
  });
});
