import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { version } from "../../package.json";
import { type Check, doctorChecks } from "../../src/commands/doctor.ts";
import { excludeItem } from "../../src/commands/exclude.ts";
import { syncSeats } from "../../src/commands/sync.ts";
import { fakeHerdr, herdrHasPlugin } from "../helpers/fake-herdr.ts";
import { tempHome } from "../helpers/temp-home.ts";

let env: ReturnType<typeof tempHome>;
let herdr: ReturnType<typeof fakeHerdr>;
let seats: string;
beforeEach(() => {
  env = tempHome();
  herdr = fakeHerdr(env);
  seats = env.write("bin/seats", `#!/bin/sh\necho "\${SEATS_VERSION:-${version}}"\n`);
  Bun.spawnSync(["chmod", "+x", seats]);
});
afterEach(() => env.cleanup());

/** The checks with the fake `seats` (printing `seatsVersion`) and herdr on PATH. */
function checks({ seatsVersion = version } = {}): Check[] {
  return doctorChecks(env.home, {
    env: { ...process.env, FAKE_DIR: env.home, CLAUDE_CONFIG_DIR: "/somewhere", SEATS_VERSION: seatsVersion },
    which: (command) => (command === "seats" ? seats : command === "herdr" ? join(herdr.bin, "herdr") : null),
  });
}

const problems = (list: Check[]) => list.filter((check) => check.ok === false);

/** Two Claude seats, synced, with herdr's integrations current and the plugin linked from `root`. */
function healthy(root = env.home): void {
  env.write(".config/seats/claude/work/.claude.json", {});
  env.write(".config/seats/claude/personal/.claude.json", {});
  syncSeats(env.home, ["claude"]);
  env.write("integrations.txt", "claude: current (v11) (/x)\ncodex: current (v10) (/y)\n");
  herdrHasPlugin(env, { plugin_root: root });
}

/** Every file under the temp home with its mtime, to prove nothing was written. */
function snapshot(dir = env.home): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => !file.endsWith("herdr.log"))
    .map((file) => `${file} ${statSync(file).mtimeMs}`)
    .sort();
}

describe("seats doctor", () => {
  test("all good: only ✓, and herdr asked about integrations without the seat's config dir", () => {
    healthy();
    const list = checks();
    expect(problems(list)).toEqual([]);
    expect(list.map((check) => check.text)).toEqual([
      expect.stringContaining("seats is on your PATH"),
      expect.stringContaining("the session hook is in"),
      expect.stringContaining("herdr has the seats plugin, linked from"),
      "herdr's claude integration is installed",
    ]);
    expect(herdr.calls()).toEqual(["--version", "plugin list --json", "integration status"]);
  });

  test("never writes anything", () => {
    env.write(".config/seats/claude/work/.claude.json", {});
    env.write(".config/seats/claude/work/settings.json", {
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "bash '/a/hooks/x.sh'" }] }] },
    });
    env.write(".config/seats/claude/personal/.claude.json", {});
    const before = snapshot();
    checks();
    expect(snapshot()).toEqual(before);
  });

  test("a missing session hook, seat-specific hook paths and a seat with its own settings", () => {
    healthy();
    env.write(".config/seats/claude/acme/.claude.json", {});
    excludeItem(env.home, "claude:acme", "settings.json");
    env.write(".config/seats/claude/work/hooks/x.sh", "");
    syncSeats(env.home, ["claude"]);
    const work = join(env.home, ".config/seats/claude/work");
    env.write(".config/seats/shared/claude/settings.json", {
      hooks: { Stop: [{ hooks: [{ type: "command", command: `bash '${work}/hooks/x.sh'` }] }] },
    });
    const found = problems(checks());
    expect(found.map((check) => [check.text.replace(env.home, "~"), check.fix])).toEqual([
      ["the session hook isn't in ~/.config/seats/shared/claude/settings.json", "seats sync"],
      [
        "~/.config/seats/shared/claude/settings.json runs hooks through one seat's folder, or the same hook twice",
        "seats sync",
      ],
    ]);
    syncSeats(env.home, ["claude"]);
    const list = checks();
    expect(problems(list)).toEqual([]);
    expect(list[1]!.text).toEndWith("(not for claude:acme, which keep their own)");
  });

  test("seats missing from PATH, or another version there", () => {
    healthy();
    expect(problems(checks({ seatsVersion: "0.1.0" }))[0]!.text).toContain(`is 0.1.0, this one is ${version}`);
    const list = doctorChecks(env.home, { env: { ...process.env, FAKE_DIR: env.home }, which: () => null });
    expect(problems(list).map((check) => check.text)).toEqual([
      "seats isn't on your PATH: the session hook and the herdr plugin can't run it",
    ]);
    expect(list.at(-1)).toEqual({ text: "herdr isn't installed: skipped its checks" });
  });

  test("herdr: too old, no plugin, a plugin linked from a folder that's gone, disabled, integrations missing", () => {
    healthy();
    env.write("version.txt", "herdr 0.9.1");
    env.write("integrations.txt", "claude: not installed (/x)\n");
    env.write("plugins.json", { result: { plugins: [] } });
    expect(problems(checks()).map((check) => check.fix)).toEqual([
      "update herdr",
      "seats install plugin herdr",
      "herdr integration install claude",
    ]);
    herdrHasPlugin(env, { plugin_root: join(env.home, "gone") });
    expect(problems(checks())[1]!.fix).toBe("seats uninstall plugin herdr && seats install plugin herdr");
    herdrHasPlugin(env, { plugin_root: env.home, enabled: false });
    expect(problems(checks())[1]!.fix).toBe("herdr plugin enable seats.resume");
  });

  test("checks herdr's codex integration when there are Codex seats", () => {
    healthy();
    env.write(".codex/auth.json", "{}");
    env.write("integrations.txt", "claude: current (v11) (/x)\ncodex: outdated (v9 < v10) (/y)\n");
    expect(problems(checks()).map((check) => check.text)).toEqual([
      "herdr's codex integration is outdated: the plugin can't read codex's session ids",
    ]);
  });

  test("a Paseo config still pointing at integrations/paseo", () => {
    healthy();
    env.write(".paseo/config.json", {
      plugins: { seats: { source: "directory", path: "/src/seats/integrations/paseo" }, other: { path: "/x" } },
    });
    expect(problems(checks())).toEqual([
      {
        ok: false,
        text: 'Paseo loads plugin "seats" from /src/seats/integrations/paseo, which moved',
        fix: "set plugins.seats.path in ~/.paseo/config.json to /src/seats/plugins/paseo",
      },
    ]);
  });

  test("the command exits 1 when something needs fixing", () => {
    const cli = join(import.meta.dir, "../../src/cli.ts");
    symlinkSync(Bun.which("bun")!, join(herdr.bin, "bun"));
    const run = Bun.spawnSync(["bun", cli, "doctor"], {
      env: { HOME: env.home, PATH: herdr.bin, FAKE_DIR: env.home },
    });
    expect(run.exitCode).toBe(1);
    expect(run.stdout.toString()).toContain("! herdr doesn't have the seats plugin");
    expect(readFileSync(join(env.home, "herdr.log"), "utf8")).toContain("plugin list --json");
  });
});
