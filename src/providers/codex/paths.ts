import { join } from "node:path";

/** Codex's config folder: `$CODEX_HOME`, else `~/.codex`. */
export const codexHome = (home: string) => process.env.CODEX_HOME ?? join(home, ".codex");
