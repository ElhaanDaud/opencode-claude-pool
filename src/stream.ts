/**
 * SSE stream processor for the Anthropic Messages API response.
 *
 * Anthropic streams tool_use arguments as many tiny input_json_delta
 * events whose partial_json fragments can split mid-key (e.g. "file_" +
 * "path"). Doing regex substitution on each chunk as it arrives silently
 * fails at those splits. This module instead:
 *
 *   1. Frames on `\n\n` SSE event boundaries (chunks may contain partial
 *      or multiple events), after normalising CRLF and CR line endings to LF.
 *   2. Buffers input_json_delta fragments per tool_use block (keyed by
 *      content-block index, so interleaved blocks don't corrupt each
 *      other).
 *   3. On content_block_stop, translates the fully-assembled JSON once
 *      via the injected translateToolArgs callback and emits a single
 *      synthetic input_json_delta containing the translated payload,
 *      followed by the stop event.
 *
 * The translateToolArgs callback is injected rather than hard-coded so
 * the same processor can be exercised in isolation from unit tests.
 */

export function parseSseEvent(
  block: string,
): { event: string | null; data: string } | null {
  let eventName: string | null = null;
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) return null;
  return { event: eventName, data: dataLines.join("\n") };
}

export function buildSseEvent(event: string | null, data: string): string {
  return (event ? `event: ${event}\n` : "") + `data: ${data}\n\n`;
}

/**
 * Cheap extraction of the `type` field from an SSE data JSON string
 * without parsing the whole payload. Used to decide whether an event is
 * interesting enough to round-trip through JSON.parse + JSON.stringify.
 * Returns null if the type can't be determined from the first few
 * properties — caller should fall back to a full parse in that case.
 */
