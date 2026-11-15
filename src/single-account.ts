/**
 * The single-account OAuth login (no pool enrolled): who owns its refresh
 * token, and the one place it is refreshed.
 *
 * Refresh tokens rotate and the old one dies at once, so a token chain must
 * have exactly one refresher. Two owners are possible here:
 *
 *  - the bridge, for a login made through `opencode auth login` (browser
 *    sign-in). Recorded below, and refreshed only by this coordinator: under
 *    the pool's cross-process lock, re-read under it, journaled before saving.
 *  - Claude Code, for a login copied from the Claude CLI. Never refreshed
 *    here: spending its refresh token would log Claude Code out. The copy
 *    follows whatever the CLI holds, and once that has expired the request
 *    fails saying how to get a fresh login.
 *
 * A login whose ownership was never recorded is treated as a Claude Code copy.
 * Its refresh token may already be spent (older versions refreshed the CLI's
 * token), and resending a spent refresh token is what token theft looks like.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { readClaudeCredentials } from "./keychain.js";
import { log } from "./notices.js";
import { refreshTokens } from "./oauth.js";
import type { OAuthTokens } from "./oauth.js";
import { isCredentialRejected } from "./pool/manager.js";
import { LockTimeoutError, createRotationStateStore, defaultLockPath, defaultStatePath } from "./pool/rotation-state.js";

export type Owner = "bridge" | "claude-cli";

/** The refresh lock is busy or unavailable: retry, never refresh without it. */
export class CredentialBusyError extends Error {}

/** No usable access token; the message says how to get one. */
export class CredentialUnavailableError extends Error {}

export interface StoredLogin {
  type?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  /** Set when the stored credential is an API key, not an OAuth login. */
  key?: string;
}

export interface SingleAccountOptions {
  /** OpenCode's stored anthropic credential, read afresh on every call. */
  getAuth: () => Promise<StoredLogin | undefined>;
  save: (tokens: OAuthTokens) => Promise<void>;
  readCli?: () => OAuthTokens | null;
  refresh?: (refreshToken: string) => Promise<OAuthTokens>;
  withLock?: <T>(fn: () => Promise<T>) => Promise<T>;
  dir?: string;
  clock?: () => number;
}

export const CLI_LOGIN_EXPIRED =
  "The Claude Code login OpenCode is using has expired or was rejected, and OpenCode never refreshes " +
  "Claude Code's own login (that would log Claude Code out). Run `claude` once so it refreshes its login, " +
  "sign in with `opencode auth login` (Claude Pro / Max) for a login OpenCode keeps fresh itself, " +
  "or enroll accounts with `claude-pool enroll`.";

const EXPIRY_BUFFER_MS = 60_000;
/** The current bridge-owned chain and the one it replaced, for a save that failed. */
const OWNED_HISTORY = 2;

// Process-wide: OpenCode may build the plugin more than once, and every copy
// must share one refresh and one view of rejected tokens.
let flight: Promise<OAuthTokens> | null = null;
const rejectedAccess = new Set<string>();
/** Spent refresh token → what replaced it here, while the store still returns the spent one. */
const replacedBy = new Map<string, OAuthTokens>();
/** Refresh tokens the token endpoint refused, with its answer: sending one again only repeats it. */
const refused = new Map<string, string>();

/**
 * The newest tokens this process holds for a chain: a refresh whose save
 * failed is followed by others while the store still holds the first token,
 * and only the last of them is still valid.
 */
function latestOf(tokens: OAuthTokens): OAuthTokens {
  let latest = tokens;
  const seen = new Set([tokens.refresh]);
  for (;;) {
    const next = replacedBy.get(latest.refresh);
    if (!next) return latest;
    // An endpoint that stopped rotating refresh tokens would link a token to itself.
    if (next.refresh === latest.refresh) return next;
    // Every earlier token in a chain is spent, so a loop leaves none that is safe to send.
    if (seen.has(next.refresh)) {
      throw new CredentialUnavailableError(
        "The refreshed Claude login's tokens loop back to one already used, so none of them is sent; sign in again with `opencode auth login`.",
      );
    }
    seen.add(next.refresh);
    latest = next;
  }
}

function producedHere(refresh: string): boolean {
  for (const tokens of replacedBy.values()) if (tokens.refresh === refresh) return true;
  return false;
}

export function defaultSingleAccountDir(): string {
  return path.join(os.homedir(), ".local", "share", "opencode-claude-bridge");
}

