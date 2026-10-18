/** Tool-neutral MCP server, stored in `~/.config/seats/shared/mcp.json`. */
export type McpServer = {
  type: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** Tool ids this server is never written to. `["*"]` keeps it out of every tool. */
  skip?: string[];
  /**
   * Extra fields for one tool, by tool id, written into that tool's entry as
   * is, e.g. `{ codex: { startup_timeout_sec: 30 } }`. Kept in the library.
   */
  tools?: Record<string, ToolOptions>;
  /** This tool's `tools` entry, set only on the copy handed to one adapter's `add`. */
  options?: ToolOptions;
};

export type ToolOptionValue = string | number | boolean | string[];
export type ToolOptions = Record<string, ToolOptionValue>;

export type McpServers = Record<string, McpServer>;

/** How one tool keeps its user-level MCP servers. Declared in `src/providers/<id>/mcp.ts`. */
export type McpConfig = {
  /** Config file, or undefined when the tool isn't installed. */
  file: (home: string) => string | undefined;
  read: (file: string) => McpServers;
  /** Every server name in the file, including entries `read` can't convert. */
  names: (file: string) => string[];
  /**
   * Adds `servers` to the file without touching anything already there. Each
   * server's `options` (if any) go into its entry too, overriding seats' own fields.
   */
  add: (file: string, servers: McpServers) => void;
  /** Removes the servers named exactly as the file spells them, leaving everything else as it was. */
  remove: (file: string, names: string[]) => void;
  /**
   * Each seat's own copy of `file`, for tools whose seats keep one per account
   * that seats merges (Claude's `.claude.json`). `seats install` and
   * `seats uninstall` change every copy, so a merge can't bring a server back.
   */
  seatFiles?: (home: string) => string[];
  /** Servers that belong to the tool itself and must not spread to other tools. */
  internal?: string[];
  /** Server types the tool can't run. */
  unsupported?: McpServer["type"][];
  /** Servers whose credentials can't be carried to other tools. */
  warnings?: (file: string) => string[];
};

/** An `McpConfig` tagged with its provider id, as the sync sees it. */
export type McpAdapter = McpConfig & { id: string };
