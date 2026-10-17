import { join } from "node:path";
import type { Provider } from "../../types.ts";
import { ifDir } from "../helpers/seats.ts";
import { opencodeApiSeats } from "./api.ts";
import { opencodeMcp } from "./mcp.ts";
import { opencodeSeats } from "./seats.ts";

const configDir = (home: string) => join(home, ".config", "opencode");

export const opencode: Provider = {
  id: "opencode",
  label: "OpenCode",
  seats: [opencodeSeats, opencodeApiSeats],
  mcp: opencodeMcp,
  // OpenCode reads ~/.agents/skills itself.
  skills: [{ native: true, dir: (home) => ifDir(configDir(home), "skills") }],
  instructions: (home) => ifDir(configDir(home), "AGENTS.md"),
};
