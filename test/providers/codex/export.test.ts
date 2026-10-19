import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { planExport, writeExport } from "../../../src/commands/export.ts";
import { portableConfig } from "../../../src/providers/codex/export.ts";
import { secretCollector } from "../../../src/secrets.ts";
import { tempHome } from "../../helpers/temp-home.ts";

let env: ReturnType<typeof tempHome>;
afterEach(() => env?.cleanup());

const SECRET = "sk-live-abcdef123456";
const secret = () => secretCollector().ref("shared/codex/config.toml");

describe("portableConfig", () => {
  test("leaves a config without secrets or trusted projects byte for byte", () => {
    const text = '# mine\nmodel = "gpt-5"\n\n[mcp_servers.docs]\ncommand = "docs" # inline note\n';
    expect(portableConfig(text, secret())).toEqual({ text, dropped: [] });
  });

  test("rewrites a server holding a secret, taking its seats marker along", () => {
    const text = `model = "x"\n\n# added by seats\n[mcp_servers.docs]\ncommand = "docs"\nenv = { TOKEN = "${SECRET}" }\n`;
    const { text: out } = portableConfig(text, secret());
    expect(out).not.toContain("# added by seats");
    expect(out).not.toContain(SECRET);
    expect(Bun.TOML.parse(out)).toEqual({
      model: "x",
      mcp_servers: { docs: { command: "docs", env: { TOKEN: `\${TOKEN}` } } },
    });
  });

  test("refuses a server written inline under [mcp_servers], which it can't rewrite safely", () => {
    const text = `[mcp_servers]\ndocs = { command = "docs", env = { TOKEN = "${SECRET}" } }\n`;
    expect(() => portableConfig(text, secret())).toThrow(/safely/);
  });
});

test("seats export leaves out a config.toml it can't clean, and says so", () => {
  env = tempHome();
  env.write(
    ".config/seats/shared/codex/config.toml",
    `[mcp_servers]\ndocs = { command = "docs", bearer_token = "${SECRET}" }\n`,
  );
  const plan = planExport(env.home);
  expect(plan.files.has("shared/codex/config.toml")).toBe(false);
  expect(plan.skipped.some((line) => line.includes("config.toml"))).toBe(true);

  const out = join(env.home, "export");
  writeExport(env.home, out, plan);
  expect(existsSync(join(out, "shared/codex/config.toml"))).toBe(false);
});
