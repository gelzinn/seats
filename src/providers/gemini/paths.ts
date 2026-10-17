import { join } from "node:path";

/** Gemini CLI's config folder. `$GEMINI_CLI_HOME` is its parent, not the folder itself. */
export const geminiHome = (home: string) => join(process.env.GEMINI_CLI_HOME ?? home, ".gemini");
