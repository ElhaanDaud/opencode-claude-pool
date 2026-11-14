import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { TestContext } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "notices-"));
process.env.HOME = root;
process.env.CLAUDE_CONFIG_DIR = path.join(root, ".claude");
process.env.CLAUDE_POOL_ACCOUNTS_DIR = path.join(root, "accounts");
process.env.CLAUDE_POOL_AUTO_ENROLL = "0";
process.env.ANTHROPIC_CLI_VERSION = "2.1.280";
const capturePath = path.join(root, "claude-system-prompt.json");
process.env.ANTHROPIC_SYSTEM_PROMPT_PATH = capturePath;
// The plugin reads Claude Code's login from the macOS Keychain with `security`; this one finds nothing.
const bin = path.join(root, "bin");
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, "security"), "#!/bin/sh\nexit 44\n", { mode: 0o755 });
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;

const { default: plugin } = await import("./index.js");
const { trustedOrigins } = await import("./request-policy.js");
const { createToaster } = await import("./pool/notify.js");

after(() => fs.rmSync(root, { recursive: true, force: true }));

type Notices = typeof import("./notices.js");
type Logged = { service: string; level: string; message: string };
type Shown = { title?: string; message: string; variant: string };

let instance = 0;
/** A notices module with its own state, as in a process that just started. */
const freshNotices = () => import(new URL(`./notices.js?fresh=${instance++}`, import.meta.url).href) as Promise<Notices>;

function opencodeClient() {
  const logged: Logged[] = [];
  const shown: Shown[] = [];
  return {
    logged,
    shown,
    client: {
      auth: { set: async () => ({}) },
      app: { log: async ({ body }: { body: Logged }) => { logged.push(body); return {}; } },
      tui: { showToast: async ({ body }: { body: Shown }) => { shown.push(body); return {}; } },
    },
  };
}

