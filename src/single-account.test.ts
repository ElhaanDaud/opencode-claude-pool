/**
 * Drives the real V1 fetch wrapper with no pool enrolled (single-account path)
 * against a stubbed Anthropic API.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

const promptDir = fs.mkdtempSync(path.join(os.tmpdir(), "single-account-prompt-"));
process.env.ANTHROPIC_SYSTEM_PROMPT_PATH = path.join(promptDir, "claude-system-prompt.json");
fs.writeFileSync(
  process.env.ANTHROPIC_SYSTEM_PROMPT_PATH,
  JSON.stringify({ system: [{ type: "text", text: "CLAUDE CODE PROMPT" }] }),
);
process.env.CLAUDE_POOL_AUTO_ENROLL = "0";
Object.defineProperty(process, "platform", { value: "linux" });

// Local token endpoint where each refresh token works once, as in production.
// TOKEN_URL is read at import time.
const liveRefreshTokens = new Set<string>();
const refreshRequests: string[] = [];
let tokenDelayMs = 0;
const tokenServer = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", async () => {
    if (tokenDelayMs) await new Promise((resolve) => setTimeout(resolve, tokenDelayMs));
    const token = String(JSON.parse(raw).refresh_token);
    refreshRequests.push(token);
    res.setHeader("content-type", "application/json");
    if (!liveRefreshTokens.delete(token)) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "invalid_grant" }));
      return;
    }
    liveRefreshTokens.add(`${token}/next`);
    res.end(JSON.stringify({ access_token: `${token}/access`, refresh_token: `${token}/next`, expires_in: 3600 }));
  });
});
await new Promise<void>((resolve) => tokenServer.listen(0, "127.0.0.1", resolve));
process.env.ANTHROPIC_TOKEN_URL = `http://127.0.0.1:${(tokenServer.address() as AddressInfo).port}/v1/oauth/token`;
after(() => tokenServer.close());

const { default: plugin, fetchUpstream, prepareRequest } = await import("./index.js");
const { getResponseRetryDelayMs, getTokenRetryDelayMs, parseRetryAfterMs } = await import("./retry.js");

type Reply = { status: number; body?: string; headers?: Record<string, string> };

const realFetch = globalThis.fetch;
const realHome = process.env.HOME;
const realClaudeDir = process.env.CLAUDE_CONFIG_DIR;
let home = "";

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "single-account-"));
  process.env.HOME = home;
  process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
});

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env.HOME = realHome;
  if (realClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = realClaudeDir;
  fs.rmSync(home, { recursive: true, force: true });
});

const OK: Reply = { status: 200, body: "event: message_stop\ndata: {}\n\n" };

async function send(replies: Reply[], body: unknown) {
  const sent: Array<Record<string, unknown>> = [];
  const timeouts: unknown[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).includes("/v1/messages")) return new Response("{}", { status: 404 });
    sent.push(JSON.parse(String(init?.body)));
    timeouts.push(init && "timeout" in init ? init.timeout : undefined);
    const reply = replies[Math.min(sent.length - 1, replies.length - 1)]!;
    return new Response(reply.body ?? "{}", { status: reply.status, headers: reply.headers });
  }) as typeof fetch;

  const hooks = await plugin.server({ client: { auth: { set: async () => {} } } });
  const loaded = await hooks.auth.loader(
    async () => ({ type: "oauth", access: "token", refresh: "refresh", expires: Date.now() + 3_600_000 }),
    { models: {} },
  ) as { fetch: typeof fetch };
  const response = await loaded.fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, sent, timeouts, text };
}

const plain = {
  model: "claude-haiku-4-5-20251001",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
};

describe("single-account retry", () => {
  it("preserves a Request body, method, headers and abort signal", async () => {
    const controller = new AbortController();
    let sent: RequestInit | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      sent = init;
      return new Response(OK.body, { status: 200 });
    }) as typeof fetch;
    const hooks = await plugin.server({ client: { auth: { set: async () => {} } } });
    const loaded = await hooks.auth.loader(
      async () => ({ type: "oauth", access: "token", refresh: "refresh", expires: Date.now() + 3_600_000 }),
      { models: {} },
    ) as { fetch: typeof fetch };
    const request = new Request("https://api.anthropic.com/v1/messages", {
      method: "POST", body: JSON.stringify(plain), headers: { "x-test": "request" }, signal: controller.signal,
    });
    await loaded.fetch(request);
    assert.equal(sent?.method, "POST");
    assert.equal(JSON.parse(String(sent?.body)).model, plain.model);
    assert.equal(new Headers(sent?.headers).get("x-test"), "request");
    controller.abort();
    assert.equal(sent?.signal?.aborted, true);
  });

  it("honors init overrides for a Request", async () => {
    const controller = new AbortController();
    let sent: RequestInit | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      sent = init;
      return new Response(OK.body, { status: 200 });
    }) as typeof fetch;
    const hooks = await plugin.server({ client: { auth: { set: async () => {} } } });
    const loaded = await hooks.auth.loader(
      async () => ({ type: "oauth", access: "token", refresh: "refresh", expires: Date.now() + 3_600_000 }),
      { models: {} },
    ) as { fetch: typeof fetch };
    const request = new Request("https://api.anthropic.com/v1/messages", {
      method: "POST", body: JSON.stringify(plain), headers: { "x-original": "old" },
    });
    await loaded.fetch(request, { method: "PUT", body: JSON.stringify({ ...plain, model: "override" }), headers: { "x-new": "yes" }, signal: controller.signal });
    assert.equal(sent?.method, "PUT");
    assert.equal(JSON.parse(String(sent?.body)).model, "override");
    assert.equal(new Headers(sent?.headers).get("x-original"), null);
    assert.equal(new Headers(sent?.headers).get("x-new"), "yes");
    assert.equal(sent?.signal, controller.signal);
  });

  it("keeps a Request's body when init.body is null, as new Request(request, init) does", async () => {
    let sent: RequestInit | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      sent = init;
      return new Response(OK.body, { status: 200 });
    }) as typeof fetch;
    const hooks = await plugin.server({ client: { auth: { set: async () => {} } } });
    const loaded = await hooks.auth.loader(
      async () => ({ type: "oauth", access: "token", refresh: "refresh", expires: Date.now() + 3_600_000 }),
      { models: {} },
    ) as { fetch: typeof fetch };
    const request = new Request("https://api.anthropic.com/v1/messages", { method: "POST", body: JSON.stringify(plain) });
    assert.equal(await new Request(request.clone(), { body: null }).text(), JSON.stringify(plain));
    await loaded.fetch(request, { body: null });
    assert.equal(JSON.parse(String(sent?.body)).model, plain.model);
  });

  it("retries a 529 and returns the recovered response", async () => {
    const { status, sent } = await send(
      [{ status: 529, headers: { "retry-after": "0" } }, OK],
      plain,
    );
    assert.equal(status, 200);
    assert.equal(sent.length, 2);
  });

  it("hands a long Retry-After straight back without retrying", async () => {
    const { status, sent } = await send([{ status: 429, headers: { "retry-after": "3600" } }], plain);
    assert.equal(status, 429);
    assert.equal(sent.length, 1);
  });

  it("stops after the retry budget", async () => {
    const { status, sent } = await send([{ status: 529, headers: { "retry-after": "0" } }], plain);
    assert.equal(status, 529);
    assert.equal(sent.length, 3);
  });

  it("turns Bun's own fetch timeout off for every send, retries included", async () => {
    const { status, timeouts } = await send([{ status: 529, headers: { "retry-after": "0" } }, OK], plain);
    assert.equal(status, 200);
    assert.deepEqual(timeouts, [false, false]);
  });

  it("retries a 429 without spending the refresh token of a valid access token", async () => {
    const before = refreshRequests.length;
    const { status, sent } = await send([{ status: 429, headers: { "retry-after": "0" } }, OK], plain);
    assert.equal(status, 200);
    assert.equal(sent.length, 2);
    assert.deepEqual(refreshRequests.slice(before), []);
  });
});

type StoredAuth = { type: string; access: string; refresh: string; expires: number };

/** A loaded fetch whose getAuth() re-reads `store`, as OpenCode's does; `status` answers each bearer. */
async function connect(
  store: { auth: StoredAuth },
  save: (body: StoredAuth) => Promise<unknown>,
  status: (bearer: string) => number = () => 200,
) {
  const bearers: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).includes("/v1/messages")) return new Response("{}", { status: 404 });
    const bearer = (init?.headers as Record<string, string>).authorization!;
    bearers.push(bearer);
    return new Response(OK.body, { status: status(bearer) });
  }) as typeof fetch;

  const hooks = await plugin.server({
    client: { auth: { set: async ({ body }: { body: Record<string, unknown> }) => save(body as StoredAuth) } },
  });
  const loaded = await hooks.auth.loader(async () => ({ ...store.auth }), { models: {} }) as { fetch: typeof fetch };
  const call = async () => {
    const response = await loaded.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify(plain),
    });
    await response.text();
    return response.status;
  };
  return { call, bearers, loaded };
}

