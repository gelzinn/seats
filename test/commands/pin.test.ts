import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tempHome } from "../helpers/temp-home.ts";

let env: ReturnType<typeof tempHome>;
beforeEach(() => (env = tempHome()));
afterEach(() => env.cleanup());

const cli = join(import.meta.dir, "../../src/cli.ts");

/** Runs seats in `project` under the temp HOME, with no tool config folder from this machine. */
function seats(project: string, ...args: string[]) {
  const vars = { ...process.env, HOME: env.home } as Record<string, string>;
  for (const name of ["SEATS_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) delete vars[name];
  return Bun.spawnSync(["bun", cli, ...args], { cwd: project, env: vars });
}

describe("seats pin and unpin", () => {
  test("check the seat exists before writing ./.seats, and delete the file once it's empty", () => {
    env.write(".config/seats/claude/work/.claude.json", "{}");
    const project = join(env.home, "project");
    mkdirSync(project);
    const file = join(project, ".seats");

    expect(seats(project, "pin", "claude:missing").exitCode).toBe(1);
    expect(seats(project, "pin", "claude:work", "--vscode").exitCode).toBe(1);
    expect(existsSync(file)).toBe(false);

    expect(seats(project, "pin", "claude:work").exitCode).toBe(0);
    expect(readFileSync(file, "utf8")).toBe('claude = "work"\n');
    expect(seats(project, "pin").stdout.toString()).toContain("claude:work");

    expect(seats(project, "unpin", "claude").exitCode).toBe(0);
    expect(existsSync(file)).toBe(false);
  });
});
