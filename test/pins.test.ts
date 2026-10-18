import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findPin, findPins, parsePins, removePin, writePin } from "../src/pins.ts";
import { tempHome } from "./helpers/temp-home.ts";

let env: ReturnType<typeof tempHome>;
beforeEach(() => (env = tempHome()));
afterEach(() => env.cleanup());

describe("parsePins", () => {
  test("reads tool = seat lines, with or without quotes, and skips comments and lines it doesn't know", () => {
    const pins = parsePins(`# ~/clients/acme/.seats
claude = "acme"   # the client's account
  codex='work'
gemini=personal

[section]
just text
= "no tool"
copilot =
claude = "acme-2"
`);
    expect(Object.fromEntries(pins)).toEqual({ claude: "acme-2", codex: "work", gemini: "personal" });
  });
});

describe("findPins", () => {
  test("each tool takes the nearest .seats that names it, walking up", () => {
    const outer = env.write("clients/.seats", 'claude = "client"\ncodex = "work"\n');
    const inner = env.write("clients/acme/.seats", 'claude = "acme"\n');
    const cwd = join(env.home, "clients/acme/src/deep");

    expect(findPin("claude", cwd)).toEqual({ tool: "claude", slug: "acme", file: inner });
    expect(findPin("codex", cwd)).toEqual({ tool: "codex", slug: "work", file: outer });
    expect(findPin("gemini", cwd)).toBeUndefined();
    expect(findPin("claude", join(env.home, "clients"))?.slug).toBe("client");
    expect([...findPins(cwd).keys()]).toEqual(["claude", "codex"]);
  });
});

describe("writePin and removePin", () => {
  test("create the file, update an entry in place, and delete the file once no pin is left", () => {
    const dir = join(env.home, "project");
    const file = join(dir, ".seats");
    env.write("project/keep.txt", "");

    expect(writePin(dir, "claude", "work")).toBe(file);
    expect(readFileSync(file, "utf8")).toBe('claude = "work"\n');

    env.write("project/.seats", '# team pins\nclaude = "work" # old\ncodex = "work"\nclaude = "dup"\n');
    writePin(dir, "claude", "acme");
    writePin(dir, "gemini", "personal");
    expect(readFileSync(file, "utf8")).toBe('# team pins\nclaude = "acme"\ncodex = "work"\ngemini = "personal"\n');

    expect(removePin(dir, "copilot")).toBe(false);
    expect(removePin(dir, "claude")).toBe(true);
    expect(removePin(dir, "gemini")).toBe(true);
    expect(readFileSync(file, "utf8")).toBe('# team pins\ncodex = "work"\n');
    expect(removePin(dir, "codex")).toBe(true);
    expect(existsSync(file)).toBe(false);
  });
});