/** Records `refresh` as a login OpenCode made itself, which only the bridge refreshes. */
function ownedByBridge(refresh: string) {
  const dir = path.join(home, ".local", "share", "opencode-claude-bridge");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "single-account-owner.json"),
    JSON.stringify({ bridge: [createHash("sha256").update(refresh).digest("hex")] }),
  );
}

const journalPath = () => path.join(home, ".local", "share", "opencode-claude-bridge", "single-account-journal.json");

/** Logs the Claude CLI in with tokens valid for an hour. */
function cliLogin(access: string, refresh: string) {
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR!, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.CLAUDE_CONFIG_DIR!, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: access, refreshToken: refresh, expiresAt: Date.now() + 3_600_000 } }),
  );
}

/** Anthropic accepting only access tokens the token endpoint just issued. */
const refreshedOnly = (bearer: string) => (bearer.endsWith("/access") ? 200 : 401);

describe("single-account refresh", () => {
  it("rebinds generated metadata when retrying with a different CLI account", async () => {
    const sent: Array<{ bearer: string; uuid: string }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const bearer = new Headers(init?.headers).get("authorization") ?? "";
      if (String(url).includes("/oauth/profile")) return Response.json({ account: { uuid: bearer.endsWith("identity-a") ? "uuid-a" : "uuid-b" } });
      const body = JSON.parse(String(init?.body));
      sent.push({ bearer, uuid: JSON.parse(body.metadata.user_id).account_uuid });
      return new Response(OK.body, { status: bearer.endsWith("identity-a") ? 401 : 200 });
    }) as typeof fetch;
    const store = { auth: { type: "oauth", access: "identity-a", refresh: "identity-a-refresh", expires: Date.now() + 3_600_000 } };
    const hooks = await plugin.server({ client: { auth: { set: async () => {} } } });
    const loaded = await hooks.auth.loader(async () => ({ ...store.auth }), { models: {} }) as { fetch: typeof fetch };
    cliLogin("identity-b", "identity-b-refresh");
    const response = await loaded.fetch("https://api.anthropic.com/v1/messages", { method: "POST", body: JSON.stringify(plain) });
    assert.equal(response.status, 200);
    assert.deepEqual(sent, [{ bearer: "Bearer identity-a", uuid: "uuid-a" }, { bearer: "Bearer identity-b", uuid: "uuid-b" }]);
  });
  it("shares one refresh of a login OpenCode owns between concurrent requests", async () => {
    liveRefreshTokens.add("shared");
    ownedByBridge("shared");
    const store = { auth: { type: "oauth", access: "old", refresh: "shared", expires: Date.now() - 1000 } };
    const { call, bearers } = await connect(store, async (body) => { store.auth = body; });
    const before = refreshRequests.length;

    assert.deepEqual(await Promise.all([call(), call()]), [200, 200]);
    assert.deepEqual(refreshRequests.slice(before), ["shared"]);
    assert.deepEqual(bearers, ["Bearer shared/access", "Bearer shared/access"]);
  });

  it("journals tokens whose save failed, and saves them on the next request", async () => {
    liveRefreshTokens.add("unsaved");
    ownedByBridge("unsaved");
    const store = { auth: { type: "oauth", access: "old", refresh: "unsaved", expires: Date.now() - 1000 } };
    let failures = 1;
    const { call, bearers } = await connect(store, async (body) => {
      if (failures-- > 0) throw new Error("auth store unavailable");
      store.auth = body;
    });
    const before = refreshRequests.length;

    assert.equal(await call(), 200);
    assert.equal(store.auth.refresh, "unsaved");
    assert.equal(JSON.parse(fs.readFileSync(journalPath(), "utf8")).tokens.refresh, "unsaved/next");
    assert.equal(await call(), 200);
    assert.deepEqual(refreshRequests.slice(before), ["unsaved"]);
    assert.deepEqual(bearers, ["Bearer unsaved/access", "Bearer unsaved/access"]);
    assert.equal(store.auth.refresh, "unsaved/next");
    assert.equal(fs.existsSync(journalPath()), false);
  });

  it("keeps the journal when OpenCode refuses the save, which its SDK reports without throwing", async (t) => {
    liveRefreshTokens.add("refused");
    ownedByBridge("refused");
    const store = { auth: { type: "oauth", access: "old", refresh: "refused", expires: Date.now() - 1000 } };
    const logged: string[] = [];
    t.mock.method(console, "error", (message: unknown) => { logged.push(String(message)); });
    let refusals = 1;
    const { call, bearers } = await connect(store, async (body) => {
      // What OpenCode's SDK resolves for a rejected write; its message echoes the payload.
      if (refusals-- > 0) return { error: { name: "BadRequest", data: { message: `Expected Auth, got ${JSON.stringify(body)}` } } };
      store.auth = body;
      return undefined;
    });
    const before = refreshRequests.length;

    assert.equal(await call(), 200);
    assert.equal(store.auth.refresh, "refused");
    assert.equal(JSON.parse(fs.readFileSync(journalPath(), "utf8")).tokens.refresh, "refused/next");
    assert.equal(await call(), 200);
    assert.equal(store.auth.refresh, "refused/next");
    assert.equal(fs.existsSync(journalPath()), false);
    assert.deepEqual(refreshRequests.slice(before), ["refused"]);
    assert.deepEqual(bearers, ["Bearer refused/access", "Bearer refused/access"]);
    assert.ok(logged.some((line) => line.includes("[redacted]")));
    assert.ok(!logged.some((line) => line.includes("refused/next") || line.includes("refused/access")));
  });

  it("never refreshes Claude Code's login, even after a 401, and says how to get a fresh one", async () => {
    liveRefreshTokens.add("copied-refresh");
    cliLogin("copied", "copied-refresh");
    const store = { auth: { type: "oauth", access: "copied", refresh: "copied-refresh", expires: Date.now() + 3_600_000 } };
    const { call, bearers } = await connect(store, async (body) => { store.auth = body; }, refreshedOnly);
    const before = refreshRequests.length;

    assert.equal(await call(), 401);
    assert.deepEqual(refreshRequests.slice(before), []);
    assert.deepEqual(bearers, ["Bearer copied"]);
    assert.equal(liveRefreshTokens.has("copied-refresh"), true);
  });

  it("does not refresh a login whose owner was never recorded", async () => {
    liveRefreshTokens.add("unknown-refresh");
    const store = { auth: { type: "oauth", access: "old", refresh: "unknown-refresh", expires: Date.now() - 1000 } };
    const { call } = await connect(store, async (body) => { store.auth = body; });
    const before = refreshRequests.length;

    assert.equal(await call(), 401);
    assert.deepEqual(refreshRequests.slice(before), []);
  });

  it("shares one refresh between concurrent requests whose token was rejected", async () => {
    liveRefreshTokens.add("twice-refresh");
    ownedByBridge("twice-refresh");
    const store = { auth: { type: "oauth", access: "twice", refresh: "twice-refresh", expires: Date.now() + 3_600_000 } };
    const { call, bearers } = await connect(store, async (body) => { store.auth = body; }, refreshedOnly);
    const before = refreshRequests.length;

    assert.deepEqual(await Promise.all([call(), call()]), [200, 200]);
    assert.deepEqual(refreshRequests.slice(before), ["twice-refresh"]);
    assert.deepEqual([...bearers].sort(), ["Bearer twice", "Bearer twice", "Bearer twice-refresh/access", "Bearer twice-refresh/access"]);
  });

  it("keeps a login OpenCode owns on its own account instead of borrowing the CLI's", async () => {
    liveRefreshTokens.add("own-refresh");
    ownedByBridge("own-refresh");
    const store = { auth: { type: "oauth", access: "own", refresh: "own-refresh", expires: Date.now() + 3_600_000 } };
    const { call, bearers } = await connect(store, async (body) => { store.auth = body; }, refreshedOnly);
    cliLogin("cli-other", "cli-other-refresh");

    assert.equal(await call(), 200);
    assert.deepEqual(bearers, ["Bearer own", "Bearer own-refresh/access"]);
  });

  it("lets a cancelled request go without losing the refresh it started", async () => {
    liveRefreshTokens.add("slow-refresh");
    ownedByBridge("slow-refresh");
    const store = { auth: { type: "oauth", access: "old", refresh: "slow-refresh", expires: Date.now() - 1000 } };
    let saved!: () => void;
    const saving = new Promise<void>((resolve) => { saved = resolve; });
    const { loaded } = await connect(store, async (body) => { store.auth = body; saved(); });
    tokenDelayMs = 200;
    try {
      const controller = new AbortController();
      const request = loaded.fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", body: JSON.stringify(plain), signal: controller.signal,
      });
      setTimeout(() => controller.abort(new Error("cancelled")), 20);
      const started = Date.now();
      await assert.rejects(request, /cancelled/);
      assert.ok(Date.now() - started < 150, "the caller stops waiting at once");
      await saving;
      assert.equal(store.auth.refresh, "slow-refresh/next");
    } finally {
      tokenDelayMs = 0;
    }
  });

  it("resends on the Claude CLI's other valid token without spending a refresh token", async () => {
    const store = { auth: { type: "oauth", access: "stale", refresh: "kept", expires: Date.now() + 3_600_000 } };
    const { call, bearers } = await connect(store, async (body) => { store.auth = body; }, (bearer) => (bearer === "Bearer stale" ? 401 : 200));
    // After plugin init, so the store keeps its own token.
    cliLogin("relogged", "relogged-refresh");
    const before = refreshRequests.length;

    assert.equal(await call(), 200);
    assert.deepEqual(refreshRequests.slice(before), []);
    assert.deepEqual(bearers, ["Bearer stale", "Bearer relogged"]);
    assert.equal(store.auth.access, "relogged");
  });
});

