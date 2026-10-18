import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addSeat, invalidSlug, loginSources, type Runner } from "../../src/commands/add.ts";
import { seatSourceById } from "../../src/providers/index.ts";
import { tempHome } from "../helpers/temp-home.ts";

let env: ReturnType<typeof tempHome>;
afterEach(() => env?.cleanup());

const codex = seatSourceById("codex");

/** A fake `codex login` that records how it was called and optionally signs in. */
function fakeLogin(signIn: boolean) {
  const calls: Array<{ command: string; args: string[]; env: Record<string, string> }> = [];
  const run: Runner = async (command, args, vars) => {
    calls.push({ command, args, env: vars });
    const dir = vars.CODEX_HOME!;
    writeFileSync(join(dir, "version.json"), "{}"); // CLIs write files before sign-in finishes
    if (signIn) writeFileSync(join(dir, "auth.json"), "{}");
    return signIn ? 0 : 1;
  };
  return { run, calls };
}

describe("addSeat", () => {
  test("signs in inside a new store folder and shares config with existing seats", async () => {
    env = tempHome();
    const { home, write } = env;
    write(".config/seats/codex/work/auth.json", "work");
    write(".config/seats/codex/work/config.toml", "model = 'gpt'\n");
    const login = fakeLogin(true);

    const result = await addSeat(home, codex, "personal", { run: login.run, extraArgs: ["--device-auth"] });

    const dir = join(home, ".config/seats/codex/personal");
    expect(result.id).toBe("codex:personal");
    expect(result.dir).toBe(dir);
    expect(login.calls).toEqual([{ command: "codex", args: ["login", "--device-auth"], env: { CODEX_HOME: dir } }]);
    expect(lstatSync(join(dir, "auth.json")).isFile()).toBe(true);
    expect(lstatSync(join(dir, "config.toml")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(dir, "config.toml"), "utf8")).toContain("gpt");
    expect(readFileSync(join(home, ".config/seats/codex/work/auth.json"), "utf8")).toBe("work");
  });

  test("removes the folder when sign-in doesn't finish", async () => {
    env = tempHome();
    await expect(addSeat(env.home, codex, "work", { run: fakeLogin(false).run })).rejects.toThrow(
      "Sign-in didn't finish",
    );
    expect(existsSync(join(env.home, ".config/seats/codex/work"))).toBe(false);
  });

  test("removes the folder when the CLI can't start", async () => {
    env = tempHome();
    const missing: Runner = async () => {
      throw new Error("spawn codex ENOENT");
    };
    await expect(addSeat(env.home, codex, "work", { run: missing })).rejects.toThrow("ENOENT");
    expect(existsSync(join(env.home, ".config/seats/codex/work"))).toBe(false);
  });

  test("refuses a name that is taken, reserved or malformed", async () => {
    env = tempHome();
    env.write(".codex-legacy/auth.json", "{}");
    const run = fakeLogin(true).run;

    await expect(addSeat(env.home, codex, "legacy", { run })).rejects.toThrow("codex:legacy already exists");
    expect(invalidSlug(env.home, codex, "default")).toContain("reserved");
    expect(invalidSlug(env.home, codex, "Work Team")).toContain("lowercase");
    expect(invalidSlug(env.home, codex, "side-project")).toBeUndefined();
  });
});

describe("addSeat on a seat that exists but is signed out", () => {
  test("signs in again in the same folder and keeps its files", async () => {
    env = tempHome();
    const settings = env.write(".codex-work/config.toml", "model = 'gpt'\n");
    const login = fakeLogin(true);

    const result = await addSeat(env.home, codex, "work", { run: login.run });

    expect(result).toMatchObject({ id: "codex:work", dir: join(env.home, ".codex-work"), reused: true });
    expect(login.calls[0]!.env).toEqual({ CODEX_HOME: join(env.home, ".codex-work") });
    expect(readFileSync(settings, "utf8")).toBe("model = 'gpt'\n");
  });

  test("leaves the folder alone when sign-in doesn't finish", async () => {
    env = tempHome();
    const settings = env.write(".codex-work/config.toml", "model = 'gpt'\n");
    await expect(addSeat(env.home, codex, "work", { run: fakeLogin(false).run })).rejects.toThrow("the seat is unchanged");
    expect(readFileSync(settings, "utf8")).toBe("model = 'gpt'\n");
  });
});

describe("loginSources", () => {
  test("only offers CLIs that keep their login inside the seat folder", () => {
    expect(loginSources().map((source) => source.id)).toEqual(["claude", "codex"]);
  });
});
