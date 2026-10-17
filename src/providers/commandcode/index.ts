import { join } from "node:path";
import type { Provider } from "../../types.ts";
import { ifDir } from "../helpers/seats.ts";
import { commandCodeApiSeats } from "./api.ts";
import { commandCodeSeats } from "./seats.ts";

export const commandcode: Provider = {
  id: "commandcode",
  label: "Command Code",
  seats: [commandCodeSeats, commandCodeApiSeats],
  skills: [{ dir: (home) => ifDir(join(home, ".commandcode"), "skills") }],
};
