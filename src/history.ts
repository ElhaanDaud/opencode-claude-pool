export type HistoryMessage = { role?: string; content?: unknown };
export type HistoryRepairs = { synthesized: string[]; convertedResults: string[]; reordered: number };

const MISSING_RESULT = "The bridge added this result because no result for this call is in the conversation, possibly because context was compacted.";
const ORPHAN_PREFIX = "The bridge converted this tool result because its matching call is not in the preceding assistant message.";
const DUPLICATE_PREFIX = "The bridge converted this tool result because its call already has a result earlier in this turn.";

function block(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value));
}

function blocksOf(content: unknown): unknown[] {
  if (Array.isArray(content)) return content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content === undefined ? [] : [content];
}

function ids(messages: HistoryMessage[], type: string, key: string): string[] {
  const result: string[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const value of message.content) {
      const item = block(value);
      if (item?.type === type && typeof item[key] === "string") result.push(item[key]);
    }
  }
  return result;
}

/** Consecutive messages from one role: the API merges them into a single turn. */
function turnsOf(messages: HistoryMessage[]): HistoryMessage[][] {
  const turns: HistoryMessage[][] = [];
  for (const message of messages) {
    const last = turns.at(-1);
    if (last && last[0]!.role === message.role) last.push(message);
    else turns.push([message]);
  }
  return turns;
}

const missingResult = (id: string) => ({ type: "tool_result", tool_use_id: id, is_error: true, content: MISSING_RESULT });

/**
 * Pair every tool call with a result in the next turn, as the API requires.
 * Calls and results are matched per turn, not per message, because the API
 * merges consecutive messages from one role. A user turn that needs repair is
 * sent as one message with its results first; assistant turns, thinking and
 * signatures included, are never changed. A valid history comes back as the
 * same array.
 */
export function repairToolPairs(messages: HistoryMessage[]): { messages: HistoryMessage[]; repairs: HistoryRepairs } {
  const repairs: HistoryRepairs = { synthesized: [], convertedResults: [], reordered: 0 };
  const output: HistoryMessage[] = [];
  let changed = false;
  const turns = turnsOf(messages);

  turns.forEach((turn, index) => {
    if (turn[0]!.role === "user") {
      const previous = turns[index - 1];
      const uses = new Set(previous?.[0]!.role === "assistant" ? ids(previous, "tool_use", "id") : []);
      const present = new Set(ids(turn, "tool_result", "tool_use_id"));
      const missing = [...uses].filter((id) => !present.has(id));
      const converted: unknown[] = [];
      const answered = new Set<string>();
      let convertedAny = false;
      for (const value of turn.flatMap((message) => blocksOf(message.content))) {
        const item = block(value);
        const id = item?.type === "tool_result" && typeof item.tool_use_id === "string" ? item.tool_use_id : undefined;
        // The API rejects a call answered twice as surely as one never made.
        const prefix = id === undefined ? undefined : !uses.has(id) ? ORPHAN_PREFIX : answered.has(id) ? DUPLICATE_PREFIX : undefined;
        if (id !== undefined && prefix === undefined) answered.add(id);
        if (id !== undefined && prefix !== undefined) {
          repairs.convertedResults.push(id);
          convertedAny = true;
          const content = item!.content;
          converted.push({ type: "text", text: typeof content === "string" ? `${prefix}\n${content}` : prefix });
          if (Array.isArray(content)) converted.push(...content);
        } else converted.push(value);
      }
      const isResult = (value: unknown) => block(value)?.type === "tool_result";
      const results = converted.filter(isResult);
      const others = converted.filter((value) => !isResult(value));
      const reordered = converted.some((value, position) => position < results.length && !isResult(value));
      if (missing.length || convertedAny || reordered) {
        changed = true;
        repairs.synthesized.push(...missing);
        if (reordered) repairs.reordered++;
        output.push({ ...turn[0]!, content: [...missing.map(missingResult), ...results, ...others] });
      } else output.push(...turn);
      return;
    }

    output.push(...turn);
    if (turn[0]!.role !== "assistant") return;
    const uses = [...new Set(ids(turn, "tool_use", "id"))];
    if (uses.length && turns[index + 1]?.[0]!.role !== "user") {
      changed = true;
      repairs.synthesized.push(...uses);
      output.push({ role: "user", content: uses.map(missingResult) });
    }
  });

  return { messages: changed ? output : messages, repairs };
}
