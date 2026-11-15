import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

process.env.CLAUDE_POOL_AUTO_ENROLL = "0";
Object.defineProperty(process, "platform", { value: "linux" });
const tokenServer = http.createServer((_req, res) => res.end("{}"));
await new Promise<void>((resolve) => tokenServer.listen(0, "127.0.0.1", resolve));
process.env.ANTHROPIC_TOKEN_URL = `http://127.0.0.1:${(tokenServer.address() as AddressInfo).port}/token`;
after(() => tokenServer.close());
const { default: plugin, getClaudeToolsForActiveOpenCodeTools, getDeclaredFieldsForActiveOpenCodeTools } = await import("./index.js");
const { translateToolArgsJsonString } = await import("./claude-tools.js");
const originalFetch = globalThis.fetch;
const originalHome = process.env.HOME;
const originalClaudeDir = process.env.CLAUDE_CONFIG_DIR;
let home = "";
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "tool-contracts-"));
  process.env.HOME = home;
  process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.HOME = originalHome;
  if (originalClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeDir;
  fs.rmSync(home, { recursive: true, force: true });
});

const schema = (properties: Record<string, unknown>) => ({ type: "object", properties });
const field = { type: "string" };
const host = (name: string, properties: Record<string, unknown>) => ({
  name, description: `host ${name}`, input_schema: schema(properties), eager_input_streaming: true,
});

/** Each cache marker sent, in prompt order (tools, system, messages), with its TTL. */
function sentMarkers(sent: { tools?: unknown[]; system?: unknown[]; messages?: Array<{ content: unknown }> }): string[] {
  const blocks = [...(sent.tools ?? []), ...(sent.system ?? []),
    ...(sent.messages ?? []).flatMap((message) => Array.isArray(message.content) ? message.content : [])] as Array<{ cache_control?: { ttl?: string }; name?: string; text?: string }>;
  return blocks.filter((block) => block.cache_control).map((block) => `${block.cache_control!.ttl ?? "5m"} ${block.name ?? block.text}`);
}

describe("prompt-cache markers on the OAuth path", () => {
  it("sends only markers the API accepts once tools are sorted and automatic caching is on", async () => {
    const bodies: Array<{ cache_control?: unknown; tools?: unknown[]; system?: unknown[]; messages?: Array<{ content: unknown }> }> = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ type: "message", role: "assistant", content: [{ type: "text", text: "ok" }] }),
        { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const hooks = await plugin.server({ client: { auth: { set: async () => {} } } });
    const loaded = await hooks.auth.loader(async () => ({ type: "oauth", access: "token", refresh: "refresh", expires: Date.now() + 3_600_000 }), { models: {} }) as { fetch: typeof fetch };
    const send = (body: Record<string, unknown>) => loaded.fetch("https://api.anthropic.com/v1/messages",
      { method: "POST", body: JSON.stringify({ model: "claude-haiku-4-5-20251001", ...body }) });
    const five = { type: "ephemeral" };
    const marked = (name: string, ttl: string) => ({ ...host(name, { value: field }), cache_control: { type: "ephemeral", ttl } });

    await send({
      tools: [marked("zeta_tool", "1h"), marked("alpha_tool", "5m")],
      system: [{ type: "text", text: "agent", cache_control: five }],
      messages: [{ role: "user", content: "hi" }],
    });
    await send({
      cache_control: five,
      system: [{ type: "text", text: "s1", cache_control: five }, { type: "text", text: "s2", cache_control: five }],
      messages: [
        { role: "user", content: [{ type: "text", text: "u1", cache_control: five }] },
        { role: "assistant", content: [{ type: "text", text: "a1" }] },
        { role: "user", content: [{ type: "text", text: "u2", cache_control: five }] },
      ],
    });

    assert.deepEqual(sentMarkers(bodies[0]!), ["1h zeta_tool", "5m agent"]);
    assert.deepEqual(bodies[1]!.cache_control, five);
    assert.deepEqual(sentMarkers(bodies[1]!), ["5m s1", "5m s2", "5m u2"]);
  });
});