function stderrOf(t: TestContext): string[] {
  const lines: string[] = [];
  t.mock.method(console, "error", (message: unknown) => { lines.push(String(message)); });
  return lines;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("notices", () => {
  it("print to stderr until OpenCode's log is available, then go only to the log", async (t) => {
    const notices = await freshNotices();
    const stderr = stderrOf(t);
    notices.log("info", "before the plugin started");
    const { client, logged } = opencodeClient();
    notices.startNotices({ client, popup: () => {} });
    notices.log("warn", "after it started");
    await settle();
    assert.deepEqual(stderr, ["before the plugin started"]);
    assert.deepEqual(logged, [{ service: "opencode-claude-bridge", level: "warn", message: "after it started" }]);
  });

  it("fall back to stderr when OpenCode's log rejects the message", async (t) => {
    const notices = await freshNotices();
    const stderr = stderrOf(t);
    notices.startNotices({ client: { app: { log: async () => { throw new Error("server gone"); } } }, popup: () => {} });
    notices.log("error", "still somewhere");
    await settle();
    assert.deepEqual(stderr, ["still somewhere"]);
  });

  it("hold pop-ups until a session is active, and deliver ones raised before the plugin started", async (t) => {
    const notices = await freshNotices();
    const stderr = stderrOf(t);
    notices.notify("warning", "raised early", { detail: "early detail" });
    assert.deepEqual(stderr, ["early detail"]);

    const { client, logged } = opencodeClient();
    const popups: string[] = [];
    notices.startNotices({ client, popup: (variant, message) => popups.push(`${variant}: ${message}`) });
    notices.notify("error", "raised later");
    notices.notify("error", "sign-in failed", { now: true });
    await settle();
    assert.deepEqual(popups, ["error: sign-in failed"]);
    assert.deepEqual(logged.map((entry) => `${entry.level}: ${entry.message}`), ["warn: early detail", "error: raised later", "error: sign-in failed"]);

    notices.markSessionActive();
    assert.deepEqual(popups, ["error: sign-in failed", "warning: raised early", "error: raised later"]);
    notices.notify("info", "after the session started");
    assert.equal(popups.at(-1), "info: after the session started");
    assert.equal(stderr.length, 1);
  });

  it("hold the pool's toasts the same way when asked to", async () => {
    const notices = await freshNotices();
    const { client, shown } = opencodeClient();
    const toast = createToaster(client, () => 0, { whenVisible: notices.whenSessionActive });
    toast("success", "Added an account");
    await settle();
    assert.equal(shown.length, 0);
    notices.markSessionActive();
    await settle();
    assert.deepEqual(shown, [{ title: "Claude pool", message: "Added an account", variant: "success", duration: 10_000 }]);
  });

  it("keep a pop-up short, with the full text in the log", async () => {
    const notices = await freshNotices();
    const { client, logged } = opencodeClient();
    const popups: string[] = [];
    notices.startNotices({ client, popup: (_variant, message) => popups.push(message) });
    notices.markSessionActive();
    notices.notify("warning", "x".repeat(500));
    await settle();
    assert.equal(popups[0]!.length, 240);
    assert.equal(logged[0]!.message.length, 500);
  });
});

describe("the OpenCode 1 plugin's messages", () => {
  it("go to OpenCode's log and pop-ups, never over its screen", async (t) => {
    fs.writeFileSync(capturePath, JSON.stringify({
      provenance: { cliVersion: "2.1.0", capturedAt: "2026-01-01T00:00:00.000Z" },
      system: [{ type: "text", text: "# Harness\n - a captured rule" }],
    }));
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ type: "message", role: "assistant", content: [{ type: "text", text: "ok" }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
    const stderr = stderrOf(t);
    const { client, logged, shown } = opencodeClient();
    const hooks = await plugin.server({ client }) as unknown as {
      event: (input: { event: { type: string; properties: Record<string, unknown> } }) => Promise<void>;
      auth: { loader: (getAuth: () => Promise<unknown>, provider: unknown) => Promise<{ fetch: typeof fetch }> };
    };
    const loaded = await hooks.auth.loader(async () => ({ type: "oauth", access: "token", refresh: "refresh", expires: Date.now() + 3_600_000 }), { models: {} });
    // An answer without its call: repaired, and the repair is logged.
    const send = () => loaded.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "orphan", content: "x" }, { type: "text", text: "hi" }] }],
      }),
    });

    assert.equal((await send()).status, 200);
    await settle();
    assert.equal(shown.length, 0);

    await hooks.event({ event: { type: "session.created", properties: {} } });
    await settle();
    assert.equal(shown.length, 1);
    assert.equal(shown[0]!.title, "Claude bridge");
    assert.equal(shown[0]!.variant, "warning");
    assert.match(shown[0]!.message, /Claude Code 2\.1\.280 is installed, but the bridge's copy of its prompt is from 2\.1\.0\./);
    assert.match(shown[0]!.message, /--skip-opencode/);

    assert.equal((await send()).status, 200);
    process.env.ANTHROPIC_TRUSTED_ORIGINS = "not a url";
    t.after(() => { delete process.env.ANTHROPIC_TRUSTED_ORIGINS; });
    trustedOrigins();
    trustedOrigins();
    await settle();
    assert.deepEqual(shown.slice(1).map((popup) => popup.message), [`ANTHROPIC_TRUSTED_ORIGINS entry "not" isn't a URL, so it's ignored.`, `ANTHROPIC_TRUSTED_ORIGINS entry "a" isn't a URL, so it's ignored.`, `ANTHROPIC_TRUSTED_ORIGINS entry "url" isn't a URL, so it's ignored.`]);

    const messages = logged.map((entry) => entry.message);
    assert.ok(messages.some((message) => message.startsWith("[opencode-claude-bridge] build ")));
    assert.ok(messages.some((message) => message.includes("the captured Claude Code prompt at")));
    assert.ok(messages.some((message) => message.includes("repaired the conversation")));
    assert.ok(logged.every((entry) => entry.service === "opencode-claude-bridge"));
    assert.deepEqual(stderr, []);
  });
});
