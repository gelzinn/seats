import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { version } from "../package.json";

const cli = join(import.meta.dir, "../src/cli.ts");

test("--version and -v print the package version", () => {
  for (const flag of ["--version", "-v"]) {
    const result = spawnSync(process.execPath, [cli, flag], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${version}\n`);
  }
});
