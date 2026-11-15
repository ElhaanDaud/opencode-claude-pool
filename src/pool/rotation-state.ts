/**
 * Hot, mutable rotation state: which account is active, plus per-account
 * cooldown / disabled / failure bookkeeping. Contains NO secret material —
 * credentials live in the separate keychain-backed store.
 *
 * Two properties here are load-bearing:
 *
 *  1. ATOMIC WRITES. State is written to a temp file in the same directory,
 *     fsync'd, then renamed over the target. A crash mid-write leaves the
 *     previous state fully intact rather than a truncated file.
 *
 *  2. A CROSS-PROCESS LOCK. Multiple opencode processes — and many agents
 *     within one process — share this file. Beyond protecting state, this same
 *     lock guards the token-refresh critical section in the manager:
 *     Anthropic's OAuth refresh rotates the refresh token and invalidates the
 *     old one, so two concurrent refreshes of one account can permanently
 *     brick it. This lock is what makes that impossible.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

import { log } from "../notices.js";
import { ROTATION_STATE_VERSION } from "./types.js";
import type { AccountState, Clock, RotationState } from "./types.js";

/** Another process held the lock too long; says nothing about any account's health. */
export class LockTimeoutError extends Error {}

export interface RotationStateStoreOptions {
  /** Defaults to `<path>.lock`. */
  lockPath?: string;
  path: string;
  clock?: Clock;
  /** Age after which a lockfile is presumed abandoned by a crashed process. */
  staleLockMs?: number;
  /** Poll interval while waiting on a contended lock. */
  lockPollMs?: number;
  /** Give up acquiring the lock after this long. */
  lockTimeoutMs?: number;
}

interface LockPayload {
  pid: number;
  hostname: string;
  acquiredAt: number;
  /** Distinguishes our lock from a replacement, for safe reclaim and release. */
  nonce: string;
  /** The holder's start time as `ps` reports it: tells the holder from a later process given its pid. */
  startedAt?: string;
}