describe("startup seeding", () => {
  function storedLogin(auth: StoredAuth) {
    const dir = path.join(home, ".local", "share", "opencode");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ anthropic: auth }));
  }

  it("copies Claude Code's login over a login nobody owns", async () => {
    storedLogin({ type: "oauth", access: "a", refresh: "a-refresh", expires: Date.now() + 3_600_000 });
    cliLogin("cli", "cli-refresh");
    const saves: StoredAuth[] = [];
    await plugin.server({ client: { auth: { set: async ({ body }: { body: Record<string, unknown> }) => { saves.push(body as StoredAuth); } } } });
    assert.deepEqual(saves.map((auth) => auth.refresh), ["cli-refresh"]);
  });

  it("never overwrites a login OpenCode owns", async () => {
    storedLogin({ type: "oauth", access: "own", refresh: "own-refresh", expires: Date.now() + 3_600_000 });
    ownedByBridge("own-refresh");
    cliLogin("cli", "cli-refresh");
    const saves: StoredAuth[] = [];
    await plugin.server({ client: { auth: { set: async ({ body }: { body: Record<string, unknown> }) => { saves.push(body as StoredAuth); } } } });
    assert.deepEqual(saves, []);
  });
});

describe("request body rewrite", () => {
  it("routes colliding tool histories and choices using their own schemas in either order", async () => {
    const builtin = { name: "read", description: "builtin", input_schema: { type: "object" } };
    const custom = { name: "Read", description: "custom", input_schema: { type: "object" } };
    for (const tools of [[builtin, custom], [custom, builtin]]) {
      const { sent } = await send([OK], {
        ...plain, tools, tool_choice: { type: "tool", name: "read" },
        messages: [{ role: "assistant", content: [
          { type: "tool_use", id: "a", name: "read", input: { filePath: "/a" } },
          { type: "tool_use", id: "b", name: "Read", input: { file_path: "/b", pages: "1" } },
        ] }],
      });
      assert.deepEqual(sent[0]!.tool_choice, { type: "tool", name: "read" });
      const messages = sent[0]!.messages as Array<{ content: Array<{ name: string; input: unknown }> }>;
      assert.deepEqual(messages[0]!.content.map(({ name, input }) => ({ name, input })), [
        { name: "read", input: { filePath: "/a" } }, { name: "Read", input: { file_path: "/b", pages: "1" } },
      ]);
    }
  });
  it("preserves custom Claude-named tool arguments in history and responses", async () => {
    const args = { file_path: "/a", pages: "1-2" };
    const events = [
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t", name: "Read", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(args) } },
      { type: "content_block_stop", index: 0 },
    ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
    const { sent, text } = await send([{ status: 200, body: events, headers: { "content-type": "text/event-stream" } }], {
      ...plain, tools: [{ name: "Read", input_schema: { type: "object" } }],
      messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t", name: "Read", input: args }] }],
    });
    const messages = sent[0]!.messages as Array<{ content: Array<{ input: unknown }> }>;
    assert.deepEqual(messages[0]!.content[0]!.input, args);
    const delta = text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6))).find((event) => event.type === "content_block_delta");
    assert.deepEqual(JSON.parse(delta.delta.partial_json), args);
  });
  it("sends the host's own task, skill and grep capabilities and routes them unchanged", async () => {
    const task = {
      name: "task",
      description: "Spawn agent task with category-based or direct agent selection.\n  Available categories:\n  - quick: Trivial tasks\n  - subagent_type: Use specific agent directly (explore, librarian, oracle, metis, momus)\n  task(category=\"quick\", prompt=\"...\")",
      input_schema: {
        type: "object",
        properties: {
          load_skills: { type: "array", items: { type: "string" } },
          description: { type: "string" },
          prompt: { type: "string" },
          run_in_background: { type: "boolean" },
          category: { type: "string" },
          subagent_type: { type: "string" },
          task_id: { type: "string" },
          command: { type: "string" },
        },
        required: ["prompt"],
      },
    };
    const skill = {
      name: "skill",
      description: "Load a skill or execute a slash command.\n<available_items>\n- git-master: commits and history\n- /publish: release\n</available_items>",
      input_schema: {
        type: "object",
        properties: { name: { type: "string" }, user_message: { type: "string" } },
        required: ["name"],
      },
    };
    const grep = {
      name: "grep",
      description: "Fast content search tool with safety limits",
      input_schema: {
        type: "object",
        properties: {
          pattern: { type: "string" }, include: { type: "string" }, path: { type: "string" },
          output_mode: { type: "string" }, head_limit: { type: "number" },
        },
        required: ["pattern"],
      },
    };
    const calls = [
      { name: "Agent", input: { category: "quick", load_skills: ["git-master"], prompt: "p", run_in_background: true } },
      { name: "Skill", input: { name: "publish", user_message: "patch" } },
      { name: "Grep", input: { pattern: "x", glob: "*.ts", output_mode: "content", head_limit: 5, "-i": true } },
    ];
    const events = calls.flatMap((call, index) => [
      { type: "content_block_start", index, content_block: { type: "tool_use", id: `t${index}`, name: call.name, input: {} } },
      { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) } },
      { type: "content_block_stop", index },
    ]).map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
    const history = [
      { type: "tool_use", id: "a", name: "task", input: { subagent_type: "explore", load_skills: [], prompt: "find", task_id: "ses_1" } },
      { type: "tool_use", id: "b", name: "skill", input: { name: "git-master", user_message: "amend" } },
    ];

    const { sent, text } = await send([{ status: 200, body: events, headers: { "content-type": "text/event-stream" } }], {
      ...plain, tools: [task, skill, grep],
      messages: [{ role: "assistant", content: history }],
    });

    const tools = sent[0]!.tools as Array<{ name: string; description: string; input_schema: { properties: Record<string, unknown> } }>;
    const agent = tools.find((tool) => tool.name === "Agent")!;
    assert.ok(agent.description.endsWith(task.description), "the host's delegation guidance is sent");
    assert.match(agent.description, /`task`/, "says which name the instructions use for it");
    assert.doesNotMatch(agent.description, /general-purpose|statusline-setup/);
    assert.deepEqual(agent.input_schema, task.input_schema);
    const skillTool = tools.find((tool) => tool.name === "Skill")!;
    assert.equal(skillTool.description, skill.description);
    assert.deepEqual(skillTool.input_schema, skill.input_schema);

    const messages = sent[0]!.messages as Array<{ content: Array<{ name: string; input: unknown }> }>;
    assert.deepEqual(messages[0]!.content.map(({ name, input }) => ({ name, input })), [
      { name: "Agent", input: history[0]!.input },
      { name: "Skill", input: history[1]!.input },
    ]);

    const data = text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
    const received = data.filter((event) => event.type === "content_block_start").map((event) => ({
      name: event.content_block.name,
      input: JSON.parse(data.find((delta) => delta.type === "content_block_delta" && delta.index === event.index).delta.partial_json),
    }));
    assert.deepEqual(received, [
      { name: "task", input: calls[0]!.input },
      { name: "skill", input: calls[1]!.input },
      { name: "grep", input: { pattern: "x", include: "*.ts", output_mode: "content", head_limit: 5 } },
    ]);
  });
  it("keeps OpenCode's system blocks after Claude Code's prompt", async () => {
    const { sent } = await send([OK], {
      ...plain,
      system: [{ type: "text", text: "OPENCODE AGENT PROMPT" }],
    });
    const texts = (sent[0]!.system as Array<{ text: string }>).map((block) => block.text);
    assert.match(texts[0]!, /^x-anthropic-billing-header:/);
    assert.equal(texts[1], "CLAUDE CODE PROMPT");
    assert.ok(texts.slice(2).some((text) => text.includes("OPENCODE AGENT PROMPT")));
    assert.equal(texts.filter((text) => text.startsWith("x-anthropic-billing-header:")).length, 1);
  });

  describe("tool_choice", () => {
    const schema = { type: "object", properties: {} };
    const withTools = {
      model: "claude-opus-5-5",
      messages: plain.messages,
      tools: [
        { name: "bash", description: "run", input_schema: schema },
        { name: "StructuredOutput", description: "answer", input_schema: schema },
      ],
    };

    it("keeps a forced tool, maps its name, and injects no thinking", async () => {
      for (const [name, wire] of [["StructuredOutput", "StructuredOutput"], ["bash", "Bash"]]) {
        const { sent } = await send([OK], { ...withTools, tool_choice: { type: "tool", name } });
        assert.deepEqual(sent[0]!.tool_choice, { type: "tool", name: wire });
        assert.ok((sent[0]!.tools as Array<{ name: string }>).some((tool) => tool.name === wire));
        assert.equal(sent[0]!.thinking, undefined);
      }
    });

    it("turns the caller's thinking off when it forces a tool", async () => {
      const { sent } = await send([OK], {
        ...withTools,
        tool_choice: { type: "any" },
        thinking: { type: "enabled", budget_tokens: 2048 },
        temperature: 0,
      });
      assert.deepEqual(sent[0]!.tool_choice, { type: "any" });
      assert.deepEqual(sent[0]!.thinking, { type: "disabled" });
      assert.equal(sent[0]!.temperature, 0);
    });

    it("drops a forced tool for Sonnet 5.5, which can't turn thinking off", async () => {
      const sonnet = { ...withTools, model: "claude-sonnet-5-5" };
      for (const extra of [
        { tool_choice: { type: "tool", name: "bash" } },
        { tool_choice: { type: "any" }, thinking: { type: "enabled", budget_tokens: 2048 } },
      ]) {
        const { sent } = await send([OK], { ...sonnet, ...extra });
        assert.equal(sent[0]!.tool_choice, undefined);
        assert.deepEqual(sent[0]!.thinking, { type: "adaptive" });
      }
      for (const choice of [{ type: "auto" }, { type: "none" }]) {
        const { sent } = await send([OK], { ...sonnet, tool_choice: choice });
        assert.deepEqual(sent[0]!.tool_choice, choice);
      }
    });

    it("keeps auto and none alongside adaptive thinking", async () => {
      for (const choice of [{ type: "auto", disable_parallel_tool_use: true }, { type: "none" }]) {
        const { sent } = await send([OK], { ...withTools, tool_choice: choice });
        assert.deepEqual(sent[0]!.tool_choice, choice);
        assert.deepEqual(sent[0]!.thinking, { type: "adaptive" });
      }
    });
  });

  it("ends an assistant-tailed request on a user turn and keeps the host's cache markers", async () => {
    const marker = { type: "ephemeral" };
    const { sent } = await send([OK], {
      ...plain,
      messages: [
        { role: "user", content: [{ type: "text", text: "q", cache_control: marker }] },
        { role: "assistant", content: [{ type: "text", text: "a", cache_control: marker }] },
      ],
    });
    const messages = sent[0]!.messages as Array<{ role: string; content: Array<{ cache_control?: unknown }> | string }>;
    assert.equal(messages.at(-1)!.role, "user");
    assert.deepEqual((messages[0]!.content as Array<{ cache_control?: unknown }>)[0]!.cache_control, marker);
    assert.deepEqual((messages[1]!.content as Array<{ cache_control?: unknown }>)[0]!.cache_control, marker);
  });

  it("sends text that is a quoted string verbatim instead of JSON-decoding it", async () => {
    const texts = ['"hello"', '"a\\nb"', ' "padded" '];
    const { sent } = await send([OK], {
      ...plain,
      messages: [
        { role: "user", content: [{ type: "text", text: texts[0] }] },
        { role: "assistant", content: [{ type: "text", text: texts[1] }] },
        { role: "user", content: [{ type: "text", text: texts[2] }] },
      ],
    });
    const messages = sent[0]!.messages as Array<{ content: Array<{ text: string }> }>;
    assert.deepEqual(messages.map((message) => message.content[0]!.text), texts);
  });
});

