import { join } from "node:path";
import type { Provider } from "../../types.ts";
import { ifDir } from "../helpers/seats.ts";
import { antigravityMcp } from "./mcp.ts";
import { antigravitySeats } from "./seats.ts";

/** Global instructions come from ~/.gemini/GEMINI.md, which the Gemini provider manages. */
export const antigravity: Provider = {
  id: "antigravity",
  label: "Antigravity",
  seats: [antigravitySeats],
  mcp: antigravityMcp,
  // The app and the CLI each read their own skills folder.
  skills: [
    { dir: (home) => ifDir(join(home, ".gemini", "config"), "skills") },
    { id: "antigravity-cli", dir: (home) => ifDir(join(home, ".gemini", "antigravity-cli"), "skills") },
  ],
};
