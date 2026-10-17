import { join } from "node:path";
import type { Provider } from "../../types.ts";
import { ifDir } from "../helpers/seats.ts";
import { cursorMcp } from "./mcp.ts";

/** No seats: Cursor keeps one sign-in. User rules live in its UI, so there's no instructions file. */
export const cursor: Provider = {
  id: "cursor",
  label: "Cursor",
  mcp: cursorMcp,
  // Cursor reads ~/.agents/skills itself.
  skills: [{ native: true, dir: (home) => ifDir(join(home, ".cursor"), "skills") }],
};