describe("request policy", () => {
  async function loadPlugin() {
    const hooks = await plugin.server({ client: { auth: { set: async () => {} } } });
    return await hooks.auth.loader(
      async () => ({ type: "oauth", access: "token", refresh: "refresh", expires: Date.now() + 3_600_000 }),
      { models: {} },
    ) as { fetch: typeof fetch };
  }

  it("sends the login to no origin but Anthropic's unless it is trusted", async () => {
    const targets: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      targets.push(String(url));
      return new Response(OK.body, { status: 200 });
    }) as typeof fetch;
    const loaded = await loadPlugin();
    const refused = await loaded.fetch("https://proxy.example/v1/messages", { method: "POST", body: JSON.stringify(plain) });
    assert.equal(refused.status, 400);
    assert.match(await refused.text(), /ANTHROPIC_TRUSTED_ORIGINS=https:\/\/proxy\.example/);
    assert.deepEqual(targets, []);

    process.env.ANTHROPIC_TRUSTED_ORIGINS = "https://proxy.example";
    try {
      assert.equal((await loaded.fetch("https://proxy.example/v1/messages", { method: "POST", body: JSON.stringify(plain) })).status, 200);
    } finally {
      delete process.env.ANTHROPIC_TRUSTED_ORIGINS;
    }
    assert.equal(new URL(targets[0]!).origin, "https://proxy.example");
  });

  it("sends at most the API's 4 cache markers, even when the tools carry them", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
    const marker = { type: "ephemeral" };
    const tools = ["one", "two", "three", "four", "five"].map((name) => ({
      name, description: "", input_schema: { type: "object", properties: {} }, cache_control: marker,
    }));
    const prepared = await prepareRequest("https://api.anthropic.com/v1/messages", {
      method: "POST", body: JSON.stringify({ ...plain, tools }),
    }, "token", { sessionId: "s", deviceId: "d", claudeTools: true, ensureClaudePrefix: false });
    const sent = JSON.parse(String(prepared.body)) as { tools: object[]; system: object[]; messages: Array<{ content: unknown }> };
    const blocks = [...sent.tools, ...sent.system, ...sent.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []))];
    assert.equal(blocks.filter((block) => "cache_control" in block).length, 4);
    const change = prepared.settingChanges.find((c) => c.setting === "cache_control");
    assert.deepEqual([change?.from, change?.to], ["5 markers", "4 markers"]);
  });

  it("hands a redirect back instead of following it with the login", async () => {
    globalThis.fetch = realFetch;
    const seen: Array<string | undefined> = [];
    const other = http.createServer((req, res) => { seen.push(req.headers.authorization); res.end("{}"); });
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
    const first = http.createServer((_req, res) => {
      res.writeHead(307, { location: `http://127.0.0.1:${(other.address() as AddressInfo).port}/steal` });
      res.end();
    });
    await new Promise<void>((resolve) => first.listen(0, "127.0.0.1", resolve));
    try {
      const response = await fetchUpstream(`http://127.0.0.1:${(first.address() as AddressInfo).port}/v1/messages`, {
        method: "POST", headers: { authorization: "Bearer secret" }, body: "{}",
      });
      assert.equal(response.status, 307);
      assert.deepEqual(seen, []);
    } finally {
      first.close();
      other.close();
    }
  });

  it("keeps the caller's temperature instead of the bridge's default thinking, and records what it set", async () => {
    const trace = path.join(home, "trace.jsonl");
    process.env.ANTHROPIC_TRACE_PATH = trace;
    try {
      const { sent } = await send([OK], { ...plain, model: "claude-opus-4-6", temperature: 0.2 });
      assert.equal(sent[0]!.temperature, 0.2);
      assert.equal(sent[0]!.thinking, undefined);

      await send([OK], { ...plain, model: "claude-opus-4-6" });
      const lines = fs.readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(lines.length, 2);
      assert.deepEqual(lines[1].changes.map((c: { setting: string; reason: string }) => `${c.setting}:${c.reason}`).sort(), [
        "context_management:default", "output_config.effort:default", "thinking:default",
      ]);
      assert.equal(lines[1].route, "https://api.anthropic.com/v1/messages");
      assert.equal(lines[1].status, 200);
      // No credential and no prompt text.
      assert.doesNotMatch(fs.readFileSync(trace, "utf8"), /Bearer|"token"|"hi"/);
    } finally {
      delete process.env.ANTHROPIC_TRACE_PATH;
    }
  });
});

