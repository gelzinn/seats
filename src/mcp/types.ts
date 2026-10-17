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
};

export type McpServers = Record<string, McpServer>;

/** How one tool keeps its user-level MCP servers. Declared in `src/providers/<id>/mcp.ts`. */
export type McpConfig = {
  /** Config file, or undefined when the tool isn't installed. */
  file: (home: string) => string | undefined;
  read: (file: string) => McpServers;
  /** Every server name in the file, including entries `read` can't convert. */
  names: (file: string) => string[];
  /** Adds `servers` to the file without touching anything already there. */
  add: (file: string, servers: McpServers) => void;
  /** Servers that belong to the tool itself and must not spread to other tools. */
  internal?: string[];
  /** Server types the tool can't run. */
  unsupported?: McpServer["type"][];
  /** Servers whose credentials can't be carried to other tools. */
  warnings?: (file: string) => string[];
};

/** An `McpConfig` tagged with its provider id, as the sync sees it. */
export type McpAdapter = McpConfig & { id: string };
