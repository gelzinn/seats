import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Env vars that would point seats, or a tool's config folder, outside the temp HOME. */
const HOME_OVERRIDES = ["SEATS_HOME", "CODEX_HOME", "COPILOT_HOME", "GEMINI_CLI_HOME", "KIRO_HOME"];

/** Throwaway HOME for tests. Clears the overrides above so every path resolves inside it. */
export function tempHome(): { home: string; write: (path: string, data: unknown) => string; cleanup: () => void } {
  for (const name of HOME_OVERRIDES) delete process.env[name];
  const home = mkdtempSync(join(tmpdir(), "seats-test-"));
  return {
    home,
    write(path, data) {
      const full = join(home, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, typeof data === "string" ? data : JSON.stringify(data, null, 2), { mode: 0o600 });
      return full;
    },
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}