function peekType(data: string): string | null {
  // Match the first top-level "type": "..." occurrence. Doesn't handle
  // escaped quotes in the value, but Anthropic type names are plain
  // identifiers so that's fine. If anything weird happens, return null
  // and force a full parse.
  const m = data.match(/^\s*\{\s*"type"\s*:\s*"([a-z_]+)"/);
  return m ? m[1] : null;
}

export type StreamProcessorDeps = {
  /**
   * Map from Claude's tool name (e.g. "Read") to OpenCode's tool name
   * (e.g. "read"). Applied to content_block_start events with type
   * "tool_use".
   */
  inboundToolNameMap: Record<string, string>;

  /**
   * Translate an assembled tool_use argument JSON string from Claude's
   * schema to OpenCode's schema. Receives the raw JSON string and the
   * original (Claude) tool name.
   */
  translateToolArgs: (json: string, toolName: string) => string;

  /**
   * Optional sink for swallowed errors. Called with a short message
   * describing what was swallowed and why. Messages never include stream
   * content, since model output can carry file contents or secrets and the
   * sink is wired to the server log.
   */
  debug?: (msg: string) => void;
};

// Large Write calls are legitimate, but model output is bounded by max_tokens.
export const MAX_TOOL_INPUT_BYTES = 16 * 1024 * 1024;
export const MAX_SSE_FRAME_BYTES = 16 * 1024 * 1024;
export const MAX_JSON_MESSAGE_BYTES = 16 * 1024 * 1024;
// Anthropic streams one content block at a time, so more than one open tool
// call only comes from a malformed upstream; these bound what it can make us hold.
export const MAX_BUFFERED_TOOL_BYTES = 16 * 1024 * 1024;
export const MAX_OPEN_TOOL_BLOCKS = 32;

/** A response over one of the limits above; reported, never truncated. */
export class ResponseLimitError extends Error {}

const byteLength = (text: string) => Buffer.byteLength(text, "utf8");
const safeToolName = (name: string) => /^[a-zA-Z0-9_.-]{1,128}$/.test(name) ? name : "unknown";

function errorEvent(message: string): string {
  return buildSseEvent("error", JSON.stringify({ type: "error", error: { type: "api_error", message } }));
}

/**
 * Create a stateful SSE processor.
 *
 * `feedChunk(text)` accumulates a raw response chunk into the SSE frame
 * buffer, processes every complete event in that buffer, and returns the
 * concatenated transformed bytes to emit downstream. Incomplete trailing
 * frames stay buffered for the next call.
 *
 * `flush()` returns any trailing buffered bytes — used at end-of-stream
 * to avoid dropping data if the upstream closed mid-frame (Anthropic
 * normally ends on a blank line, so this is typically empty).
 */
export function createSseProcessor(deps: StreamProcessorDeps) {
  type ToolBlockState = { toolName: string; partialJson: string; bytes: number };
  const toolBlocks = new Map<number, ToolBlockState>();
  let bufferedBytes = 0;
  let sseBuffer = "";
  // The last chunk ended in "\r", so a leading "\n" completes that CRLF.
  let afterCR = false;
  let failed = false;

  function fail(message: string): string {
    failed = true;
    sseBuffer = "";
    toolBlocks.clear();
    bufferedBytes = 0;
    return errorEvent(message);
  }

  // Event types that require peeking into the JSON to decide whether/how to
  // mutate. Every other event type is a pure pass-through — no need to
  // re-serialize, just forward the original bytes.
  const INTERESTING_TYPES = new Set([
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
  ]);

  function processEvent(block: string): string {
    const parsed = parseSseEvent(block);
    if (!parsed) return block; // comment/keepalive line — pass through
    const { event, data } = parsed;

    // Cheap sniff: if the event isn't one we care about, forward the raw
    // frame. Saves a JSON.parse + JSON.stringify round trip on every
    // message_start, ping, message_delta, and text_delta.
    const cheapType = peekType(data);
    if (cheapType !== null && !INTERESTING_TYPES.has(cheapType)) {
      return block;
    }

    let obj: unknown;
    try {
      obj = JSON.parse(data);
    } catch {
      // V8's parse error quotes the input, so report only the frame's shape.
      deps.debug?.(`processEvent: JSON.parse failed for a ${data.length}-byte ${event ?? "data"} frame; passed through unchanged`);
      return block;
    }

    if (obj === null || typeof obj !== "object") {
      return block;
    }
    const rec = obj as Record<string, any>;
    const type = rec.type as string | undefined;

    if (type === "content_block_start" && Number.isSafeInteger(rec.index)) {
      const existing = toolBlocks.get(rec.index);
      if (existing) return fail(`Duplicate tool index ${rec.index} for ${safeToolName(existing.toolName)}`);
    }

    // content_block_start with tool_use: translate name, register per-index state
    if (
      type === "content_block_start" &&
      rec.content_block &&
      typeof rec.content_block === "object" &&
      rec.content_block.type === "tool_use"
    ) {
      const idx = rec.index as number;
      const claudeName: string = rec.content_block.name || "";
      if (!Number.isSafeInteger(idx) || idx < 0) return fail(`Invalid tool index for ${safeToolName(claudeName)}`);
      if (toolBlocks.size >= MAX_OPEN_TOOL_BLOCKS) return fail(`Open tool call limit ${MAX_OPEN_TOOL_BLOCKS} exceeded at ${safeToolName(claudeName)}`);
      const mapped = deps.inboundToolNameMap[claudeName] || claudeName;
      rec.content_block.name = mapped;
      if (rec.content_block.input === undefined) rec.content_block.input = {};
      toolBlocks.set(idx, { toolName: claudeName, partialJson: "", bytes: 0 });
      return buildSseEvent(event, JSON.stringify(rec));
    }

    // input_json_delta: buffer the fragment, emit nothing yet
    if (
      type === "content_block_delta" &&
      rec.delta &&
      typeof rec.delta === "object" &&
      rec.delta.type === "input_json_delta"
    ) {
      const idx = rec.index as number;
      if (!Number.isSafeInteger(idx) || idx < 0) return fail("Invalid tool delta index for unknown tool");
      const state = toolBlocks.get(idx);
      if (state) {
        const fragment = String(rec.delta.partial_json ?? "");
        const fragmentBytes = byteLength(fragment);
        const size = state.bytes + fragmentBytes;
        if (size > MAX_TOOL_INPUT_BYTES) return fail(`Tool input limit ${MAX_TOOL_INPUT_BYTES} bytes exceeded: ${size} bytes for ${safeToolName(state.toolName)}`);
        if (bufferedBytes + fragmentBytes > MAX_BUFFERED_TOOL_BYTES) {
          return fail(`Buffered tool input limit ${MAX_BUFFERED_TOOL_BYTES} bytes exceeded across ${toolBlocks.size} open tool calls`);
        }
        state.bytes = size;
        bufferedBytes += fragmentBytes;
        state.partialJson += fragment;
        return "";
      }
      return block;
    }

    // content_block_stop: if this closed a tool_use block, flush a synthetic
    // input_json_delta containing the fully translated JSON, then emit the stop.
    if (type === "content_block_stop") {
      const idx = rec.index as number;
      if ((!Number.isSafeInteger(idx) || idx < 0) && toolBlocks.size > 0) return fail("Invalid content block stop index for unknown tool");
      const state = toolBlocks.get(idx);
      if (state) {
        toolBlocks.delete(idx);
        bufferedBytes -= state.bytes;
        let translated: string;
        try {
          translated = deps.translateToolArgs(state.partialJson, state.toolName);
        } catch (e) {
          deps.debug?.(`translateToolArgs threw for ${state.toolName}: ${e instanceof Error ? e.message : String(e)}`);
          translated = state.partialJson;
        }
        const synthDelta = {
          type: "content_block_delta",
          index: idx,
          delta: { type: "input_json_delta", partial_json: translated },
        };
        return (
          buildSseEvent("content_block_delta", JSON.stringify(synthDelta)) +
          block
        );
      }
      return block;
    }

    // Interesting type we didn't end up mutating (e.g. a non-tool_use
    // content_block_start, or a text_delta inside a content_block_delta).
    return block;
  }

  function feedChunk(text: string): string {
    if (failed) return "";
    // SSE allows CRLF, LF or CR line endings; frame and parse on LF only.
    const skip = afterCR && text.startsWith("\n") ? 1 : 0;
    if (text) afterCR = text.endsWith("\r");
    sseBuffer += text.slice(skip).replace(/\r\n?/g, "\n");
    let out = "";
    while (true) {
      const boundary = sseBuffer.indexOf("\n\n");
      const frameSize = byteLength(boundary === -1 ? sseBuffer : sseBuffer.slice(0, boundary + 2));
      if (frameSize > MAX_SSE_FRAME_BYTES) {
        const tool = toolBlocks.values().next().value as ToolBlockState | undefined;
        return out + fail(`SSE frame limit ${MAX_SSE_FRAME_BYTES} bytes exceeded: ${frameSize} bytes for ${safeToolName(tool?.toolName ?? "unknown")}`);
      }
      if (boundary === -1) break;
      const block = sseBuffer.slice(0, boundary + 2);
      sseBuffer = sseBuffer.slice(boundary + 2);
      out += processEvent(block);
      if (failed) break;
    }
    return out;
  }

  function flush(): string {
    if (failed) return "";
    const remaining = sseBuffer;
    sseBuffer = "";
    afterCR = false;
    if (toolBlocks.size > 0) {
      // The upstream disconnected mid-tool_use without sending
      // content_block_stop, so we never emitted a synthetic translated
      // delta for these blocks. The consumer will see the start but no
      // completed args. Surface it so the operator isn't debugging a
      // ghost.
      const orphaned = Array.from(toolBlocks.entries()).map(
        ([idx, s]) => `index=${idx} tool=${safeToolName(s.toolName)} bufferedBytes=${s.bytes}`,
      );
      deps.debug?.(`flush: ${toolBlocks.size} tool_use block(s) abandoned mid-stream: ${orphaned.join("; ")}`);
      const state = toolBlocks.values().next().value as ToolBlockState;
      return fail(`Truncated tool input for ${safeToolName(state.toolName)}: ${state.bytes} bytes buffered`);
    }
    return remaining;
  }

  /** Drop buffered state after the consumer cancelled; nothing was abandoned. */
  function discard(): void {
    sseBuffer = "";
    afterCR = false;
    toolBlocks.clear();
    bufferedBytes = 0;
  }

  return { feedChunk, flush, discard, pendingToolBlocks: () => toolBlocks.size, failed: () => failed };
}

/**
 * Translate a complete JSON message's tool calls. A body that isn't a message
 * comes back as it is; one over a limit throws ResponseLimitError.
 */
export function translateJsonMessage(body: string, deps: StreamProcessorDeps): string {
  if (byteLength(body) > MAX_JSON_MESSAGE_BYTES) {
    throw new ResponseLimitError(`JSON message limit ${MAX_JSON_MESSAGE_BYTES} bytes exceeded`);
  }
  let message: { type?: unknown; content?: unknown };
  try {
    message = JSON.parse(body);
  } catch {
    deps.debug?.("translateJsonMessage: invalid JSON; passed through unchanged");
    return body;
  }
  if (!message || message.type !== "message" || !Array.isArray(message.content)) return body;
  for (const block of message.content as Array<Record<string, unknown>>) {
    if (!block || block.type !== "tool_use" || typeof block.name !== "string" || !(block.name in deps.inboundToolNameMap)) continue;
    const name = block.name;
    const input = JSON.stringify(block.input);
    if (byteLength(input) > MAX_TOOL_INPUT_BYTES) {
      throw new ResponseLimitError(`Tool input limit ${MAX_TOOL_INPUT_BYTES} bytes exceeded: ${byteLength(input)} bytes for ${safeToolName(name)}`);
    }
    try {
      block.input = JSON.parse(deps.translateToolArgs(input, name));
    } catch {
      deps.debug?.("translateJsonMessage: invalid tool input; passed through unchanged");
      return body;
    }
    block.name = deps.inboundToolNameMap[name];
  }
  return JSON.stringify(message);
}

/**
 * The bridge's own failure, sent with a failure status: under the upstream's
 * 200 the host would read an error envelope as a model answer.
 */
function limitResponse(message: string): Response {
  return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message } }), {
    status: 502,
    statusText: "Bad Gateway",
    headers: { "content-type": "application/json" },
  });
}

