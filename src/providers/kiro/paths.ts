import { join } from "node:path";

/** Kiro's config folder: `$KIRO_HOME`, else `~/.kiro`. */
export const kiroHome = (home: string) => process.env.KIRO_HOME ?? join(home, ".kiro");
