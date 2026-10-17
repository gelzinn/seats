import type { Provider } from "../../types.ts";
import { gcloudSeats } from "./seats.ts";

export const gcloud: Provider = {
  id: "gcloud",
  label: "Google Cloud",
  seats: [gcloudSeats],
};
