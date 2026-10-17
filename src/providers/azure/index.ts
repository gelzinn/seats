import type { Provider } from "../../types.ts";
import { azureSeats } from "./seats.ts";

export const azure: Provider = {
  id: "azure",
  label: "Azure",
  seats: [azureSeats],
};