function cliLogin(): OAuthTokens | null {
  const oauth = readClaudeCredentials()?.claudeAiOauth;
  return oauth ? { access: oauth.accessToken, refresh: oauth.refreshToken, expires: oauth.expiresAt } : null;
}

function asTokens(login: StoredLogin | undefined): OAuthTokens | null {
  if (login?.type !== "oauth" || !login.refresh) return null;
  return { access: login.access ?? "", refresh: login.refresh, expires: login.expires ?? 0 };
}

const fingerprint = (refresh: string): string => createHash("sha256").update(refresh).digest("hex");

/** Write via a synced temp file and rename, then sync the directory entry. */
function writeDurably(file: string, contents: string): void {
  const directory = path.dirname(file);
  if (fs.mkdirSync(directory, { recursive: true, mode: 0o700 })) fs.chmodSync(directory, 0o700);
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, contents);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
  let dirFd: number | undefined;
  try {
    dirFd = fs.openSync(directory, "r");
    fs.fsyncSync(dirFd);
  } catch {
    // Not every platform can sync a directory; the file is written either way.
  } finally {
    if (dirFd !== undefined) fs.closeSync(dirFd);
  }
}

/**
 * Resolve with `promise`, or reject as soon as `signal` aborts. The work behind
 * `promise` carries on: a refresh already sent must land in the store, or the
 * only valid refresh token is lost.
 */
export function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (err) => { signal.removeEventListener("abort", onAbort); reject(err); },
    );
  });
}