describe("retry and deadline accounting", () => {
  /** Run backoff sleeps at once, recording what each one asked for. */
  async function recordingWaits<T>(run: () => Promise<T>): Promise<{ result: T; waits: number[] }> {
    const realSetTimeout = globalThis.setTimeout;
    const waits: number[] = [];
    globalThis.setTimeout = ((fn: () => void, ms = 0) => {
      if (ms < 1000) return realSetTimeout(fn, ms);
      waits.push(ms);
      return realSetTimeout(fn, 0);
    }) as typeof setTimeout;
    try {
      return { result: await run(), waits };
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  }

  /** A fetch answering `status` forever, recording sends and which bodies were disposed. */
  function failingUpstream(status: number, headers: Record<string, string> = {}) {
    const sent: number[] = [];
    const disposed: number[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (!String(url).includes("/v1/messages")) return new Response("{}", { status: 404 });
      const n = sent.push(sent.length);
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{\"type\":\"error\"}"));
          controller.close();
        },
        cancel() { disposed.push(n); },
      });
      return new Response(body, { status, headers });
    }) as typeof fetch;
    return { sent, disposed };
  }

  async function loaded() {
    const hooks = await plugin.server({ client: { auth: { set: async () => {} } } });
    return await hooks.auth.loader(
      async () => ({ type: "oauth", access: "token", refresh: "refresh", expires: Date.now() + 3_600_000 }),
      { models: {} },
    ) as { fetch: typeof fetch };
  }
  const call = (fetcher: { fetch: typeof fetch }, signal?: AbortSignal) =>
    fetcher.fetch("https://api.anthropic.com/v1/messages", { method: "POST", body: JSON.stringify(plain), signal });

  it("spends one 10 s wait budget across every in-place retry", async () => {
    const upstream = failingUpstream(429, { "retry-after": "6" });
    const fetcher = await loaded();
    const { result, waits } = await recordingWaits(() => call(fetcher));
    assert.equal(result.status, 429);
    // A second 6 s wait would overrun the budget, so the 429 goes back to OpenCode instead.
    assert.deepEqual(waits, [6000]);
    assert.equal(upstream.sent.length, 2);
  });

  it("disposes of every response it doesn't return", async () => {
    const upstream = failingUpstream(529);
    const fetcher = await loaded();
    const { result } = await recordingWaits(() => call(fetcher));
    assert.equal(result.status, 529);
    assert.equal(upstream.sent.length, 1 + 2);
    // Every response but the returned one was cancelled, so no connection is left open.
    assert.deepEqual(upstream.disposed, [1, 2]);
  });

  it("bounds what the host's own retries multiply: each call sends at most 1 + 1 + 2", async () => {
    const upstream = failingUpstream(529);
    const fetcher = await loaded();
    // OpenCode retries a 529 itself; three of its attempts reach the plugin.
    await recordingWaits(async () => {
      for (let attempt = 0; attempt < 3; attempt++) await (await call(fetcher)).text();
    });
    assert.equal(upstream.sent.length, 3 * 3);
  });

  it("stops retrying the moment the request is cancelled", async () => {
    const upstream = failingUpstream(529);
    const fetcher = await loaded();
    const controller = new AbortController();
    const request = call(fetcher, controller.signal);
    setTimeout(() => controller.abort(new Error("cancelled")), 50);
    await assert.rejects(request, /cancelled/);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.equal(upstream.sent.length, 1);
  });

  it("traces each retry and the sends it took, with no credential or prompt text", async () => {
    failingUpstream(529);
    const trace = path.join(home, "trace.jsonl");
    process.env.ANTHROPIC_TRACE_PATH = trace;
    try {
      const fetcher = await loaded();
      await recordingWaits(() => call(fetcher));
      const [line] = fs.readFileSync(trace, "utf8").trim().split("\n").map((text) => JSON.parse(text));
      assert.deepEqual(line.events.map((e: { kind: string; layer: string; status: number }) => `${e.kind}:${e.layer}:${e.status}`), ["retry:single:529", "retry:single:529"]);
      assert.equal(line.sends, 3);
      assert.equal(line.status, 529);
      assert.doesNotMatch(fs.readFileSync(trace, "utf8"), /Bearer|"token"|"refresh"|"hi"/);
    } finally {
      delete process.env.ANTHROPIC_TRACE_PATH;
    }
  });

  it("keeps serving when the trace can't be written, and says so once", async (t) => {
    globalThis.fetch = (async () => new Response(OK.body, { status: 200 })) as typeof fetch;
    const warnings: string[] = [];
    t.mock.method(console, "error", (message: string) => { warnings.push(String(message)); });
    process.env.ANTHROPIC_TRACE_PATH = path.join(home, "missing-dir", "trace.jsonl");
    try {
      const fetcher = await loaded();
      assert.equal((await call(fetcher)).status, 200);
      assert.equal((await call(fetcher)).status, 200);
      assert.equal(warnings.filter((w) => w.includes("could not write the request trace")).length, 1);
    } finally {
      delete process.env.ANTHROPIC_TRACE_PATH;
    }
  });
});

