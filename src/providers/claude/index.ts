import { join } from "node:path";
import type { Provider } from "../../types.ts";
import { ifDir } from "../helpers/seats.ts";
import { claudeMcp } from "./mcp.ts";
import { claudeSeats } from "./seats.ts";

export const claude: Provider = {
  id: "claude",
  label: "Claude Code",
  seats: [claudeSeats],
  mcp: claudeMcp,
  // Claude reads only its own skills folder, not ~/.agents/skills.
  skills: [{ dir: (home) => ifDir(join(home, ".claude"), "skills") }],
  instructions: (home) => ifDir(join(home, ".claude"), "CLAUDE.md"),
};
