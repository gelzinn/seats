import type { McpConfig } from "./mcp/types.ts";

export type SeatKind = "cli" | "api" | "cloud";

export type Seat = {
  id: string;
  /** Id of the `SeatSource` that found this seat. */
  source: string;
  provider: string;
  kind: SeatKind;
  label: string;
  dir?: string;
  email?: string;
  /** Subscription, e.g. "Max 20x", "Team", "Plus", when the tool reports it. */
  plan?: string;
  signedIn: boolean;
  /** In-memory only. Never printed. */
  env?: Record<string, string>;
  extraLinks?: Array<{ live: string; target: string }>;
};

/** One way a provider's accounts show up: CLI config folders, API keys or cloud profiles. */
export type SeatSource = {
  /** Also names the store folders: `~/.config/seats/<id>/` and `shared/<id>/`. */
  id: string;
  label: string;
  kind: SeatKind;
  binary?: string;
  /** Path the CLI reads, which seats turns into a symlink to the active seat. */
  livePath?: (home: string) => string;
  extraLivePaths?: (home: string) => string[];
  discover: (home: string) => Promise<Seat[]>;
  /** Env var the CLI reads to pick its config folder, set when launching a seat. */
  configDirEnv?: string;
  /** Paths inside a seat folder that every seat of this source shares. */
  sharedItems?: string[];
  /**
   * Merges per-seat state that can't be a shared file, reading every seat in
   * `dirs` but writing only `options.targets`. Returns the files it rewrote.
   */
  mergeSeats?: (dirs: string[], options?: MergeOptions) => string[];
  /**
   * Hooks the CLI runs by itself from the shared settings file `item`, so
   * every session, plain `claude` too, reaches `command`. `add` returns the
   * settings with them, or undefined when they're already there.
   */
  sessionHook?: {
    item: string;
    add: (settings: Record<string, unknown>, command: string) => Record<string, unknown> | undefined;
  };
  /** Seat files that may hold absolute paths to the seat folder, rewritten by `seats migrate`. */
  pathFiles?: string[];
  /** Shared items that only hold on this machine (downloads, folder trust), left out of `seats export`. */
  machineItems?: string[];
  /**
   * How `seats export` carries a shared file that isn't plain JSON, by item
   * name. Shared JSON files need nothing here: their `env` and `headers` are handled for every tool.
   */
  exportFiles?: Record<string, (text: string, secret: SecretRef) => PortableText>;
  /**
   * How `seats add` signs a new account in: `binary` runs with `args` and
   * `configDirEnv` pointing at the new seat folder. Only for CLIs that keep
   * credentials inside that folder, so accounts don't overwrite each other.
   */
  login?: {
    args: string[];
    /** True once the folder holds a signed-in account. */
    signedIn: (dir: string) => boolean | Promise<boolean>;
    /**
     * What the CLI prints when it waits for a code pasted from the browser.
     * seats asks for the code itself instead, showing what was pasted as `*`.
     */
    codePrompt?: string;
    /** Args that sign the account out, run by `seats remove` before it deletes the folder. */
    logoutArgs?: string[];
  };
  /**
   * How `seats health` asks a seat one short question, non-interactively, on
   * the tool's cheapest model: `binary` runs with `args` and `configDirEnv`
   * pointing at `dir`. `model` is what gets reported; the reply is the last
   * line the CLI prints.
   */
  health?: (prompt: string, dir: string) => { args: string[]; model?: string };
  /** Current usage of the account in `dir`, read without spending any. Undefined when it can't be read. */
  usage?: (dir: string) => Promise<Usage | undefined>;
  /** Like `usage`, but says why it couldn't be read. Used by `seats usage`. */
  readUsage?: (dir: string) => Promise<UsageReading>;
  /**
   * How a supervised session moves to another seat when this one hits its
   * limit mid-session (`seats auto-switch`). Needs a CLI hook that reports it.
   */
  failover?: {
    /** Settings that make the CLI run `command` when a turn fails on a rate limit. */
    hookSettings: (command: string) => unknown;
    /** Args that load the settings file written from `hookSettings`. */
    settingsArgs: (file: string) => string[];
    /** Args that reopen a session, optionally sending `prompt` first. */
    resumeArgs: (sessionId: string, prompt?: string) => string[];
  };
  /**
   * The conversations a seat keeps. With `list`, for `seats sessions` and
   * `seats move`: a session is one file that resumes from the same path in
   * any seat. With only `find`, seats can name the seat that has a session
   * (`seats hook herdr`) but never lists or copies them.
   */
  sessions?: {
    /** Conversations kept in the seat folder `dir`, in no particular order. */
    list?: (dir: string) => Session[];
    /** Args that reopen a session. */
    resumeArgs: (sessionId: string) => string[];
    /** The transcript of session `sessionId` in seat folder `dir`, when the seat has it. Fast: reads no transcript. */
    find?: (dir: string, sessionId: string) => string | undefined;
    /** The session that CLI args reopen, read back from what `resumeArgs` writes; undefined for a new session. */
    resumedId?: (args: string[]) => string | undefined;
  };
};

/** What `SeatSource.mergeSeats` carries between seats, and where it writes. */
export type MergeOptions = {
  /** MCP servers that seat must not get. */
  keptOut?: (dir: string) => string[];
  /** True for a seat that keeps its own folder trust: it neither gives nor gets any. */
  ownTrust?: (dir: string) => boolean;
  /** Seats to write. Defaults to all of them. */
  targets?: string[];
};

/** One conversation, read from the start and end of its transcript. */
export type Session = {
  id: string;
  /** The transcript, inside the seat folder. */
  file: string;
  /** Folder the conversation ran in, as the transcript recorded it. */
  cwd?: string;
  title: string;
  updatedAt: Date;
};

/**
 * Records a literal secret found while exporting and returns the env var name
 * that replaces it: the first of `names` not already taken by another value.
 * Undefined when `value` is already a reference such as `${TOKEN}`, or a file path.
 */
export type SecretRef = (value: string, ...names: string[]) => string | undefined;

/** A file rewritten for `seats export`, with what was left out of it. */
export type PortableText = { text: string; dropped: string[] };

/** `label` is how the window is shown, e.g. "5h", "Week", "Week (opus)". Defaults to `name`. */
export type UsageWindow = { name: string; label?: string; usedPercent: number; resetsAt?: Date };
export type Usage = { windows: UsageWindow[] };
/**
 * Why usage couldn't be read: the seat has no token, its token expired (seats
 * never refreshes it; the tool does on its next start), or the request failed.
 */
export type UsageError = "no-token" | "expired" | "failed";
export type UsageReading = { usage: Usage; error?: never } | { usage?: never; error: UsageError };

/** A folder where the tool keeps user skills. */
export type SkillsDir = {
  /** Shown in reports. Defaults to the provider id. */
  id?: string;
  /** Skills folder, or undefined when the tool isn't installed. */
  dir: (home: string) => string | undefined;
  /**
   * The tool reads `~/.agents/skills` itself. Its own skills move to the
   * library without a link back, and it never gets links (they'd show twice).
   */
  native?: boolean;
};

/**
 * Everything seats knows about one tool, defined in `src/providers/<id>/`.
 * Each part is optional: Cursor has no seats, AWS has no MCP config.
 */
export type Provider = {
  id: string;
  label: string;
  seats?: SeatSource[];
  /** User-level MCP config, kept in step by `seats sync`. */
  mcp?: McpConfig;
  skills?: SkillsDir[];
  /** Global instructions file, or undefined when the tool isn't installed. */
  instructions?: (home: string) => string | undefined;
};
