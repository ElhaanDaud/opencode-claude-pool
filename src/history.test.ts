import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { repairToolPairs } from "./history.js";
import { stripAssistantPrefillForClaude } from "./index.js";

const use = (id: string) => ({ type: "tool_use", id, name: "test", input: {} });
const result = (id: string, content: unknown = "ok") => ({ type: "tool_result", tool_use_id: id, content });
const text = (value: string) => ({ type: "text", text: value });
const assistant = (...content: unknown[]) => ({ role: "assistant", content });
const user = (...content: unknown[]) => ({ role: "user", content });

describe("repairToolPairs", () => {
  it("returns the same array for valid history", () => {
    const input = [assistant(use("a")), user(result("a"), text("hello"))];
    const repaired = repairToolPairs(input);
    assert.strictEqual(repaired.messages, input);
    assert.deepEqual(repaired.repairs, { synthesized: [], convertedResults: [], reordered: 0 });
  });

  it("synthesizes a missing result before existing content without mutation", () => {
    const input = [assistant(use("a")), user(text("hello"))];
    const before = JSON.stringify(input);
    const repaired = repairToolPairs(input);
    assert.equal(JSON.stringify(input), before);
    assert.deepEqual(repaired.repairs.synthesized, ["a"]);
    assert.deepEqual(repaired.messages[1].content, [
      { type: "tool_result", tool_use_id: "a", is_error: true, content: "The bridge added this result because no result for this call is in the conversation, possibly because context was compacted." },
      text("hello"),
    ]);
  });

  it("synthesizes multiple missing results ahead of existing results", () => {
    const repaired = repairToolPairs([assistant(use("a"), use("b"), use("c")), user(result("b"))]);
    assert.deepEqual(repaired.repairs.synthesized, ["a", "c"]);
    const content = repaired.messages[1].content;
    assert.ok(Array.isArray(content));
    assert.deepEqual(content.map((item) => item.tool_use_id), ["a", "c", "b"]);
  });

  it("inserts a user message after a final assistant", () => {
    const repaired = repairToolPairs([assistant(use("last"))]);
    assert.equal(repaired.messages[1].role, "user");
    assert.deepEqual(repaired.repairs.synthesized, ["last"]);
  });

  it("leaves a call answered after a turn split across assistant messages, which the API merges", () => {
    const input = [user(text("go")), assistant(use("a")), assistant(text("more")), user(result("a", "REAL"))];
    const repaired = repairToolPairs(input);
    assert.strictEqual(repaired.messages, input);
    assert.deepEqual(repaired.repairs, { synthesized: [], convertedResults: [], reordered: 0 });
  });

  it("answers an unanswered call in a split assistant turn after the whole turn", () => {
    const first = assistant(use("a"));
    const next = assistant(text("next"));
    const repaired = repairToolPairs([first, next]);
    assert.strictEqual(repaired.messages[0], first);
    assert.strictEqual(repaired.messages[1], next);
    assert.equal(repaired.messages[2].role, "user");
    assert.deepEqual(repaired.repairs.synthesized, ["a"]);
  });

  it("repairs a user turn split across messages as one message, results first", () => {
    const missing = repairToolPairs([assistant(use("a"), use("b")), user(result("a")), user(text("hi"))]);
    assert.equal(missing.messages.length, 2);
    const content = missing.messages[1].content;
    assert.ok(Array.isArray(content));
    assert.deepEqual(content.map((item) => item.tool_use_id ?? item.text), ["b", "a", "hi"]);

    const misordered = repairToolPairs([assistant(use("a")), user(text("note")), user(result("a"))]);
    assert.deepEqual(misordered.messages[1].content, [result("a"), text("note")]);
    assert.deepEqual(misordered.repairs, { synthesized: [], convertedResults: [], reordered: 1 });
  });

  it("preserves a string user message as a text block", () => {
    const repaired = repairToolPairs([assistant(use("a")), { role: "user", content: "hello" }]);
    const content = repaired.messages[1].content;
    assert.ok(Array.isArray(content));
    assert.equal(content[0].tool_use_id, "a");
    assert.deepEqual(content[1], text("hello"));
  });

  it("converts an orphan string result to disclosed text in place", () => {
    const repaired = repairToolPairs([user(text("before"), result("orphan", "output"), text("after"))]);
    assert.deepEqual(repaired.repairs.convertedResults, ["orphan"]);
    assert.deepEqual(repaired.messages[0].content, [text("before"), text("The bridge converted this tool result because its matching call is not in the preceding assistant message.\noutput"), text("after")]);
  });

  it("preserves text and image blocks from an orphan array result", () => {
    const image = { type: "image", source: { type: "base64", data: "AA==" } };
    const repaired = repairToolPairs([user(result("orphan", [text("output"), image]))]);
    assert.deepEqual(repaired.messages[0].content, [text("The bridge converted this tool result because its matching call is not in the preceding assistant message."), text("output"), image]);
  });

  it("moves results first stably and counts each reordered user message", () => {
    const repaired = repairToolPairs([assistant(use("a"), use("b")), user(text("one"), result("b"), text("two"), result("a"))]);
    assert.deepEqual(repaired.messages[1].content, [result("b"), result("a"), text("one"), text("two")]);
    assert.equal(repaired.repairs.reordered, 1);
  });

  it("preserves thinking and redacted thinking including signatures byte-for-byte", () => {
    const turn = assistant({ type: "thinking", thinking: "secret", signature: "sig+==" }, { type: "redacted_thinking", data: "opaque" }, use("a"));
    const before = JSON.stringify(turn);
    const repaired = repairToolPairs([turn, user(text("hi"))]);
    assert.strictEqual(repaired.messages[0], turn);
    assert.equal(JSON.stringify(repaired.messages[0]), before);
  });

  it("is idempotent after synthesis, orphan conversion and reordering", () => {
    const first = repairToolPairs([assistant(use("a"), use("b")), user(text("x"), result("a"), result("orphan", "x"))]);
    const second = repairToolPairs(first.messages);
    assert.strictEqual(second.messages, first.messages);
    assert.deepEqual(second.repairs, { synthesized: [], convertedResults: [], reordered: 0 });
  });

  it("handles missing and non-array content and ignores blocks without IDs", () => {
    const unchanged = [assistant({ type: "tool_use" }), user({ type: "tool_result" }), { role: "user" }, { role: "user", content: 42 }];
    assert.strictEqual(repairToolPairs(unchanged).messages, unchanged);
    const repaired = repairToolPairs([assistant(use("a")), { role: "user", content: 42 }]);
    assert.deepEqual((repaired.messages[1].content as unknown[])[1], 42);
    assert.equal(repairToolPairs([assistant(use("a")), { role: "user" }]).repairs.synthesized[0], "a");
  });
});

