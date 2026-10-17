import type { Provider } from "../../types.ts";
import { ifDir } from "../helpers/seats.ts";
import { copilotMcp } from "./mcp.ts";
import { copilotHome } from "./paths.ts";
import { copilotSeats } from "./seats.ts";

export const copilot: Provider = {
  id: "copilot",
  label: "Copilot CLI",
  seats: [copilotSeats],
  mcp: copilotMcp,
  // Copilot CLI reads ~/.agents/skills itself.
  skills: [{ native: true, dir: (home) => ifDir(copilotHome(home), "skills") }],
  instructions: (home) => ifDir(copilotHome(home), "copilot-instructions.md"),
};
