import type { InstructionsTarget } from "../instructions.ts";
import type { McpAdapter } from "../mcp/types.ts";
import type { SkillsTarget } from "../skills.ts";
import type { Provider, SeatSource } from "../types.ts";
import { antigravity } from "./antigravity/index.ts";
import { aws } from "./aws/index.ts";
import { azure } from "./azure/index.ts";
import { claude } from "./claude/index.ts";
import { codex } from "./codex/index.ts";
import { commandcode } from "./commandcode/index.ts";
import { copilot } from "./copilot/index.ts";
import { cursor } from "./cursor/index.ts";
import { gcloud } from "./gcloud/index.ts";
import { gemini } from "./gemini/index.ts";
import { kiro } from "./kiro/index.ts";
import { opencode } from "./opencode/index.ts";

/**
 * Every provider seats knows. To add one, create `src/providers/<id>/` and list it here.
 *
 * Order matters: it's the order of the picker, and when two tools disagree
 * (an MCP server name, the first instructions file) the earlier one wins.
 */
export const providers: Provider[] = [
  claude,
  codex,
  cursor,
  gemini,
  opencode,
  antigravity,
  copilot,
  kiro,
  commandcode,
  aws,
  gcloud,
  azure,
];

/** Where accounts come from, in provider order. */
export const seatSources: SeatSource[] = providers.flatMap((provider) => provider.seats ?? []);

export function seatSourceById(id: string): SeatSource {
  const found = seatSources.find((source) => source.id === id);
  if (!found) throw new Error(`Unknown seat source: ${id}`);
  return found;
}

export const mcpAdapters: McpAdapter[] = providers.flatMap((provider) =>
  provider.mcp ? [{ ...provider.mcp, id: provider.id }] : [],
);

export const skillsTargets: SkillsTarget[] = providers.flatMap((provider) =>
  (provider.skills ?? []).map((skills) => ({ ...skills, id: skills.id ?? provider.id })),
);

export const instructionsTargets: InstructionsTarget[] = providers.flatMap((provider) =>
  provider.instructions ? [{ id: provider.id, file: provider.instructions }] : [],
);
