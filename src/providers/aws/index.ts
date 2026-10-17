import type { Provider } from "../../types.ts";
import { awsSeats } from "./seats.ts";

export const aws: Provider = {
  id: "aws",
  label: "AWS",
  seats: [awsSeats],
};
