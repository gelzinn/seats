import type { Provider } from "../../types.ts";
import { ifDir } from "../helpers/seats.ts";
import { kiroMcp } from "./mcp.ts";
import { kiroHome } from "./paths.ts";
import { kiroSeats } from "./seats.ts";

export const kiro: Provider = {
  id: "kiro",
  label: "Kiro",
  seats: [kiroSeats],
  mcp: kiroMcp,
  // Kiro reads only its own skills folder.
  skills: [{ dir: (home) => ifDir(kiroHome(home), "skills") }],
  instructions: (home) => ifDir(kiroHome(home), "steering", "AGENTS.md"),
};
