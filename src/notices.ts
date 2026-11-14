/**
 * Where the bridge's messages go. Inside OpenCode: its log file, and a pop-up
 * for what the user should act on, because anything printed to the terminal
 * lands on top of OpenCode's screen. Everywhere else (the claude-pool command,
 * OpenCode 2's server, tests, or before the plugin has started) they print to
 * stderr as before.
 */

import type { ToastVariant } from "./pool/notify.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogClient {
  /** OpenCode's log file (`~/.local/share/opencode/log/`). */
  app?: {
    log?: (args: { body: { service: string; level: LogLevel; message: string } }) => Promise<unknown>;
  };
}

export type Popup = (variant: ToastVariant, message: string, key: string) => void;

interface Notice { variant: ToastVariant; message: string; detail: string; key: string }

const SERVICE = "opencode-claude-bridge";
/** Bounds what a process that never shows pop-ups (the claude-pool command) keeps waiting. */
const MAX_WAITING = 20;
const MAX_POPUP_CHARS = 240;

let client: LogClient | null = null;
let popup: Popup | null = null;
let sessionActive = false;
/** Raised before the plugin started: shown and logged once it has. */
const early: Notice[] = [];
const waiting: Array<() => void> = [];
const seen = new Set<string>();

const levelOf = (variant: ToastVariant): LogLevel =>
  variant === "error" ? "error" : variant === "warning" ? "warn" : "info";

export function log(level: LogLevel, message: string): void {
  const app = client?.app;
  if (!app?.log) {
    console.error(message);
    return;
  }
  void Promise.resolve()
    .then(() => app.log?.({ body: { service: SERVICE, level, message } }))
    .catch(() => console.error(message));
}

/**
 * Pop-ups sent before OpenCode's screen listens for them are lost, so they
 * wait for a session to be active, as OhMyOpenCode's do.
 */
export function whenSessionActive(show: () => void): void {
  if (sessionActive) show();
  else if (waiting.length < MAX_WAITING) waiting.push(show);
}

export function markSessionActive(): void {
  if (sessionActive) return;
  sessionActive = true;
  for (const show of waiting.splice(0)) show();
}

function show(notice: Notice, now: boolean): void {
  const display = () => popup?.(notice.variant, notice.message, notice.key);
  if (now) display();
  else whenSessionActive(display);
}

/**
 * A pop-up with `message`, and `detail` (by default the same text) in the log.
 * `now` shows it without waiting for a session: for the sign-in dialog, which
 * only exists while OpenCode's screen is up.
 */
export function notify(
  variant: ToastVariant,
  message: string,
  options: { detail?: string; key?: string; now?: boolean } = {},
): void {
  const notice: Notice = {
    variant,
    message: message.length > MAX_POPUP_CHARS ? `${message.slice(0, MAX_POPUP_CHARS - 1)}…` : message,
    detail: options.detail ?? message,
    key: options.key ?? message,
  };
  log(levelOf(variant), notice.detail);
  if (popup) show(notice, options.now ?? false);
  else if (early.length < MAX_WAITING) early.push(notice);
}

/** True the first time `key` is seen in this process. */
export function once(key: string): boolean {
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}

/** From here on messages go to OpenCode's log and pop-ups; those raised earlier are delivered now. */
export function startNotices(next: { client: LogClient; popup: Popup }): void {
  client = next.client;
  popup = next.popup;
  for (const notice of early.splice(0)) {
    log(levelOf(notice.variant), notice.detail);
    show(notice, false);
  }
}