describe("host tool contracts", () => {
  it("preserves each mapped host schema and extra fields, including aliases", () => {
    const names: Record<string, string> = { bash: "Bash", read: "Read", glob: "Glob", grep: "Grep", edit: "Edit", write: "Write", webfetch: "WebFetch", todowrite: "TodoWrite", task: "Agent", skill: "Skill", question: "AskUserQuestion", plan_enter: "EnterPlanMode", plan_exit: "ExitPlanMode" };
    for (const [name, wire] of Object.entries(names)) {
      const tool = host(name, { example: field });
      const [result] = getClaudeToolsForActiveOpenCodeTools([tool]);
      assert.equal(result.name, wire);
      assert.deepEqual(result.input_schema, tool.input_schema);
      assert.equal((result as typeof tool).eager_input_streaming, true);
      assert.ok(result.description.endsWith(tool.description));
      if (name.toLowerCase() === wire.toLowerCase()) assert.equal(result.description, tool.description);
    }
  });

  it("removes stripped fields from fallback schemas and required", () => {
    for (const name of ["bash", "read", "grep", "webfetch", "task", "skill"]) {
      const [tool] = getClaudeToolsForActiveOpenCodeTools([{ name }]);
      const properties = tool.input_schema.properties as Record<string, unknown>;
      const stripped: Record<string, string[]> = { bash: ["run_in_background", "dangerouslyDisableSandbox"], read: ["pages"], grep: ["-i", "-n", "-A", "context", "multiline", "head_limit"], webfetch: ["prompt"], task: ["model", "isolation"], skill: ["args"] };
      for (const key of stripped[name]) {
        assert.equal(key in properties, false);
        assert.equal((tool.input_schema.required as string[] | undefined)?.includes(key) ?? false, false);
      }
    }
  });

  it("renames only toward fields declared by the host, including nested fields", () => {
    const tools = [host("read", { file_path: field, filePath: field }), host("todowrite", { todos: { type: "array", items: schema({ activeForm: field, priority: field }) } }), host("question", { questions: { type: "array", items: schema({ multiSelect: field }) } }), host("webfetch", { url: field, format: field })];
    const declared = getDeclaredFieldsForActiveOpenCodeTools(tools);
    const translate = (name: string, value: object) => JSON.parse(translateToolArgsJsonString(JSON.stringify(value), name, declared[name]));
    assert.deepEqual(translate("Read", { file_path: "a", filePath: "b" }), { file_path: "a", filePath: "b" });
    assert.deepEqual(translate("TodoWrite", { todos: [{ activeForm: "doing", priority: "high" }] }), { todos: [{ activeForm: "doing", priority: "high" }] });
    assert.deepEqual(translate("AskUserQuestion", { questions: [{ multiSelect: true }] }), { questions: [{ multiSelect: true }] });
    assert.deepEqual(translate("WebFetch", { url: "https://example.com" }), { url: "https://example.com" });
    assert.deepEqual(translate("Agent", { task_id: "existing" }), { task_id: "existing" });
    assert.deepEqual(translate("Agent", { prompt: "new" }), { prompt: "new", subagent_type: "general" });
  });

  it("drops any field the host's tool doesn't declare, not only the ones Claude Code's schema adds", () => {
    const declared = getDeclaredFieldsForActiveOpenCodeTools([host("task", { prompt: field, subagent_type: field })]);
    assert.deepEqual(
      JSON.parse(translateToolArgsJsonString(JSON.stringify({ prompt: "p", subagent_type: "explore", description: "d", extra: 1 }), "Agent", declared.Agent)),
      { prompt: "p", subagent_type: "explore" },
    );
  });

  it("sends a task call naming no agent as made when the host's task schema is in use", () => {
    const declared = getDeclaredFieldsForActiveOpenCodeTools([host("task", { prompt: field, category: field, subagent_type: field })]);
    assert.deepEqual(
      JSON.parse(translateToolArgsJsonString(JSON.stringify({ prompt: "new" }), "Agent", declared.Agent)),
      { prompt: "new" },
    );
  });

  it("keeps declarations, choices, history and streamed names consistent across collisions", async () => {
    const tools = [host("read", { filePath: field }), host("Read", { file_path: field }), host("task", { prompt: field }), host("Agent", { custom: field }), host("write", { filePath: field, content: field }), host("foo", { value: field }), host("Foo", { value: field }), host("mcp_read", { value: field })];
    const calls = [
      { name: "read", input: { filePath: "/a" } }, { name: "Read", input: { file_path: "/b" } },
      { name: "task", input: { prompt: "p" } }, { name: "Agent", input: { custom: "x" } },
      { name: "Write", input: { filePath: "/c", content: "c" } }, { name: "foo", input: { value: "a" } },
      { name: "Foo", input: { value: "b" } }, { name: "mcp_read", input: { value: "c" } },
    ];
    const events = calls.flatMap((call, index) => [
      { type: "content_block_start", index, content_block: { type: "tool_use", id: `t${index}`, name: call.name, input: {} } },
      { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) } },
      { type: "content_block_stop", index },
    ]).map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
    let sent: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return new Response(events, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const hooks = await plugin.server({ client: { auth: { set: async () => {} } } });
    const loaded = await hooks.auth.loader(async () => ({ type: "oauth", access: "token", refresh: "refresh", expires: Date.now() + 3_600_000 }), { models: {} }) as { fetch: typeof fetch };
    const history: Array<{ type: string; id: string; name: string; input: Record<string, unknown> }> = calls.map((call, index) => ({ type: "tool_use", id: `h${index}`, name: call.name === "Write" ? "write" : call.name, input: call.input }));
    history.push({ type: "tool_use", id: "inactive", name: "bash", input: { command: "x" } });
    const response = await loaded.fetch("https://api.anthropic.com/v1/messages", { method: "POST", body: JSON.stringify({ model: "claude-haiku-4-5-20251001", tools, tool_choice: { type: "tool", name: "write" }, messages: [{ role: "assistant", content: history }] }) });
    const declared = sent.tools as Array<{ name: string; input_schema: unknown }>;
    const names = new Set(declared.map((tool) => tool.name));
    assert.equal((sent.tool_choice as { name: string }).name, "Write");
    assert.ok(names.has("Write"));
    const blocks = (sent.messages as Array<{ content: typeof history }>)[0].content;
    for (const block of blocks.slice(0, -1)) assert.ok(names.has(block.name));
    assert.equal(blocks.at(-1)?.name, "bash");
    assert.deepEqual(blocks.map((block) => block.input), history.map((block) => block.input));
    assert.deepEqual(declared.find((tool) => tool.name === "task")?.input_schema, tools[2].input_schema);
    const data = (await response.text()).split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
    const received = data.filter((event) => event.type === "content_block_start").map((event) => ({ name: event.content_block.name, input: JSON.parse(data.find((delta) => delta.type === "content_block_delta" && delta.index === event.index).delta.partial_json) }));
    assert.deepEqual(received, calls.map((call) => ({ ...call, name: call.name === "Write" ? "write" : call.name })));
  });
});