/**
 * Translate a successful non-streaming JSON message. The whole body is read
 * first (up to MAX_JSON_MESSAGE_BYTES) so a limit can fail the response
 * rather than its content. A body left untranslated keeps its exact bytes.
 */
export async function translateJsonResponse(response: Response, deps: StreamProcessorDeps): Promise<Response> {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_JSON_MESSAGE_BYTES) {
      void reader.cancel().catch(() => {});
      return limitResponse(`JSON message limit ${MAX_JSON_MESSAGE_BYTES} bytes exceeded`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  let translated: string;
  try {
    translated = translateJsonMessage(text, deps);
  } catch (error) {
    if (error instanceof ResponseLimitError) return limitResponse(error.message);
    throw error;
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(translated === text ? bytes : translated, { status: response.status, statusText: response.statusText, headers });
}

/** OpenCode 1 aborts a stream after 300s without bytes by default (chunkTimeout). */
export const DEFAULT_KEEPALIVE_MS = 15_000;

/**
 * SSE comment frame. Comments are ignored by SSE parsers but count as bytes
 * for the host's read timeout.
 */
export const KEEPALIVE_FRAME = ": keepalive\n\n";

/**
 * Pipe an Anthropic SSE body through the processor. While a tool_use block is
 * buffered nothing reaches the consumer, so a long Write can stay silent past
 * the host's read timeout and be aborted; a comment frame is sent every
 * `keepaliveMs` of downstream silence while input is buffered.
 */
export function translateSseStream(
  body: ReadableStream<Uint8Array>,
  deps: StreamProcessorDeps,
  opts: { keepaliveMs?: number } = {},
): ReadableStream<Uint8Array> {
  const keepaliveMs = opts.keepaliveMs ?? DEFAULT_KEEPALIVE_MS;
  const processor = createSseProcessor(deps);
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let cancelled = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastEmit = Date.now();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (keepaliveMs > 0) {
        timer = setInterval(() => {
          if (!cancelled && (controller.desiredSize ?? 0) > 0 && processor.pendingToolBlocks() > 0 && Date.now() - lastEmit >= keepaliveMs) {
            controller.enqueue(encoder.encode(KEEPALIVE_FRAME));
            lastEmit = Date.now();
          }
        }, Math.max(1, Math.floor(keepaliveMs / 3)));
        timer.unref?.();
      }
    },
    async pull(controller) {
      const emit = (text: string) => {
        if (!text || cancelled) return;
        controller.enqueue(encoder.encode(text));
        lastEmit = Date.now();
      };
      try {
        while (!cancelled && (controller.desiredSize ?? 0) > 0) {
          const { done, value } = await reader.read();
          if (cancelled) {
            processor.discard();
            return;
          }
          if (done) {
            emit(processor.feedChunk(decoder.decode()));
            emit(processor.flush());
            clearInterval(timer);
            controller.close();
            return;
          }
          emit(processor.feedChunk(decoder.decode(value, { stream: true })));
          if (processor.failed()) {
            clearInterval(timer);
            cancelled = true;
            void reader.cancel().catch(() => {});
            controller.close();
            return;
          }
        }
      } catch (e) {
        clearInterval(timer);
        if (!cancelled) controller.error(e);
      }
    },
    cancel(reason) {
      cancelled = true;
      processor.discard();
      clearInterval(timer);
      return reader.cancel(reason);
    },
  });
}
