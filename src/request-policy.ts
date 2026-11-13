/**
 * What the bridge changes in a request beyond the credential, kept explicit:
 * every change to a setting the caller sent (or didn't) is recorded with its
 * reason, prompt-cache markers stay the host's, and a captured Claude Code
 * prompt is used only for the parts that hold anywhere.
 */

import fs from "node:fs";

export type ChangeReason =
  /** The caller set nothing, so the bridge's default applies. */
  | "default"
  /** The API or this model rejects what was sent; the bridge's least change that it accepts. */
  | "compatibility";

export interface SettingChange {
  setting: string;
  from: unknown;
  to: unknown;
  reason: ChangeReason;
  note?: string;
}

/** What happened to one request after it was prepared: retries, refreshes, rotations. */
export type RequestEvent =
  | { kind: "credential"; reason: "expiry" | "rejected" | "rate-limited"; outcome: "unchanged" | "new-token" | "failed"; account?: string }
  | { kind: "retry"; layer: "single" | "pool"; status: number; delayMs: number; account?: string }
  | { kind: "rotate"; from: string; to: string; status: number; action: string };

/** The API rejects a request with more cache_control markers than this. */
export const MAX_CACHE_BREAKPOINTS = 4;

type Block = { cache_control?: unknown; [key: string]: unknown };

function marked(blocks: unknown): Block[] {
  if (!Array.isArray(blocks)) return [];
  return blocks.filter((block): block is Block => Boolean(block) && typeof block === "object" && "cache_control" in block);
}

function ttlOf(block: Block): string {
  const marker = block.cache_control;
  return typeof marker === "object" && marker !== null && "ttl" in marker && marker.ttl === "1h" ? "1h" : "5m";
}

function markedInMessages(messages: unknown): Block[] {
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((message: unknown) =>
    typeof message === "object" && message !== null && "content" in message ? marked(message.content) : []);
}

/**
 * Keep the host's prompt-cache markers, which place the cache where OpenCode
 * meant it (its system prompt, its latest turns). Only what the API rejects is
 * dropped: a 5m marker ahead of a 1h one, which reordering tools can produce
 * (the later 1h marker caches that prefix anyway), and markers past four
 * breakpoints, a top-level cache_control counting as one: tool markers first,
 * since any later marker caches the tools too, then the earliest message
 * markers, then the earliest system ones.
 */
export function limitCacheBreakpoints(parsed: {
  cache_control?: unknown;
  tools?: unknown;
  system?: unknown;
  messages?: unknown;
}): SettingChange[] {
  const changes: SettingChange[] = [];
  const inPromptOrder = [...marked(parsed.tools), ...marked(parsed.system), ...markedInMessages(parsed.messages)];
  let lastHour = -1;
  inPromptOrder.forEach((block, index) => { if (ttlOf(block) === "1h") lastHour = index; });
  const ahead = inPromptOrder.slice(0, Math.max(lastHour, 0)).filter((block) => ttlOf(block) === "5m");
  for (const block of ahead) delete block.cache_control;
  if (ahead.length > 0) {
    changes.push({
      setting: "cache_control",
      from: "5m marker before a 1h one",
      to: "1h markers first",
      reason: "compatibility",
      note: `the API requires 1h markers before 5m ones; dropped ${ahead.length} 5m marker${ahead.length === 1 ? "" : "s"}`,
    });
  }

  const candidates: Array<[string, Block]> = [
    ...marked(parsed.tools).map((block): [string, Block] => ["tool", block]),
    ...markedInMessages(parsed.messages).map((block): [string, Block] => ["message", block]),
    ...marked(parsed.system).map((block): [string, Block] => ["system", block]),
  ];
  const automatic = typeof parsed.cache_control === "object" && parsed.cache_control !== null ? 1 : 0;
  const total = candidates.length + automatic;
  if (total <= MAX_CACHE_BREAKPOINTS) return changes;
  const dropped = new Map<string, number>();
  for (const [where, block] of candidates.slice(0, total - MAX_CACHE_BREAKPOINTS)) {
    delete block.cache_control;
    dropped.set(where, (dropped.get(where) ?? 0) + 1);
  }
  const what = [...dropped].map(([where, count]) => `${count} ${where} marker${count === 1 ? "" : "s"}`).join(", ");
  changes.push({
    setting: "cache_control",
    from: `${total} markers`,
    to: `${MAX_CACHE_BREAKPOINTS} markers`,
    reason: "compatibility",
    note: `the API accepts at most ${MAX_CACHE_BREAKPOINTS}${automatic ? ", the top-level one included" : ""}; dropped ${what}`,
  });
  return changes;
}

/**
 * Sections of a captured Claude Code prompt that describe the session it was
 * captured in rather than Claude Code itself: its memory directory is a path
 * under the captured project, and its session guidance lists that session's
 * skills and commands. Sent elsewhere, they give the model wrong instructions.
 */
const NON_PORTABLE_SECTIONS = new Set(["Memory", "Session-specific guidance"]);

