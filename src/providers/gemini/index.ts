import type { Provider } from "../../types.ts";
import { ifDir } from "../helpers/seats.ts";
import { geminiMcp } from "./mcp.ts";
import { geminiHome } from "./paths.ts";
import { geminiSeats } from "./seats.ts";

export const gemini: Provider = {
  id: "gemini",
  label: "Gemini CLI",
  seats: [geminiSeats],
  mcp: geminiMcp,
  // Gemini CLI reads ~/.agents/skills itself.
  skills: [{ native: true, dir: (home) => ifDir(geminiHome(home), "skills") }],
  // Antigravity reads this file too.
  instructions: (home) => ifDir(geminiHome(home), "GEMINI.md"),
};
