import assert from "node:assert/strict";
import { it } from "node:test";
import { createSseProcessor, translateJsonMessage, translateJsonResponse, translateSseStream } from "./stream.js";

const enc = new TextEncoder();
const deps = { inboundToolNameMap: { Bash: "bash" }, translateToolArgs: (s: string) => s };
const ev = (type: string, value: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
const start = (index: unknown) => ev("content_block_start", { index, content_block: { type: "tool_use", name: "Bash" } });
const delta = (index: unknown, partial_json: string) => ev("content_block_delta", { index, delta: { type: "input_json_delta", partial_json } });
const stop = (index: number) => ev("content_block_stop", { index });

it("fails explicitly on duplicate or invalid tool indices", () => {
  for (const input of [start(1) + delta(1, "secret") + start(1), start(null), start(1.5), delta(null, "secret")]) {
    const output = createSseProcessor(deps).feedChunk(input);
    assert.match(output, /event: error/);
    assert.doesNotMatch(output, /secret/);
  }
});

it("fails explicitly on an abandoned tool and does not leak a partial trailing delta", () => {
  const p = createSseProcessor(deps);
  p.feedChunk(start(1) + delta(1, "secret") + 'event: content_block_delta\ndata: {"partial_json":"secret');
  const output = p.flush();
  assert.match(output, /event: error/);
  assert.doesNotMatch(output, /secret/);
});

it("fails explicitly when a pending frame or assembled tool input exceeds its limit", () => {
  const p = createSseProcessor(deps);
  assert.match(p.feedChunk("x".repeat(16 * 1024 * 1024 + 1)), /event: error/);
  const q = createSseProcessor(deps);
  q.feedChunk(start(1));
  const part = "x".repeat(8 * 1024 * 1024 + 1);
  q.feedChunk(delta(1, part));
  const output = q.feedChunk(delta(1, part));
  assert.match(output, /event: error/);
  assert.doesNotMatch(output, /xxxxxxxx/);
});

it("preserves unknown deltas, malformed frames and partial trailing frames", () => {
  const p = createSseProcessor(deps);
  const input = delta(7, "hi") + 'event: x\ndata: {broken\n\n';
  assert.equal(p.feedChunk(input), input);
  assert.equal(p.feedChunk("data: trailing"), "");
  assert.equal(p.flush(), "data: trailing");
});

it("keeps interleaved tool inputs separate and preserves literal names in text and arguments", () => {
  const p = createSseProcessor(deps);
  const text = ev("content_block_delta", { index: 3, delta: { type: "text_delta", text: '"name":"Bash" mcp_Foo' } });
  const arg = '{"name":"Bash","value":"mcp_Foo"}';
  const out = p.feedChunk(text + start(1) + start(2) + delta(1, arg.slice(0, 9)) + delta(2, '{"two":2}') + delta(1, arg.slice(9)) + stop(2) + stop(1));
  assert.ok(out.startsWith(text));
  assert.ok(out.includes(JSON.stringify(arg)));
  assert.ok(out.includes(JSON.stringify('{"two":2}')));
  assert.equal(p.flush(), "");
});

it("reassembles UTF-8 at every byte boundary in text and tool input", async () => {
  const input = ev("content_block_delta", { index: 3, delta: { type: "text_delta", text: "한😀" } }) + start(1) + delta(1, '{"value":"한😀"}') + stop(1);
  const bytes = enc.encode(input);
  for (let i = 1; i < bytes.length; i++) {
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes.slice(0, i)); c.enqueue(bytes.slice(i)); c.close(); } });
    const out = await new Response(translateSseStream(body, deps, { keepaliveMs: 0 })).text();
    assert.ok(out.includes("한😀"));
    assert.ok(out.includes(JSON.stringify('{"value":"한😀"}')));
  }
});

it("cancels one pending upstream read exactly once", async () => {
  let cancels = 0; let pulls = 0;
  const body = new ReadableStream<Uint8Array>({ pull() { pulls++; }, cancel() { cancels++; } });
  const reader = translateSseStream(body, deps, { keepaliveMs: 1 }).getReader();
  const pending = reader.read();
  await new Promise<void>((r) => setImmediate(r));
  await reader.cancel();
  await pending;
  const after = pulls;
  await new Promise<void>((r) => setImmediate(r));
  assert.equal(cancels, 1); assert.equal(pulls, after);
});

it("propagates upstream errors after buffering a tool", async () => {
  const failure = new Error("upstream");
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  const reader = translateSseStream(body, deps, { keepaliveMs: 2 }).getReader();
  controller.enqueue(enc.encode(start(1)));
  await reader.read();
  controller.error(failure);
  await assert.rejects(reader.read(), failure);
  await new Promise((r) => setTimeout(r, 10));
});

it("does not eagerly drain many tool blocks for a slow consumer", async () => {
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({ pull(c) { pulls++; c.enqueue(enc.encode(start(pulls) + delta(pulls, "{}") + stop(pulls))); } });
  const stream = translateSseStream(body, deps, { keepaliveMs: 0 });
  await new Promise<void>((r) => setImmediate(r));
  assert.ok(pulls <= 3, `pulled ${pulls} blocks`);
  await stream.cancel();
});

it("cancels upstream after an oversized frame and emits only one error", async () => {
  let cancels = 0;
  const body = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(enc.encode("x".repeat(16 * 1024 * 1024 + 1))); }, cancel() { cancels++; } });
  const result = await new Response(translateSseStream(body, deps, { keepaliveMs: 0 })).text();
  assert.equal((result.match(/event: error/g) ?? []).length, 1);
  assert.equal(cancels, 1);
  assert.doesNotMatch(result, /xxxxxxxx/);
});

it("reassembles a CRLF split inside a tool block", () => {
  const p = createSseProcessor(deps);
  const input = (start(1) + delta(1, '{"x":1}') + stop(1)).replace(/\n/g, "\r\n");
  const boundary = input.indexOf("\r\n", input.indexOf("partial_json"));
  const out = p.feedChunk(input.slice(0, boundary + 1)) + p.feedChunk(input.slice(boundary + 1)) + p.flush();
  assert.ok(out.includes(JSON.stringify('{"x":1}')));
  assert.doesNotMatch(out, /event: error/);
});

it("preserves a complete stream without message_stop", () => {
  const p = createSseProcessor(deps);
  const out = p.feedChunk(start(1) + delta(1, "{}") + stop(1)) + p.flush();
  assert.match(out, /event: content_block_stop/);
  assert.doesNotMatch(out, /event: error/);
});

it("bounds nonstreaming JSON and leaves malformed bodies unchanged", async () => {
  const logs: string[] = [];
  assert.equal(translateJsonMessage("{bad", { ...deps, debug: (s) => logs.push(s) }), "{bad");
  assert.equal(logs.length, 1);
  const response = new Response("x".repeat(16 * 1024 * 1024 + 1), { headers: { "content-type": "application/json" } });
  const result = await translateJsonResponse(response, deps).json() as { type: string; error: { message: string } };
  assert.equal(result.type, "error");
  assert.match(result.error.message, /limit/);
  assert.doesNotMatch(result.error.message, /xxxxxxxx/);
});