describe("review findings 27-45", () => {
  async function loadedFor(store: { auth: StoredAuth }) {
    const hooks = await plugin.server({ client: { auth: { set: async ({ body }: { body: Record<string, unknown> }) => { store.auth = body as StoredAuth; } } } });
    return await hooks.auth.loader(async () => ({ ...store.auth }), { models: {} }) as { fetch: typeof fetch };
  }

  it("rejects when cancelled while a 429 waits for a fresh token, and still saves that refresh", async () => {
    liveRefreshTokens.add("rl-refresh");
    ownedByBridge("rl-refresh");
    // Usable when the request starts, within a minute of expiry once the 429 arrives.
    const store = { auth: { type: "oauth", access: "rl", refresh: "rl-refresh", expires: Date.now() + 61_000 } };
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (!String(url).includes("/v1/messages")) return new Response("{}", { status: 404 });
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      return new Response('{"type":"error"}', { status: 429, headers: { "retry-after": "0" } });
    }) as typeof fetch;
    const loaded = await loadedFor(store);
    tokenDelayMs = 400;
    try {
      const controller = new AbortController();
      const request = loaded.fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", body: JSON.stringify(plain), signal: controller.signal,
      });
      setTimeout(() => controller.abort(new Error("cancelled")), 1_400);
      await assert.rejects(request, /cancelled/);
      for (let i = 0; i < 40 && store.auth.refresh !== "rl-refresh/next"; i++) await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(store.auth.refresh, "rl-refresh/next");
    } finally {
      tokenDelayMs = 0;
    }
  });

  it("returns a success that is neither an event stream nor JSON byte for byte", async () => {
    const bytes = [97, 13, 10, 255];
    globalThis.fetch = (async (url: string | URL | Request) => String(url).includes("/v1/messages")
      ? new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": "text/plain" } })
      : new Response("{}", { status: 404 })) as typeof fetch;
    const loaded = await loadedFor({ auth: { type: "oauth", access: "token", refresh: "refresh", expires: Date.now() + 3_600_000 } });
    const response = await loaded.fetch("https://api.anthropic.com/v1/messages", { method: "POST", body: JSON.stringify(plain) });
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], bytes);
  });

  it("traces only the kind of each setting, never schemas or other content of the request", async () => {
    const trace = path.join(home, "trace.jsonl");
    process.env.ANTHROPIC_TRACE_PATH = trace;
    try {
      const secret = "PRIVATE-SCHEMA-4817";
      await send([OK], {
        ...plain,
        model: "claude-sonnet-5-5",
        thinking: { type: "disabled" },
        output_config: { effort: "high", format: { type: "json_schema", schema: { type: "string", enum: [secret] } } },
      });
      const written = fs.readFileSync(trace, "utf8");
      assert.doesNotMatch(written, new RegExp(secret));
      const [line] = written.trim().split("\n").map((text) => JSON.parse(text));
      assert.equal(line.settings.output_config.effort, "high");
      assert.equal(line.settings.thinking.type, "between_tools");
      assert.ok(line.changes.some((change: { setting: string }) => change.setting === "thinking/output_config"));
    } finally {
      delete process.env.ANTHROPIC_TRACE_PATH;
    }
  });
});