/** `skipping`: whether the text starts inside a section left out, as a block after its heading does. */
function filterSections(text: string, skipping: boolean): { text: string; skipping: boolean } {
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const heading = /^# (.+?)\s*$/.exec(line);
    if (heading) skipping = NON_PORTABLE_SECTIONS.has(heading[1]!);
    if (!skipping) kept.push(line);
  }
  return { text: kept.join("\n").replace(/\n{3,}/g, "\n\n"), skipping };
}

export function portableCapturedText(text: string): string {
  return filterSections(text, false).text;
}

export interface CaptureProvenance {
  cliVersion: string | null;
  capturedAt: string | null;
}

/** Older captures predate the provenance record; their billing block still names the version. */
export function captureProvenance(cache: {
  provenance?: { cliVersion?: unknown; capturedAt?: unknown };
  updated_at?: unknown;
  billing?: { ccVersion?: unknown };
}): CaptureProvenance {
  const recorded = typeof cache.provenance?.cliVersion === "string" ? cache.provenance.cliVersion : null;
  const fromBilling = typeof cache.billing?.ccVersion === "string"
    ? cache.billing.ccVersion.split(".").slice(0, 3).join(".")
    : null;
  const capturedAt = typeof cache.provenance?.capturedAt === "string"
    ? cache.provenance.capturedAt
    : typeof cache.updated_at === "string" ? cache.updated_at : null;
  return { cliVersion: recorded ?? fromBilling, capturedAt };
}

/**
 * The captured prompt's blocks as sent: portable sections only, and without
 * the capture's own cache markers, which would crowd out the host's.
 */
export function capturedBlocksToSend(
  blocks: Array<{ type?: string; text?: string; cache_control?: unknown }>,
): Array<{ type?: string; text?: string }> {
  // A section runs until the next heading, whichever block that is in.
  let skipping = false;
  const sent: Array<{ type?: string; text?: string }> = [];
  for (const { cache_control: _marker, ...block } of blocks) {
    if (typeof block.text !== "string") {
      sent.push(block);
      continue;
    }
    const filtered = filterSections(block.text, skipping);
    skipping = filtered.skipping;
    if (filtered.text.trim() !== "") sent.push({ ...block, text: filtered.text });
  }
  return sent;
}

/**
 * Append one JSON line per request to ANTHROPIC_TRACE_PATH. Opt-in, local,
 * and free of secrets: no tokens, no prompt text.
 */
/** Setting fields a trace may hold: API enums, numbers and tool names. */
const TRACEABLE_KEYS = new Set(["type", "effort", "budget_tokens", "display", "name", "keep", "edits", "thinking", "output_config"]);

/**
 * The kinds and numbers in a setting, for the trace. Every other field is
 * dropped, since caller objects can carry content: an output schema, say.
 */
export function traceableSetting(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.slice(0, 80);
  if (depth >= 4 || typeof value !== "object") return undefined;
  if (Array.isArray(value)) return value.slice(0, 8).map((item) => traceableSetting(item, depth + 1));
  const kept: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (TRACEABLE_KEYS.has(key)) kept[key] = traceableSetting(item, depth + 1);
  }
  return kept;
}

let traceFailed = false;

export function appendTrace(record: Record<string, unknown>): void {
  const file = process.env.ANTHROPIC_TRACE_PATH;
  if (!file) return;
  try {
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, { mode: 0o600 });
    traceFailed = false;
  } catch (err) {
    // Tracing must never fail a request, nor flood the log while it can't write.
    if (traceFailed) return;
    traceFailed = true;
    console.error(`[opencode-claude-bridge] could not write the request trace to ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Where the bridge sends a subscription bearer without being told to. */
const DEFAULT_TRUSTED_ORIGINS = ["https://api.anthropic.com"];

/**
 * Origins allowed to receive the subscription bearer: Anthropic's API, plus
 * any listed in ANTHROPIC_TRUSTED_ORIGINS (comma or space separated). A
 * provider baseURL is configuration for API keys too, so pointing it at a
 * proxy must not hand that proxy the login by default.
 */
export function trustedOrigins(): Set<string> {
  const origins = new Set(DEFAULT_TRUSTED_ORIGINS);
  for (const entry of (process.env.ANTHROPIC_TRUSTED_ORIGINS ?? "").split(/[\s,]+/)) {
    if (!entry) continue;
    try {
      origins.add(new URL(entry).origin);
    } catch {
      console.error(`[opencode-claude-bridge] ignoring ANTHROPIC_TRUSTED_ORIGINS entry that isn't a URL: ${entry}`);
    }
  }
  return origins;
}

export function isTrustedDestination(url: string): boolean {
  try {
    return trustedOrigins().has(new URL(url).origin);
  } catch {
    return false;
  }
}

export function untrustedDestinationResponse(url: string): Response {
  let origin = url;
  try { origin = new URL(url).origin; } catch { /* keep the raw value */ }
  const message =
    `opencode-claude-bridge did not send this request: ${origin} is not an Anthropic origin, and your Claude ` +
    `subscription login is only sent to one. If it is a proxy you trust, add it to ANTHROPIC_TRUSTED_ORIGINS ` +
    `(e.g. ANTHROPIC_TRUSTED_ORIGINS=${origin}) and restart OpenCode.`;
  console.error(`[opencode-claude-bridge] ${message}`);
  return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}