/** As `ps` reports it, or null where it can't. The kernel's record, so a clock change can't alter it. */
function processStart(pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

let ownStart: string | null | undefined;
function ownStartTime(): string | null {
  if (ownStart === undefined) ownStart = processStart(process.pid);
  return ownStart;
}

export function defaultRotationState(): RotationState {
  return { version: ROTATION_STATE_VERSION, activeLabel: null, accounts: {} };
}

// The lock also serialises token refreshes, so it stays with the credentials
// and ignores CLAUDE_POOL_STATE_PATH: processes sharing accounts must share it.
export function defaultLockPath(): string {
  return path.join(os.homedir(), ".local", "share", "opencode-claude-bridge", "rotation-state.json.lock");
}

export function defaultStatePath(): string {
  if (process.env.CLAUDE_POOL_STATE_PATH) return process.env.CLAUDE_POOL_STATE_PATH;
  return path.join(
    os.homedir(),
    ".local",
    "share",
    "opencode-claude-bridge",
    "rotation-state.json",
  );
}

function defaultAccountState(now: number): AccountState {
  return {
    cooldownUntil: null,
    disabled: false,
    failureCount: 0,
    lastReason: null,
    updatedAt: now,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createRotationStateStore(opts: RotationStateStoreOptions) {
  const statePath = opts.path;
  const lockPath = opts.lockPath ?? `${statePath}.lock`;
  const clock: Clock = opts.clock ?? (() => Date.now());
  // Must comfortably exceed the worst-case guarded operation. A token refresh
  // runs up to 3 curl attempts at 30s each plus backoff (~100s), so a 30s
  // threshold would declare a healthy, actively-refreshing holder "stale".
  const staleLockMs = opts.staleLockMs ?? 180_000;
  const lockPollMs = opts.lockPollMs ?? 50;
  const lockTimeoutMs = opts.lockTimeoutMs ?? 10_000;

  /**
   * Create the parent directory if absent. We only chmod when we actually
   * created it: an unconditional chmod would silently repair permissions an
   * operator deliberately set, masking a real failure.
   */
  function ensureDir(): void {
    for (const dir of new Set([path.dirname(statePath), path.dirname(lockPath)])) {
      const created = fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (created) fs.chmodSync(dir, 0o700);
    }
  }

  /** Returns null for a file that exists but is unusable (malformed or unknown version). */
  function read(): RotationState | null {
    let raw: string;
    try {
      raw = fs.readFileSync(statePath, "utf8");
    } catch (err) {
      // Only a missing file means a fresh pool. Any other read error (EACCES,
      // EIO, EMFILE) leaves the real state on disk, and defaults saved over it
      // would drop every cooldown and put disabled accounts back in rotation.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return defaultRotationState();
      throw err;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      log("warn",
        `[claude-pool] rotation state at ${statePath} is malformed JSON; falling back to defaults`,
      );
      return null;
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as RotationState).version !== ROTATION_STATE_VERSION
    ) {
      log("warn",
        `[claude-pool] rotation state at ${statePath} has an unsupported version; falling back to defaults`,
      );
      return null;
    }

    const state = parsed as RotationState;
    return {
      version: state.version,
      activeLabel: state.activeLabel ?? null,
      accounts: state.accounts ?? {},
    };
  }

  function load(): RotationState {
    return read() ?? defaultRotationState();
  }

  /**
   * Load for a write. An unusable file is moved aside first so the save that
   * follows cannot destroy it. Only done under the lock: a reader renaming it
   * unlocked could move aside a fresh state another process just saved.
   */
  function loadLocked(): RotationState {
    const state = read();
    if (state) return state;
    const aside = `${statePath}.corrupt-${clock()}`;
    fs.renameSync(statePath, aside);
    log("warn", `[claude-pool] moved unusable rotation state to ${aside}; starting fresh`);
    return defaultRotationState();
  }

  function save(state: RotationState): void {
    ensureDir();
    const tmp = `${statePath}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = fs.openSync(tmp, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify(state, null, 2));
      // fsync before rename: rename atomically swaps the directory entry, but
      // without fsync the contents may not have reached disk yet.
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(tmp, statePath);
      fs.chmodSync(statePath, 0o600);
    } catch (err) {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* already closed */ }
      }
      // The failed-write path is exactly where stray temp files would
      // accumulate unnoticed, so clean up before rethrowing.
      try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to remove */ }
      throw err;
    }
  }

  /** The lockfile's exact bytes, or null if it is missing or unreadable. */
  function readLockBytes(): Buffer | null {
    try {
      return fs.readFileSync(lockPath);
    } catch {
      return null;
    }
  }

  function parseLock(raw: Buffer | null): LockPayload | null {
    if (!raw) return null;
    try {
      return JSON.parse(raw.toString("utf8")) as LockPayload;
    } catch {
      return null;
    }
  }

  function readLock(): LockPayload | null {
    return parseLock(readLockBytes());
  }

  /** Keyed on bytes, not the nonce, so locks written without one still work. */
  function reclaimPath(observed: Buffer): string {
    return `${lockPath}.reclaim-${createHash("sha256").update(observed).digest("hex").slice(0, 16)}`;
  }

  /** Atomically create the lockfile. Returns our nonce, or null if held. */
  function tryCreateLock(): string | null {
    const nonce = randomUUID();
    const startedAt = ownStartTime();
    const payload: LockPayload = {
      pid: process.pid,
      hostname: os.hostname(),
      acquiredAt: clock(),
      nonce,
      ...(startedAt ? { startedAt } : {}),
    };
    let fd: number;
    try {
      // "wx" fails if the file exists — atomic on POSIX, no dependency needed.
      fd = fs.openSync(lockPath, "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw err;
    }
    try {
      fs.writeFileSync(fd, JSON.stringify(payload));
      fs.fsyncSync(fd);
    } catch (err) {
      try { fs.rmSync(lockPath, { force: true }); } catch { /* best effort */ }
      throw err;
    } finally {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
    return nonce;
  }

  /**
   * Reclaim a lock abandoned by a crashed process.
   *
   * The naive approach — "if it looks stale, unlink it" — has a real race: two
   * waiters both see the stale lock, the first reclaims and acquires, then the
   * second deletes that *fresh* lock, leaving two holders. Moving it aside and
   * restoring it on a mismatch is no better: the restore can land on a third
   * waiter's new lock. POSIX has no atomic compare-and-unlink, so instead a
   * reclaimer first creates a claim file keyed on the exact bytes it observed,
   * and only the claim holder may unlink, and only while the lockfile still
   * holds those bytes. A replacement, even one created but not yet written,
   * differs and is left alone.
   *
   * This fails closed. A reclaimer that dies holding the claim leaves the stale
   * lock in place, and acquire() times out naming the claim until someone
   * deletes it. Recovering from that automatically reopens the two-holder race.
   */
  /**
   * Age alone is not a crash signal — it is a timeout, and the guarded refresh
   * can legitimately outlast it. Reclaiming a live holder lets two processes
   * refresh one account concurrently, which rotates its refresh token twice and
   * permanently bricks it. So on this host we require proof the process is
   * actually gone. A lock from another host is unverifiable, so it falls back
   * to the age heuristic.
   */
  function holderIsGone(payload: LockPayload): boolean {
    if (payload.hostname !== os.hostname()) return true;
    try {
      process.kill(payload.pid, 0);
    } catch (error) {
      // EPERM: the process exists but belongs to another user (e.g. a service account).
      if ((error as NodeJS.ErrnoException).code !== "EPERM") return true;
    }
    // Something runs under that pid, but pids are reused, after a reboot most of
    // all: a process that started at another time is not the holder.
    if (typeof payload.startedAt !== "string") return false;
    const current = processStart(payload.pid);
    return current !== null && current !== payload.startedAt;
  }

  function tryReclaimStale(observed: Buffer, identity?: fs.Stats): boolean {
    const claim = reclaimPath(observed);
    try {
      fs.closeSync(fs.openSync(claim, "wx", 0o600));
    } catch (err) {
      // Anything but another waiter reclaiming it (EEXIST) is a real fault, not contention.
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
    try {
      // Any mismatch means it was already reclaimed and replaced.
      if (!fs.readFileSync(lockPath).equals(observed)) return false;
      if (identity) {
        const current = fs.statSync(lockPath);
        if (current.dev !== identity.dev || current.ino !== identity.ino || clock() - current.mtimeMs <= staleLockMs) return false;
      }
      fs.rmSync(lockPath);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false; // Already reclaimed.
      throw err;
    } finally {
      try { fs.rmSync(claim, { force: true }); } catch { /* best effort */ }
    }
  }

  async function acquire(): Promise<string> {
    ensureDir();
    const deadline = clock() + lockTimeoutMs;

    for (;;) {
      const nonce = tryCreateLock();
      if (nonce) return nonce;

      const raw = readLockBytes();
      const existing = parseLock(raw);

      // An unparseable lockfile is usually a torn write, which must not wedge
      // the pool forever. But it is also what a lock looks like in the instant
      // between being created and being written, so removing it on sight would
      // evict a holder that is mid-acquisition. Only discard it once it is old
      // enough that no in-progress acquisition could still be responsible.
      if (!raw || !existing) {
        try {
          const identity = fs.statSync(lockPath);
          if (raw && clock() - identity.mtimeMs > staleLockMs) tryReclaimStale(raw, identity);
        } catch (err) {
          // The lock may have disappeared; the deadline still applies.
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      } else if (clock() - existing.acquiredAt > staleLockMs && holderIsGone(existing)) {
        if (tryReclaimStale(raw)) {
          const reclaimed = tryCreateLock();
          if (reclaimed) return reclaimed;
        }
      }

      // Short of the lockfile vanishing under us, every path lands here, so
      // neither a torn lockfile nor a failing reclaim outlasts the deadline.
      if (clock() >= deadline) {
        const holder = existing ? `held by pid ${existing.pid} on ${existing.hostname}` : "lockfile unreadable";
        const claim = raw ? reclaimPath(raw) : null;
        const stuck = claim && fs.existsSync(claim)
          ? `; a reclaim of this stale lock was interrupted, so delete ${claim} if no process is still reclaiming it`
          : "";
        throw new LockTimeoutError(
          `[claude-pool] timed out after ${lockTimeoutMs}ms waiting for the rotation lock at ${lockPath} ` +
            `(${holder})${stuck}`,
        );
      }

      await sleep(lockPollMs);
    }
  }

  function release(nonce: string): void {
    // Only release a lock that provably still holds our nonce. If ours was
    // reclaimed from under us, deleting it would evict whoever holds it now,
    // and that includes a replacement still being written: it reads as
    // unparseable, not as someone else's.
    if (readLock()?.nonce !== nonce) return;
    try { fs.rmSync(lockPath, { force: true }); } catch { /* best effort */ }
  }

  /**
   * Run `fn` inside the cross-process lock. State is loaded INSIDE the lock and
   * handed to `fn`; whatever `fn` mutates is persisted once `fn` resolves.
   * If `fn` throws, nothing is persisted but the lock is still released.
   */
  async function withLock<T>(
    fn: (state: RotationState) => T | Promise<T>,
  ): Promise<T> {
    const nonce = await acquire();
    try {
      const state = loadLocked();
      // Persist only on real change. Several callers (notably token refresh)
      // take the lock for its mutual exclusion and never touch the state, and
      // rewriting the file for them burns an fsync on every request.
      const before = JSON.stringify(state);
      const result = await fn(state);
      if (JSON.stringify(state) !== before) save(state);
      return result;
    } finally {
      release(nonce);
    }
  }

  async function mutateAccount(
    label: string,
    mutate: (account: AccountState, now: number) => void,
  ): Promise<void> {
    await withLock((state) => {
      const now = clock();
      if (!Object.hasOwn(state.accounts, label)) Object.defineProperty(state.accounts, label, { value: defaultAccountState(now), writable: true, enumerable: true, configurable: true });
      mutate(state.accounts[label]!, now);
    });
  }

  return {
    load,
    save,
    withLock,

    async setActive(label: string | null): Promise<void> {
      await withLock((state) => {
        state.activeLabel = label;
      });
    },

    async ensureAccount(label: string): Promise<void> {
      // Fast path: this runs for every account on every acquire(), and taking
      // the cross-process lock to discover "already present" cost ~10ms each.
      // Re-checked under the lock below, so the race is benign.
      if (Object.hasOwn(load().accounts, label)) return;
      await withLock((state) => {
        if (!Object.hasOwn(state.accounts, label)) {
          Object.defineProperty(state.accounts, label, { value: defaultAccountState(clock()), writable: true, enumerable: true, configurable: true });
        }
      });
    },

    async markCooldown(
      label: string,
      until: number,
      reason: string,
      windows?: {
        fiveHourReset?: number | null;
        sevenDayReset?: number | null;
        binding?: "five_hour" | "seven_day" | null;
      },
    ): Promise<void> {
      await mutateAccount(label, (account, now) => {
        // Only ever extended: a request already in flight can report a shorter
        // wait (a plain retry-after) for an account whose window is spent for hours.
        if (account.cooldownUntil === null || until > account.cooldownUntil) {
          account.cooldownUntil = until;
          account.lastReason = reason;
        }
        account.failureCount += 1;
        account.updatedAt = now;
        // Only overwrite a window we actually observed; a 429 that disclosed
        // one window must not erase what we already know about the other.
        if (windows?.fiveHourReset != null) account.fiveHourReset = windows.fiveHourReset;
        if (windows?.sevenDayReset != null) account.sevenDayReset = windows.sevenDayReset;
        if (windows?.binding !== undefined) account.bindingWindow = windows.binding;
      });
    },

    async markDisabled(label: string, reason: string): Promise<void> {
      await mutateAccount(label, (account, now) => {
        account.disabled = true;
        account.lastReason = reason;
        account.updatedAt = now;
      });
    },

    async resetHealth(label: string): Promise<void> {
      await mutateAccount(label, (account, now) => {
        account.disabled = false;
        account.cooldownUntil = null;
        account.failureCount = 0;
        account.lastReason = null;
        account.updatedAt = now;
        // Observed quota windows are left intact: clearing local health does
        // not give the account its server-side quota back.
      });
    },

    async forget(label: string): Promise<void> {
      await withLock((state) => {
        delete state.accounts[label];
        if (state.activeLabel === label) state.activeLabel = null;
      });
    },

    /** `sentAt`: when the successful request went out. */
    async markSuccess(label: string, sentAt: number): Promise<void> {
      await mutateAccount(label, (account, now) => {
        // Anything recorded since the request went out (e.g. a concurrent
        // request's 429) is newer news than this success, so it stands.
        if (account.updatedAt >= sentAt) return;
        account.cooldownUntil = null;
        account.failureCount = 0;
        account.updatedAt = now;
      });
    },
  };
}

export type RotationStateStore = ReturnType<typeof createRotationStateStore>;
