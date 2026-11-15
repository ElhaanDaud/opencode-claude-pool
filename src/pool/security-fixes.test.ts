/**
 * Regression tests for issues found in the credential-pool security audit.
 * Each case pins a failure mode that is silent and expensive if it returns.
 */

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";

import { classify, MAX_TRANSIENT_ATTEMPTS } from "./classifier.js";
import { isCredentialRejected } from "./manager.js";
import { createRotationStateStore } from "./rotation-state.js";

const NOW = 1_000_000;

function tempPath(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pool-sec-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "rotation-state.json");
}

describe("audit M1: bounded short-reset retries", () => {
  it("retries the same account while under the attempt cap", () => {
    const decision = classify({
      status: 429,
      headers: { "retry-after": "30" },
      now: NOW,
      attempt: 0,
    });
    assert.equal(decision.action, "RETRY_SAME");
  });

  it("escalates to rotation once short-reset retries are exhausted", () => {
    const decision = classify({
      status: 429,
      headers: { "retry-after": "30" },
      now: NOW,
      attempt: MAX_TRANSIENT_ATTEMPTS,
    });

    // Without the cap this returns RETRY_SAME forever and the request hangs.
    assert.equal(decision.action, "ROTATE_COOLDOWN");
    assert.equal(decision.until, NOW + 30_000);
  });
});

describe("audit H2: refresh failure classification", () => {
  it("treats a rejected credential as permanent", () => {
    assert.equal(isCredentialRejected("Token refresh failed (400): invalid_grant"), true);
    assert.equal(isCredentialRejected("Token refresh failed (401): unauthorized_client"), true);
    assert.equal(isCredentialRejected("invalid_client"), true);
  });

  it("treats an unreachable or failing endpoint as transient", () => {
    assert.equal(isCredentialRejected("Token refresh failed (500): server error"), false);
    assert.equal(isCredentialRejected("Token refresh failed (429): Rate limited"), false);
    assert.equal(isCredentialRejected("connect ETIMEDOUT 1.2.3.4:443"), false);
    assert.equal(isCredentialRejected("spawn curl ENOENT"), false);
  });

  it("does not treat a status outside our own prefix as a credential rejection", () => {
    // A gateway body or a network error can contain "(403)"/"(401)". Treating
    // those as rejections permanently disabled healthy accounts, and undoing a
    // disable needs manual operator action.
    assert.equal(
      isCredentialRejected("Token refresh failed (502): <html>Error (403) Forbidden</html>"),
      false,
    );
    assert.equal(
      isCredentialRejected("Token refresh failed: ETIMEDOUT after (401) retries logged"),
      false,
    );
    assert.equal(isCredentialRejected("Token refresh failed (503): upstream busy"), false);
  });

  it("still catches genuine credential rejections", () => {
    assert.equal(isCredentialRejected("Token refresh failed (400): invalid_grant"), true);
    assert.equal(isCredentialRejected("Token refresh failed (401): token revoked"), true);
    assert.equal(isCredentialRejected("provider said invalid_grant"), true);
  });
});

describe("re-enrollment restores a disabled account", () => {
  it("clears disabled, cooldown and failure count when fresh credentials arrive", async (t) => {
    const store = createRotationStateStore({ path: tempPath(t), clock: () => NOW });
    await store.markDisabled("alice", "refresh rejected: invalid_grant");
    await store.markCooldown("alice", NOW + 3_600_000, "exhausted");

    await store.resetHealth("alice");

    const account = store.load().accounts.alice;
    // Enrolling new credentials that leave the account disabled would make
    // rotation skip it forever while the CLI reports enrollment succeeded.
    assert.equal(account?.disabled, false);
    assert.equal(account?.cooldownUntil, null);
    assert.equal(account?.failureCount, 0);
  });

  it("creates a healthy account when one does not exist yet", async (t) => {
    const store = createRotationStateStore({ path: tempPath(t), clock: () => NOW });

    await store.resetHealth("bob");

    assert.equal(store.load().accounts.bob?.disabled, false);
  });
});