describe("forced tool choice on a model that can't stop thinking", () => {
  it("is dropped visibly: recorded as a compatibility change and warned about once", async (t) => {
    globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
    const warnings: string[] = [];
    t.mock.method(console, "error", (message: string) => { warnings.push(String(message)); });
    const body = JSON.stringify({ ...plain, model: "claude-sonnet-5-5-warning-probe", tool_choice: { type: "tool", name: "read" } });
    const prepare = () => prepareRequest("https://api.anthropic.com/v1/messages", { method: "POST", body }, "token", {
      sessionId: "s", deviceId: "d", claudeTools: false, ensureClaudePrefix: false,
    });
    const first = await prepare();
    await prepare();
    assert.equal(JSON.parse(String(first.body)).tool_choice, undefined);
    assert.deepEqual(first.settingChanges.find((c) => c.setting === "tool_choice")?.reason, "compatibility");
    assert.equal(warnings.filter((w) => w.includes("forced tool_choice")).length, 1);
  });
});

describe("OAuth profile lookup", () => {
  /** Sends `count` requests on token `access`, with `profile` answering the profile endpoint. */
  async function sendAs(access: string, count: number, profile: (init?: RequestInit) => Promise<Response>) {
    const sent: Array<Record<string, unknown>> = [];
    let lookups = 0;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("/oauth/profile")) {
        lookups++;
        return profile(init);
      }
      if (!String(url).includes("/v1/messages")) return new Response("{}", { status: 404 });
      sent.push(JSON.parse(String(init?.body)));
      return new Response(OK.body, { status: OK.status });
    }) as typeof fetch;

    const hooks = await plugin.server({ client: { auth: { set: async () => {} } } });
    const loaded = await hooks.auth.loader(
      async () => ({ type: "oauth", access, refresh: "refresh", expires: Date.now() + 3_600_000 }),
      { models: {} },
    ) as { fetch: typeof fetch };
    const statuses: number[] = [];
    for (let i = 0; i < count; i++) {
      const response = await loaded.fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        body: JSON.stringify(plain),
      });
      await response.text();
      statuses.push(response.status);
    }
    return { statuses, sent, lookups };
  }

  it("sends the request without user_id when the profile endpoint never answers", { timeout: 15_000 }, async () => {
    // Accepts the connection and never answers; only the abort signal ends it.
    const { statuses, sent } = await sendAs("stalled-profile", 1, (init) => new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    }));
    assert.deepEqual(statuses, [200]);
    assert.equal((sent[0]!.metadata as { user_id?: string }).user_id, undefined);
  });

  it("does not repeat a failed lookup on every request", async () => {
    const { statuses, lookups } = await sendAs("failed-profile", 2, async () => new Response("{}", { status: 500 }));
    assert.deepEqual(statuses, [200, 200]);
    assert.equal(lookups, 1);
  });
});

describe("retry policy", () => {
  it("parses Retry-After seconds and HTTP dates", () => {
    assert.equal(parseRetryAfterMs("2"), 2000);
    assert.equal(parseRetryAfterMs(new Date(10_000).toUTCString(), 4_000), 6000);
    assert.equal(parseRetryAfterMs("soon"), null);
  });

  it("refuses waits longer than 10s and backs off without a header", () => {
    assert.equal(getResponseRetryDelayMs(new Headers({ "retry-after": "11" }), 0), null);
    assert.equal(getResponseRetryDelayMs(new Headers(), 1), 4000);
  });

  it("honours retry_after in a token endpoint body", () => {
    assert.equal(getTokenRetryDelayMs(529, '{"error":{"retry_after":3}}', 0), 3000);
    assert.equal(getTokenRetryDelayMs(529, '{"retry_after":60}', 0), null);
    assert.equal(getTokenRetryDelayMs(429, "not json", 0, 0), 1000);
  });
});

process.on("exit", () => fs.rmSync(promptDir, { recursive: true, force: true }));
