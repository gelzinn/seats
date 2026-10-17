import { join } from "node:path";

/** Copilot CLI's config folder: `$COPILOT_HOME`, else `~/.copilot`. */
export const copilotHome = (home: string) => process.env.COPILOT_HOME ?? join(home, ".copilot");