describe("stripAssistantPrefillForClaude current semantics", () => {
  it("removes OpenCode's content-free continuation nudge at the tail", () => {
    const input = [{ role: "user", content: "hi" }, { role: "assistant", content: "Continue with your tasks." }];
    assert.deepEqual(stripAssistantPrefillForClaude(input), [input[0]]);
  });

  it("keeps genuine prefill or max-steps tail and adds Continue so the model answers fresh instead of continuing prefill", () => {
    for (const content of ['{"', "Maximum steps reached."]) {
      const input = [{ role: "assistant", content }];
      assert.deepEqual(stripAssistantPrefillForClaude(input), [input[0], { role: "user", content: "Continue." }]);
    }
  });

  it("adds Continue after a tool_use tail, which repairToolPairs must answer first", () => {
    const turn = assistant(use("a"));
    const stripped = stripAssistantPrefillForClaude([turn]);
    assert.deepEqual(stripped, [turn, { role: "user", content: "Continue." }]);
    const repaired = repairToolPairs(stripped);
    const content = repaired.messages[1].content;
    assert.ok(Array.isArray(content));
    assert.equal(content[0].type, "tool_result");
    assert.equal(content[0].tool_use_id, "a");
    assert.equal(content[0].is_error, true);
    assert.deepEqual(content[1], text("Continue."));
    assert.strictEqual(repairToolPairs(repaired.messages).messages, repaired.messages);
  });
});