export function createSingleAccount(opts: SingleAccountOptions) {
  const clock = opts.clock ?? Date.now;
  const readCli = opts.readCli ?? cliLogin;
  const refreshFn = opts.refresh ?? ((token: string) => refreshTokens(token));
  const withLock = opts.withLock
    ?? (<T>(fn: () => Promise<T>) =>
      createRotationStateStore({ path: defaultStatePath(), lockPath: defaultLockPath() }).withLock(() => fn()));
  const dir = () => opts.dir ?? defaultSingleAccountDir();
  const ownersPath = () => path.join(dir(), "single-account-owner.json");
  const journalPath = () => path.join(dir(), "single-account-journal.json");

  const usable = (tokens: OAuthTokens | null | undefined): boolean =>
    Boolean(tokens?.access) && tokens!.expires > clock() + EXPIRY_BUFFER_MS && !rejectedAccess.has(tokens!.access);

  // ── Ownership (fingerprints only: the record holds no secret) ─────

  function bridgeOwned(): string[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(ownersPath(), "utf8")) as { bridge?: unknown };
      return Array.isArray(parsed.bridge) ? parsed.bridge.filter((hash): hash is string => typeof hash === "string") : [];
    } catch {
      return [];
    }
  }

  function ownerOf(refresh: string | undefined): Owner {
    if (refresh === undefined) return "claude-cli";
    // Spent or produced here, or named by a journal not yet cleared: the
    // bridge's, however many refreshes failed saves took and whether or not
    // the bounded record below could be written.
    const journal = readJournal();
    if (replacedBy.has(refresh) || producedHere(refresh) || journal?.replaces === refresh || journal?.tokens.refresh === refresh) {
      return "bridge";
    }
    return bridgeOwned().includes(fingerprint(refresh)) ? "bridge" : "claude-cli";
  }

  /** `kept`, the stored chain a failed save leaves in place, stays recorded beside the new one. */
  function recordBridgeOwned(refresh: string, kept?: string): void {
    const hashes = (kept === undefined ? [refresh] : [refresh, kept]).map(fingerprint);
    const owned = [...new Set([...hashes, ...bridgeOwned()])].slice(0, OWNED_HISTORY);
    writeDurably(ownersPath(), JSON.stringify({ bridge: owned }));
  }

  /** Whether the record now names `refresh`. Until it does, the journal must stay: nothing else on disk says the login is OpenCode's own. */
  function recordRefreshedAsOwned(refresh: string): boolean {
    try {
      recordBridgeOwned(refresh);
      return true;
    } catch (err) {
      log("warn", `[opencode-claude-bridge] could not record the refreshed login as OpenCode's own; keeping the refresh journal in its place: ${firstLine(err)}`);
      return false;
    }
  }

  // ── Journal: refreshed tokens on disk before the store has them ───

  interface Journal { tokens: OAuthTokens; replaces: string; writtenAt: number }
  type JournalState = { kind: "absent" } | { kind: "unreadable"; reason: string } | { kind: "valid"; journal: Journal };

  function journalState(): JournalState {
    let raw: string;
    try {
      raw = fs.readFileSync(journalPath(), "utf8");
    } catch (err) {
      const code = err instanceof Error && "code" in err ? String(err.code) : "read failed";
      return code === "ENOENT" ? { kind: "absent" } : { kind: "unreadable", reason: code };
    }
    let parsed: Journal;
    try {
      parsed = JSON.parse(raw) as Journal;
    } catch {
      // Not the parser's message: it quotes the file, which holds tokens.
      return { kind: "unreadable", reason: "not valid JSON" };
    }
    return parsed?.tokens?.refresh && typeof parsed.replaces === "string"
      ? { kind: "valid", journal: parsed }
      : { kind: "unreadable", reason: "not a refresh journal" };
  }

  function readJournal(): Journal | null {
    const state = journalState();
    return state.kind === "valid" ? state.journal : null;
  }

  function clearJournal(): void {
    try { fs.rmSync(journalPath(), { force: true }); } catch { /* best effort */ }
  }

  /** Out of the replay path but kept: they may be the only live tokens of the login they came from. */
  function setAsideTokens(journal: Journal, reason: string): void {
    if (readJournal()?.tokens.refresh === journal.tokens.refresh) {
      setAsideJournal(reason);
      return;
    }
    // Their journal write failed, so nothing on disk holds them yet.
    const aside = `${journalPath()}.${randomUUID()}.stale`;
    writeDurably(aside, JSON.stringify(journal));
    log("warn", `[opencode-claude-bridge] set aside the refreshed single-account tokens (${reason}): ${aside}`);
  }

  /** Rename, never delete: the journal may hold the only live token. Throws if it can't be moved. */
  function setAsideJournal(reason: string): void {
    const aside = `${journalPath()}.${randomUUID()}.stale`;
    fs.renameSync(journalPath(), aside);
    log("warn", `[opencode-claude-bridge] set aside the single-account refresh journal (${reason}): ${aside}`);
  }

  /** Caller holds the lock. Commits a journal left by a save that failed or a process that died. */
  async function replayJournalLocked(): Promise<void> {
    const state = journalState();
    if (state.kind === "absent") return;
    if (state.kind === "unreadable") {
      // Refreshing without it would resend the spent token it replaced.
      throw new CredentialUnavailableError(
        `OpenCode's own Claude login is not being refreshed: its refresh journal ${journalPath()} can't be read (${state.reason}) ` +
        "and may hold the login's only valid token. Repair the file or move it aside; if the login then stops working, sign in again with `opencode auth login`.",
      );
    }
    const { journal } = state;
    const stored = asTokens(await opts.getAuth());
    if (stored?.refresh === journal.tokens.refresh) {
      if (recordRefreshedAsOwned(journal.tokens.refresh)) clearJournal();
      return;
    }
    if (stored?.refresh !== journal.replaces) {
      setAsideJournal("the stored login changed since it was written");
      return;
    }
    replacedBy.set(journal.replaces, journal.tokens);
    // This process may have refreshed past the journaled tokens when it
    // couldn't update the journal; those older tokens are spent.
    const latest = latestOf(journal.tokens);
    if (latest !== journal.tokens) {
      try {
        writeJournal({ tokens: latest, replaces: journal.replaces, writtenAt: clock() });
      } catch (err) {
        log("warn", `[opencode-claude-bridge] could not journal the refreshed login: ${firstLine(err)}`);
      }
    }
    const recorded = recordRefreshedAsOwned(latest.refresh);
    try {
      await opts.save(latest);
      if (recorded) clearJournal();
      log("info", "[opencode-claude-bridge] saved a refreshed login left in the journal");
    } catch (err) {
      log("warn", `[opencode-claude-bridge] the refreshed login is still unsaved, kept in the journal: ${firstLine(err)}`);
    }
  }

  // ── Claude Code's login: read, never refreshed ────────────────────

  async function followCli(stored: OAuthTokens | null): Promise<OAuthTokens> {
    const cli = readCli();
    if (cli && usable(cli)) {
      if (cli.refresh !== stored?.refresh || cli.access !== stored?.access) {
        // Keeps OpenCode's copy current; nothing is spent by saving it. Only
        // over the login this request started with: a logout or an API key
        // chosen meanwhile stands.
        const current = await opts.getAuth();
        if (current?.type === "oauth" && current.refresh === stored?.refresh) {
          await opts.save(cli).catch((err) => {
            log("warn", `[opencode-claude-bridge] could not save the Claude Code login: ${firstLine(err)}`);
          });
        }
      }
      return cli;
    }
    if (stored && usable(stored)) return stored;
    throw new CredentialUnavailableError(CLI_LOGIN_EXPIRED);
  }

  // ── The bridge's own login: refreshed here and nowhere else ───────

  async function refreshLocked(): Promise<OAuthTokens> {
    await replayJournalLocked();
    // Re-read under the lock: another process may have refreshed or replaced
    // the login while this one waited.
    const stored = asTokens(await opts.getAuth());
    if (!stored) throw new CredentialUnavailableError("The Claude login was removed from OpenCode; sign in again.");
    if (ownerOf(stored.refresh) !== "bridge") return followCli(stored);
    const basis = latestOf(stored);
    if (usable(basis)) {
      if (basis !== stored && readJournal()?.tokens.refresh !== basis.refresh) await saveUnsaved(stored, basis);
      return basis;
    }
    const refusal = refused.get(basis.refresh);
    if (refusal !== undefined) throw refusedLogin(refusal);

    let fresh: OAuthTokens;
    try {
      fresh = await refreshFn(basis.refresh);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (!isCredentialRejected(detail)) throw err;
      refused.set(basis.refresh, firstLine(err));
      throw refusedLogin(firstLine(err));
    }
    // The old refresh token is spent from here on, so these are the only valid tokens.
    replacedBy.set(basis.refresh, fresh);
    const journal: Journal = { tokens: fresh, replaces: stored.refresh, writtenAt: clock() };
    try {
      writeJournal(journal);
    } catch (err) {
      // Save anyway: skipping the store write would drop the only valid tokens.
      log("warn", `[opencode-claude-bridge] could not journal the refreshed login: ${firstLine(err)}`);
    }
    const recorded = recordRefreshedAsOwned(fresh.refresh);

    // Read-compare-write, not an atomic swap: a change made by something that
    // doesn't take this lock (`opencode auth login` or `logout`) can still land
    // between this check and the save. The check catches the common case.
    // Anything but the login refreshed here stands: another login, a logout,
    // an API key. The new tokens are kept in a .stale file, not written over it.
    const after = asTokens(await opts.getAuth());
    if (after?.refresh !== stored.refresh && after?.refresh !== fresh.refresh) {
      try {
        setAsideTokens(journal, after ? "the stored login was replaced during the refresh" : "the login was removed or switched to an API key during the refresh");
      } catch (err) {
        log("error", `[opencode-claude-bridge] could not set aside the refreshed tokens; they are lost: ${firstLine(err)}`);
      }
      if (!after) {
        throw new CredentialUnavailableError(
          "The Claude login was removed or switched to an API key while it was being refreshed, so the refreshed tokens were not saved over it.",
        );
      }
      if (usable(after)) return after;
      // Not `fresh`: that is the login just replaced. The retry takes the new one as its owner requires.
      throw new CredentialBusyError("The Claude login was replaced while it was being refreshed; retrying with the new login.");
    }

    try {
      await opts.save(fresh);
      if (recorded) clearJournal();
    } catch (err) {
      log("warn", `[opencode-claude-bridge] refreshed tokens could not be saved; kept in the journal and saved on the next request: ${firstLine(err)}`);
    }
    return fresh;
  }

  function writeJournal(journal: Journal): void {
    writeDurably(journalPath(), JSON.stringify(journal));
  }

  /**
   * Tokens refreshed here that reached neither the journal nor storage. Until
   * they do, another process finds only the spent token and sends it again.
   */
  async function saveUnsaved(stored: OAuthTokens, newest: OAuthTokens): Promise<void> {
    try {
      writeJournal({ tokens: newest, replaces: stored.refresh, writtenAt: clock() });
    } catch (err) {
      log("warn", `[opencode-claude-bridge] could not journal the refreshed login: ${firstLine(err)}`);
    }
    const recorded = recordRefreshedAsOwned(newest.refresh);
    if (asTokens(await opts.getAuth())?.refresh !== stored.refresh) return;
    try {
      await opts.save(newest);
      if (recorded) clearJournal();
      log("info", "[opencode-claude-bridge] saved a refreshed login that couldn't be saved when it was issued");
    } catch (err) {
      log("warn", `[opencode-claude-bridge] the refreshed login is still unsaved: ${firstLine(err)}`);
    }
  }

  function refusedLogin(why: string): CredentialUnavailableError {
    return new CredentialUnavailableError(
      `Anthropic refused the refresh of OpenCode's own Claude login (${why}), so it isn't sent again. Sign in again with \`opencode auth login\` (Claude Pro / Max).`,
    );
  }

  async function locked<T>(fn: () => Promise<T>): Promise<T> {
    let entered = false;
    try {
      return await withLock(() => {
        entered = true;
        return fn();
      });
    } catch (err) {
      if (err instanceof LockTimeoutError) {
        throw new CredentialBusyError("Another OpenCode process is refreshing the Claude login; retrying shortly.");
      }
      // Without the lock another process could spend the same refresh token.
      if (!entered) throw new CredentialBusyError(`Could not take the refresh lock (${firstLine(err)}); not refreshing without it.`);
      throw err;
    }
  }

  /** One refresh at a time per process; the lock serialises processes. */
  function sharedRefresh(): Promise<OAuthTokens> {
    if (!flight) {
      flight = locked(refreshLocked).finally(() => { flight = null; });
      // A caller that stopped waiting must not leave a rejection unhandled.
      flight.catch(() => undefined);
    }
    return flight;
  }

  return {
    ownerOf,

    /**
     * Usable tokens for `auth`, the login a request started with. Every
     * refresh trigger — expiry, a 401 (`rejected`), a 429 near expiry — comes
     * through here. `signal` ends the caller's wait, not a refresh in flight.
     */
    async tokens(
      auth: StoredLogin | undefined,
      options: { rejected?: string; signal?: AbortSignal | null } = {},
    ): Promise<OAuthTokens> {
      if (options.rejected) rejectedAccess.add(options.rejected);
      const stored = asTokens(auth);
      // A store still holding a refresh token that was spent here, or that a
      // journal says was replaced, means a save failed: the locked path below
      // saves the newest tokens instead.
      const unsaved = stored !== null && (replacedBy.has(stored.refresh) || readJournal()?.replaces === stored.refresh);
      if (!unsaved && stored && usable(stored)) return stored;
      if (!stored || ownerOf(stored.refresh) !== "bridge") return followCli(stored);

      let fresh = await untilAborted(sharedRefresh(), options.signal);
      // A refresh begun before the 401 may hand back the rejected token.
      if (rejectedAccess.has(fresh.access)) fresh = await untilAborted(sharedRefresh(), options.signal);
      return fresh;
    },

    /**
     * Save a new login with its owner. OpenCode's own is recorded before saving,
     * so it is never taken for a copy; a failed save leaves the stored login's owner as it was.
     */
    async recordLogin(tokens: OAuthTokens, owner: Owner): Promise<void> {
      await locked(async () => {
        if (owner === "claude-cli") {
          await opts.save(tokens);
          try {
            fs.rmSync(ownersPath(), { force: true });
          } catch (err) {
            log("warn", `[opencode-claude-bridge] could not clear the record of OpenCode's own logins: ${firstLine(err)}`);
          }
          return;
        }
        const stored = asTokens(await opts.getAuth());
        recordBridgeOwned(tokens.refresh, stored && ownerOf(stored.refresh) === "bridge" ? stored.refresh : undefined);
        await opts.save(tokens);
      });
    },

    /**
     * Startup: copy the Claude Code login into OpenCode's store, unless the
     * store holds a login the bridge owns. Overwriting that would orphan a
     * chain only the bridge can refresh. Returns whether it saved anything.
     */
    async seedFromCli(stored: StoredLogin | undefined): Promise<boolean> {
      const current = asTokens(stored);
      if (current && ownerOf(current.refresh) === "bridge") return false;
      const cli = readCli();
      if (!cli?.access || cli.expires <= clock() + EXPIRY_BUFFER_MS) return false;
      if (current?.refresh === cli.refresh && current.access === cli.access) return false;
      await opts.save(cli);
      return true;
    },
  };
}

export type SingleAccount = ReturnType<typeof createSingleAccount>;

function firstLine(err: unknown): string {
  return err instanceof Error ? err.message.split("\n")[0]!.slice(0, 200) : String(err);
}
