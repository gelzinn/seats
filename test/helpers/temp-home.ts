import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Throwaway HOME for tests. Clears SEATS_HOME so the store resolves inside it. */
export function tempHome(): { home: string; write: (path: string, data: unknown) => string; cleanup: () => void } {
  delete process.env.SEATS_HOME;
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
