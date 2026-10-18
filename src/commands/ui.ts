import { homedir } from "node:os";
import { stripVTControlCharacters } from "node:util";
import * as p from "@clack/prompts";
import pc from "picocolors";
import type { Seat, SeatKind } from "../types.ts";

export const KINDS: SeatKind[] = ["cli", "api", "cloud"];

export function tilde(path: string): string {
  const home = homedir();
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

export function intro(): void {
  p.intro(pc.bgCyan(pc.black(" seats ")));
}

/** Exits quietly when the user cancels a prompt (Ctrl+C / Esc). */
export function cancelIfNeeded<T>(value: T | symbol): asserts value is T {
  if (p.isCancel(value)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }
}

export function fail(message: string): never {
  p.cancel(message);
  process.exit(1);
}

export function formatSeat(seat: Seat): string {
  const who = seat.email ? pc.dim(` ${seat.email}`) : "";
  return `${pc.dim(seat.kind)}  ${pc.cyan(seat.provider)} · ${seat.label}${who}`;
}

const visibleLength = (text: string) => stripVTControlCharacters(text).length;
const pad = (text: string, width: number) => text + " ".repeat(Math.max(0, width - visibleLength(text)));

/** A boxed table with a bold header row. Cells may contain colors. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, column) =>
    Math.max(visibleLength(header), ...rows.map((row) => visibleLength(row[column] ?? ""))),
  );
  const line = (left: string, middle: string, right: string) =>
    pc.dim(left + widths.map((width) => "─".repeat(width + 2)).join(middle) + right);
  const row = (cells: string[]) =>
    `${pc.dim("│")} ${cells.map((cell, column) => pad(cell, widths[column]!)).join(` ${pc.dim("│")} `)} ${pc.dim("│")}`;
  return [
    line("┌", "┬", "┐"),
    row(headers.map((header) => pc.bold(header))),
    line("├", "┼", "┤"),
    ...rows.map(row),
    line("└", "┴", "┘"),
  ].join("\n");
}
