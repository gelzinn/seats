import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { tempHome } from "./temp-home.ts";

/**
 * A fake `herdr` in `<home>/bin`: logs each call to `herdr.log`, answers
 * `plugin list --json` from `plugins.json` (none when missing), `integration
 * status` from `integrations.txt` and `--version` from `version.txt`.
 */
export function fakeHerdr(env: ReturnType<typeof tempHome>): { bin: string; calls: () => string[] } {
  const bin = env.write(
    "bin/herdr",
    `#!/bin/bash
echo "$*" >> "$FAKE_DIR/herdr.log"
answer() { if [ -e "$FAKE_DIR/$1" ]; then cat "$FAKE_DIR/$1"; else echo "$2"; fi; }
case "$*" in
  "--version") answer version.txt "herdr 0.9.5" ;;
  "plugin list --json") answer plugins.json '{"id":"cli:plugin","result":{"plugins":[],"type":"plugin_list"}}' ;;
  "integration status") answer integrations.txt "" ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  const log = join(env.home, "herdr.log");
  return {
    bin: join(env.home, "bin"),
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []),
  };
}

/** `plugin list --json` with the seats plugin in it. */
export function herdrHasPlugin(env: ReturnType<typeof tempHome>, plugin: Record<string, unknown>): void {
  const info = { plugin_id: "seats.resume", enabled: true, source: { kind: "local" }, ...plugin };
  env.write("plugins.json", { id: "cli:plugin", result: { type: "plugin_list", plugins: [info] } });
}