describe("audit H1: stale lock reclaim requires a dead holder", () => {
  it("does not reclaim an aged lock whose holder is still alive", async (t) => {
    const statePath = tempPath(t);
    fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
    // Our own pid: unambiguously alive. Aged far past the stale threshold, as
    // a slow-but-healthy token refresh legitimately would be.
    fs.writeFileSync(
      `${statePath}.lock`,
      JSON.stringify({
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAt: 0,
        nonce: "live-holder",
      }),
      { mode: 0o600 },
    );

    // Clock must advance or the acquire loop can never reach its deadline.
    let now = 10_000_000;
    const store = createRotationStateStore({
      path: statePath,
      clock: () => (now += 5),
      staleLockMs: 1_000,
      lockPollMs: 1,
      lockTimeoutMs: 40,
    });

    // Reclaiming here would let a second process refresh the same account
    // concurrently, rotating its refresh token twice and bricking it.
    await assert.rejects(store.withLock(() => undefined), /timed out/);

    const held = JSON.parse(fs.readFileSync(`${statePath}.lock`, "utf8"));
    assert.equal(held.nonce, "live-holder");
  });

  /** A live process that is not the lock's holder, as a reused pid would be. */
  function otherProcess(t: TestContext): { pid: number; startedAt: string } {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], { stdio: "ignore" });
    t.after(() => child.kill());
    const startedAt = execFileSync("ps", ["-o", "lstart=", "-p", String(child.pid)], { encoding: "utf8" }).trim();
    return { pid: child.pid!, startedAt };
  }

  function writeLock(statePath: string, payload: Record<string, unknown>): void {
    fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${statePath}.lock`, JSON.stringify({ hostname: os.hostname(), acquiredAt: 0, ...payload }), { mode: 0o600 });
  }

  it("reclaims an aged lock whose pid now belongs to a process that started at another time", async (t) => {
    const statePath = tempPath(t);
    writeLock(statePath, { pid: otherProcess(t).pid, nonce: "reused-pid", startedAt: "Thu Jan  1 00:00:00 1970" });
    let now = 10_000_000;
    const store = createRotationStateStore({ path: statePath, clock: () => (now += 5), staleLockMs: 1_000, lockPollMs: 1, lockTimeoutMs: 40 });

    let entered = false;
    await store.withLock(() => { entered = true; });

    assert.equal(entered, true);
  });

  it("does not reclaim an aged lock whose holder still runs with the start time it recorded", async (t) => {
    const statePath = tempPath(t);
    const holder = otherProcess(t);
    writeLock(statePath, { pid: holder.pid, nonce: "live-holder", startedAt: holder.startedAt });
    let now = 10_000_000;
    const store = createRotationStateStore({ path: statePath, clock: () => (now += 5), staleLockMs: 1_000, lockPollMs: 1, lockTimeoutMs: 40 });

    await assert.rejects(store.withLock(() => undefined), /timed out/);
    assert.equal(JSON.parse(fs.readFileSync(`${statePath}.lock`, "utf8")).nonce, "live-holder");
  });

  it("reports why a stale lock can't be reclaimed instead of waiting it out as contention", { skip: process.getuid?.() === 0 ? "chmod does not stop root from writing" : false }, async (t) => {
    const statePath = tempPath(t);
    writeLock(statePath, { pid: 2, hostname: "some-other-host", acquiredAt: 1_000, nonce: "dead-holder" });
    const dir = path.dirname(statePath);
    let now = 10_000_000;
    const store = createRotationStateStore({ path: statePath, clock: () => (now += 5), staleLockMs: 1_000, lockPollMs: 1, lockTimeoutMs: 40 });

    fs.chmodSync(dir, 0o500);
    try {
      await assert.rejects(store.withLock(() => undefined), (err: unknown) => (err as NodeJS.ErrnoException).code === "EACCES");
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });

  it("still reclaims an aged lock from a process that is gone", async (t) => {
    const statePath = tempPath(t);
    fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      `${statePath}.lock`,
      JSON.stringify({
        pid: 2, // pid 2 is not a live node process we can signal
        hostname: "some-other-host",
        acquiredAt: 1_000,
        nonce: "dead-holder",
      }),
      { mode: 0o600 },
    );

    const store = createRotationStateStore({
      path: statePath,
      clock: () => 10_000_000,
      staleLockMs: 1_000,
      lockPollMs: 1,
    });

    let entered = false;
    await store.withLock(() => {
      entered = true;
    });

    assert.equal(entered, true);
    assert.equal(fs.existsSync(`${statePath}.lock`), false);
  });
});

describe("the login goes only to trusted origins, and never through a redirect", () => {
  const record = () => {
    const calls: Array<{ url: string; redirect?: RequestRedirect }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), redirect: init?.redirect });
      return Response.json({ account: { email_address: "person@example.com" } });
    }) as typeof fetch;
    return { calls, fetchImpl };
  };

  it("doesn't look up the email at a profile URL that isn't trusted", async (t) => {
    t.mock.method(console, "error", () => {});
    process.env.ANTHROPIC_PROFILE_URL = "https://profile.example/api/oauth/profile";
    t.after(() => { delete process.env.ANTHROPIC_PROFILE_URL; });
    const { lookupEmail } = await import("./enroll.js");
    const { calls, fetchImpl } = record();
    t.mock.method(globalThis, "fetch", fetchImpl);
    assert.equal(await lookupEmail("token"), undefined);
    assert.deepEqual(calls, []);
  });

  it("doesn't ask an untrusted origin for usage, and asks a trusted one without following redirects", async (t) => {
    t.mock.method(console, "error", () => {});
    const { fetchUsage } = await import("./usage.js");
    const { calls, fetchImpl } = record();
    await assert.rejects(fetchUsage("token", { url: "https://usage.example/api/oauth/usage", fetchImpl }), /not sent/);
    assert.deepEqual(calls, []);
    await fetchUsage("token", { url: "https://api.anthropic.com/api/oauth/usage", fetchImpl });
    assert.deepEqual(calls, [{ url: "https://api.anthropic.com/api/oauth/usage", redirect: "manual" }]);
  });
});
