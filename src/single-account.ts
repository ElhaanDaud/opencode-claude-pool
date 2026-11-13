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
import { refreshTokens } from "./oauth.js";
import type { OAuthTokens } from "./oauth.js";
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

/**
 * The newest tokens this process holds for a chain: a refresh whose save
 * failed is followed by others while the store still holds the first token,
 * and only the last of them is still valid.
 */
function latestOf(tokens: OAuthTokens): OAuthTokens {
  let latest = tokens;
  for (let hops = 0; hops < 64; hops++) {
    const next = replacedBy.get(latest.refresh);
    if (!next) break;
    latest = next;
  }
  return latest;
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
      fs.writeSync(fd, contents);
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
    // Refreshed here, or still the stored start of a chain whose refreshed
    // tokens wait in the journal: the bridge's however many refreshes the
    // failed saves took, which the bounded list below doesn't cover.
    if (replacedBy.has(refresh) || readJournal()?.replaces === refresh) return "bridge";
    return bridgeOwned().includes(fingerprint(refresh)) ? "bridge" : "claude-cli";
  }

  function recordBridgeOwned(refresh: string): void {
    const hash = fingerprint(refresh);
    const owned = [hash, ...bridgeOwned().filter((other) => other !== hash)].slice(0, OWNED_HISTORY);
    writeDurably(ownersPath(), JSON.stringify({ bridge: owned }));
  }

  // ── Journal: refreshed tokens on disk before the store has them ───

  interface Journal { tokens: OAuthTokens; replaces: string; writtenAt: number }

  function readJournal(): Journal | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(journalPath(), "utf8")) as Journal;
      return parsed?.tokens?.refresh && typeof parsed.replaces === "string" ? parsed : null;
    } catch {
      return null;
    }
  }

  function clearJournal(): void {
    try { fs.rmSync(journalPath(), { force: true }); } catch { /* best effort */ }
  }

  /** Rename, never delete: the journal may hold the only live token. Throws if it can't be moved. */
  function setAsideJournal(reason: string): void {
    const aside = `${journalPath()}.${randomUUID()}.stale`;
    fs.renameSync(journalPath(), aside);
    console.error(`[opencode-claude-bridge] set aside the single-account refresh journal (${reason}): ${aside}`);
  }

  /** Caller holds the lock. Commits a journal left by a save that failed or a process that died. */
  async function replayJournalLocked(): Promise<void> {
    const journal = readJournal();
    if (!journal) return;
    const stored = asTokens(await opts.getAuth());
    if (stored?.refresh === journal.tokens.refresh) {
      clearJournal();
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
        console.error(`[opencode-claude-bridge] could not journal the refreshed login: ${firstLine(err)}`);
      }
    }
    try {
      recordBridgeOwned(latest.refresh);
    } catch (err) {
      console.error(`[opencode-claude-bridge] could not record the refreshed login as OpenCode's own: ${firstLine(err)}`);
    }
    try {
      await opts.save(latest);
      clearJournal();
      console.error("[opencode-claude-bridge] saved a refreshed login left in the journal");
    } catch (err) {
      console.error(`[opencode-claude-bridge] the refreshed login is still unsaved, kept in the journal: ${firstLine(err)}`);
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
            console.error(`[opencode-claude-bridge] could not save the Claude Code login: ${firstLine(err)}`);
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
    if (usable(basis)) return basis;

    const fresh = await refreshFn(basis.refresh);
    // The old refresh token is spent from here on, so these are the only valid tokens.
    replacedBy.set(basis.refresh, fresh);
    try {
      writeJournal({ tokens: fresh, replaces: stored.refresh, writtenAt: clock() });
    } catch (err) {
      // Save anyway: skipping the store write would drop the only valid tokens.
      console.error(`[opencode-claude-bridge] could not journal the refreshed login: ${firstLine(err)}`);
    }
    try {
      recordBridgeOwned(fresh.refresh);
    } catch (err) {
      console.error(`[opencode-claude-bridge] could not record the refreshed login as OpenCode's own: ${firstLine(err)}`);
    }

    // Read-compare-write, not an atomic swap: a change made by something that
    // doesn't take this lock (`opencode auth login` or `logout`) can still land
    // between this check and the save. The check catches the common case.
    // Anything but the login refreshed here stands: another login, a logout,
    // an API key. The new tokens are kept in a .stale file, not written over it.
    const after = asTokens(await opts.getAuth());
    if (after?.refresh !== stored.refresh && after?.refresh !== fresh.refresh) {
      try {
        setAsideJournal(after ? "the stored login was replaced during the refresh" : "the login was removed or switched to an API key during the refresh");
      } catch (err) {
        console.error(`[opencode-claude-bridge] could not set aside the refresh journal: ${firstLine(err)}`);
      }
      if (!after) {
        throw new CredentialUnavailableError(
          "The Claude login was removed or switched to an API key while it was being refreshed, so the refreshed tokens were not saved over it.",
        );
      }
      return usable(after) ? after : fresh;
    }

    try {
      await opts.save(fresh);
      clearJournal();
    } catch (err) {
      console.error(`[opencode-claude-bridge] refreshed tokens could not be saved; kept in the journal and saved on the next request: ${firstLine(err)}`);
    }
    return fresh;
  }

  function writeJournal(journal: Journal): void {
    writeDurably(journalPath(), JSON.stringify(journal));
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

    /** Save a new login with its owner. Recorded before saving, so it is never taken for a copy. */
    async recordLogin(tokens: OAuthTokens, owner: Owner): Promise<void> {
      await locked(async () => {
        if (owner === "bridge") recordBridgeOwned(tokens.refresh);
        else fs.rmSync(ownersPath(), { force: true });
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
