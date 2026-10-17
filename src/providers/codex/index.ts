import type { Provider } from "../../types.ts";
import { ifDir } from "../helpers/seats.ts";
import { codexMcp } from "./mcp.ts";
import { codexHome } from "./paths.ts";
import { codexSeats } from "./seats.ts";

export const codex: Provider = {
  id: "codex",
  label: "Codex",
  seats: [codexSeats],
  mcp: codexMcp,
  // Codex reads ~/.agents/skills itself.
  skills: [{ native: true, dir: (home) => ifDir(codexHome(home), "skills") }],
  instructions: (home) => ifDir(codexHome(home), "AGENTS.md"),
};
