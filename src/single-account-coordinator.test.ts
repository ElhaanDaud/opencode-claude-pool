import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";

import { CredentialBusyError, CredentialUnavailableError, createSingleAccount } from "./single-account.js";
import type { StoredLogin } from "./single-account.js";
import type { OAuthTokens } from "./oauth.js";

const HOUR = 3_600_000;

function setup(t: TestContext, stored: StoredLogin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "single-account-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = { auth: stored as StoredLogin | undefined };
  const own = (refresh: string) => fs.writeFileSync(
    path.join(dir, "single-account-owner.json"),
    JSON.stringify({ bridge: [createHash("sha256").update(refresh).digest("hex")] }),
  );
  return { dir, store, own, journal: path.join(dir, "single-account-journal.json") };
}

describe("single-account coordinator", () => {
  it("fails closed when the refresh lock can't be taken, without refreshing", async (t) => {
    const { dir, store, own } = setup(t, { type: "oauth", access: "a", refresh: "lock-r", expires: 0 });
    own("lock-r");
    let refreshes = 0;
    const account = createSingleAccount({
      getAuth: async () => store.auth,
      save: async () => {},
      readCli: () => null,
      refresh: async () => { refreshes += 1; return { access: "x", refresh: "y", expires: Date.now() + HOUR }; },
      withLock: async () => { throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }); },
      dir,
    });
    await assert.rejects(account.tokens(store.auth), (err: unknown) => err instanceof CredentialBusyError && /EACCES/.test(String(err)));
    assert.equal(refreshes, 0);
  });

  it("keeps a login saved by someone else during the refresh, and sets its own result aside", async (t) => {
    const { dir, store, own, journal } = setup(t, { type: "oauth", access: "a", refresh: "ext-r", expires: 0 });
    own("ext-r");
    const relogin: OAuthTokens = { access: "relogin", refresh: "relogin-r", expires: Date.now() + HOUR };
    const account = createSingleAccount({
      getAuth: async () => store.auth,
      save: async (tokens) => { store.auth = { type: "oauth", ...tokens }; },
      readCli: () => null,
      refresh: async () => {
        // `opencode auth login` in another process, which doesn't take the lock.
        store.auth = { type: "oauth", ...relogin };
        return { access: "fresh", refresh: "fresh-r", expires: Date.now() + HOUR };
      },
      withLock: (fn) => fn(),
      dir,
    });
    const tokens = await account.tokens(store.auth);
    assert.equal(tokens.access, "relogin");
    assert.equal(store.auth?.refresh, "relogin-r");
    const aside = fs.readdirSync(dir).filter((name) => name.endsWith(".stale"));
    assert.equal(aside.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, aside[0]!), "utf8")).tokens.refresh, "fresh-r");
    assert.equal(fs.existsSync(journal), false);
  });

  it("saves tokens a crashed process journaled, without refreshing again", async (t) => {
    const { dir, store, own, journal } = setup(t, { type: "oauth", access: "a", refresh: "crash-r", expires: 0 });
    own("crash-r");
    const pending: OAuthTokens = { access: "journaled", refresh: "journaled-r", expires: Date.now() + HOUR };
    fs.writeFileSync(journal, JSON.stringify({ tokens: pending, replaces: "crash-r", writtenAt: Date.now() }));
    let refreshes = 0;
    const account = createSingleAccount({
      getAuth: async () => store.auth,
      save: async (tokens) => { store.auth = { type: "oauth", ...tokens }; },
      readCli: () => null,
      refresh: async () => { refreshes += 1; throw new Error("unused"); },
      withLock: (fn) => fn(),
      dir,
    });
    assert.equal((await account.tokens(store.auth)).access, "journaled");
    assert.equal(refreshes, 0);
    assert.equal(store.auth?.refresh, "journaled-r");
    assert.equal(account.ownerOf("journaled-r"), "bridge");
    assert.equal(fs.existsSync(journal), false);
  });

  /** A token endpoint where each refresh token works once, as in production. */
  function tokenEndpoint(...live: string[]) {
    const valid = new Set(live);
    const exchanges: string[] = [];
    const refresh = async (token: string): Promise<OAuthTokens> => {
      exchanges.push(token);
      if (!valid.delete(token)) throw new Error("Token refresh failed (400): invalid_grant");
      valid.add(`${token}+`);
      return { access: `${token}+/access`, refresh: `${token}+`, expires: Date.now() + HOUR };
    };
    return { refresh, exchanges };
  }
  const direct = <T>(fn: () => Promise<T>) => fn();
  const asideIn = (dir: string) => fs.readdirSync(dir).filter((name) => name.endsWith(".stale"))
    .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")).tokens.refresh as string);

  for (const [what, replacement] of [
    ["switched to an API key", { type: "api", key: "sk-ant-user-key" }],
    ["logged out", undefined],
  ] as const) {
    it(`never writes a refresh over a login ${what} meanwhile, and keeps its tokens aside`, async (t) => {
      // Refresh tokens are never reused, and the coordinator's chain is process-wide.
      const token = `gone-${what.replace(/\W+/g, "-")}`;
      const { dir, store, own } = setup(t, { type: "oauth", access: "a", refresh: token, expires: 0 });
      own(token);
      const endpoint = tokenEndpoint(token);
      const account = createSingleAccount({
        getAuth: async () => store.auth,
        save: async (tokens) => { store.auth = { type: "oauth", ...tokens }; },
        readCli: () => null,
        refresh: async (token) => {
          store.auth = replacement;
          return endpoint.refresh(token);
        },
        withLock: direct,
        dir,
      });
      await assert.rejects(account.tokens({ type: "oauth", access: "a", refresh: token, expires: 0 }), CredentialUnavailableError);
      assert.deepEqual(store.auth, replacement);
      assert.deepEqual(asideIn(dir), [`${token}+`]);
    });
  }

  it("does not save Claude Code's login over an API key chosen meanwhile", async (t) => {
    const started = { type: "oauth", access: "cli-old", refresh: "cli-old-r", expires: 0 };
    const { dir, store } = setup(t, { type: "api", key: "sk-ant-user-key" } as StoredLogin);
    const account = createSingleAccount({
      getAuth: async () => store.auth,
      save: async (tokens) => { store.auth = { type: "oauth", ...tokens }; },
      readCli: () => ({ access: "cli-new", refresh: "cli-new-r", expires: Date.now() + HOUR }),
      refresh: async () => { throw new Error("unused"); },
      withLock: direct,
      dir,
    });
    assert.equal((await account.tokens(started)).access, "cli-new");
    assert.equal(store.auth?.type, "api");
  });

  /** Refreshes `count` times while every save fails; returns the last tokens. */
  async function refreshWhileStorageIsDown(account: ReturnType<typeof createSingleAccount>, store: { auth: StoredLogin | undefined }, count: number) {
    let latest = await account.tokens(store.auth);
    for (let i = 1; i < count; i++) latest = await account.tokens(store.auth, { rejected: latest.access });
    return latest;
  }

  it("keeps a login its own across two unsaved refreshes, and saves the newest once storage is back", async (t) => {
    const { dir, store, own, journal } = setup(t, { type: "oauth", access: "u0/access", refresh: "u0", expires: 0 });
    own("u0");
    const endpoint = tokenEndpoint("u0");
    let storageUp = false;
    const options = {
      getAuth: async () => store.auth,
      save: async (tokens: OAuthTokens) => {
        if (!storageUp) throw new Error("storage unavailable");
        store.auth = { type: "oauth", ...tokens };
      },
      refresh: endpoint.refresh,
      withLock: direct,
      dir,
    };
    await refreshWhileStorageIsDown(createSingleAccount({ ...options, readCli: () => null }), store, 2);
    assert.deepEqual(endpoint.exchanges, ["u0", "u0+"]);
    storageUp = true;

    // A restart, with Claude Code logged into some other account on this machine.
    const restarted = await import(new URL("./single-account.js?restart-unsaved", import.meta.url).href) as typeof import("./single-account.js");
    const account = restarted.createSingleAccount({
      ...options,
      readCli: () => ({ access: "someone-else", refresh: "someone-else-r", expires: Date.now() + HOUR }),
    });
    assert.equal(account.ownerOf("u0"), "bridge");
    assert.equal((await account.tokens(store.auth)).refresh, "u0++");
    assert.equal(store.auth?.refresh, "u0++");
    assert.equal(fs.existsSync(journal), false);
    assert.deepEqual(endpoint.exchanges, ["u0", "u0+"]);
  });

  it("saves the newest unsaved tokens in the same process once storage is back", async (t) => {
    const { dir, store, own } = setup(t, { type: "oauth", access: "v0/access", refresh: "v0", expires: 0 });
    own("v0");
    const endpoint = tokenEndpoint("v0");
    let storageUp = false;
    const account = createSingleAccount({
      getAuth: async () => store.auth,
      save: async (tokens) => {
        if (!storageUp) throw new Error("storage unavailable");
        store.auth = { type: "oauth", ...tokens };
      },
      readCli: () => ({ access: "someone-else", refresh: "someone-else-r", expires: Date.now() + HOUR }),
      refresh: endpoint.refresh,
      withLock: direct,
      dir,
    });
    await refreshWhileStorageIsDown(account, store, 2);
    storageUp = true;
    assert.equal((await account.tokens(store.auth)).refresh, "v0++");
    assert.equal(store.auth?.refresh, "v0++");
  });

  it("never resends a refresh token it already spent, even when nothing can be written", async (t) => {
    const { dir, store, own } = setup(t, { type: "oauth", access: "w0/access", refresh: "w0", expires: 0 });
    own("w0");
    const endpoint = tokenEndpoint("w0");
    const account = createSingleAccount({
      getAuth: async () => store.auth,
      save: async () => { throw new Error("storage unavailable"); },
      readCli: () => null,
      refresh: endpoint.refresh,
      withLock: direct,
      dir,
    });
    // Neither the journal nor the ownership record can be written either.
    fs.chmodSync(dir, 0o500);
    try {
      await refreshWhileStorageIsDown(account, store, 3);
    } finally {
      fs.chmodSync(dir, 0o700);
    }
    assert.deepEqual(endpoint.exchanges, ["w0", "w0+", "w0++"]);
  });

  it("saves the newest tokens, not an older journal, once storage is back", async (t) => {
    const { dir, store, own } = setup(t, { type: "oauth", access: "j0/access", refresh: "j0", expires: 0 });
    own("j0");
    const endpoint = tokenEndpoint("j0");
    let storageUp = false;
    const account = createSingleAccount({
      getAuth: async () => store.auth,
      save: async (tokens) => {
        if (!storageUp) throw new Error("storage unavailable");
        store.auth = { type: "oauth", ...tokens };
      },
      readCli: () => null,
      refresh: endpoint.refresh,
      withLock: direct,
      dir,
    });
    const first = await account.tokens(store.auth);
    // The second refresh can't update the journal, which still holds j0+.
    fs.chmodSync(dir, 0o500);
    try {
      await account.tokens(store.auth, { rejected: first.access });
    } finally {
      fs.chmodSync(dir, 0o700);
    }
    storageUp = true;
    assert.equal((await account.tokens(store.auth)).refresh, "j0++");
    assert.equal(store.auth?.refresh, "j0++");
    assert.deepEqual(endpoint.exchanges, ["j0", "j0+"]);
  });

  /** Two real processes refresh one expired login at the same moment. */
  async function race(t: TestContext, locked: boolean): Promise<{ exchanges: string[]; results: string[] }> {
    const { dir, own } = setup(t, {});
    own("race-r");
    const storePath = path.join(dir, "auth.json");
    fs.writeFileSync(storePath, JSON.stringify({ type: "oauth", access: "old", refresh: "race-r", expires: 0 }));
    const exchanges: string[] = [];
    const live = new Set(["race-r"]);
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        exchanges.push(raw);
        // Slow enough that both processes are mid-refresh together.
        setTimeout(() => {
          if (!live.delete(raw)) { res.statusCode = 400; res.end(JSON.stringify({ error: "invalid_grant" })); return; }
          res.end(JSON.stringify({ access: `${raw}/access`, refresh: `${raw}/next`, expires: Date.now() + HOUR }));
        }, 300);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => server.close());

    const child = `
      const fs = await import("node:fs");
      const { createSingleAccount } = await import(process.env.COORDINATOR);
      const { createRotationStateStore } = await import(process.env.ROTATION);
      const store = process.env.STORE;
      const lock = createRotationStateStore({ path: process.env.STATE, lockPath: process.env.LOCK, lockPollMs: 5 });
      const account = createSingleAccount({
        getAuth: async () => JSON.parse(fs.readFileSync(store, "utf8")),
        save: async (tokens) => {
          const tmp = store + "." + process.pid;
          fs.writeFileSync(tmp, JSON.stringify({ type: "oauth", ...tokens }));
          fs.renameSync(tmp, store);
        },
        readCli: () => null,
        refresh: async (token) => {
          const res = await fetch(process.env.TOKEN, { method: "POST", body: token });
          if (!res.ok) throw new Error("Token refresh failed (" + res.status + "): " + await res.text());
          return res.json();
        },
        withLock: process.env.UNLOCKED ? (fn) => fn() : (fn) => lock.withLock(() => fn()),
        dir: process.env.DIR,
      });
      const auth = JSON.parse(fs.readFileSync(store, "utf8"));
      process.stdout.write("ready\\n");
      await new Promise((resolve) => process.stdin.once("data", resolve));
      try { process.stdout.write((await account.tokens(auth)).access + "\\n"); }
      catch (err) { process.stdout.write("error: " + err.message + "\\n"); }
      process.exit(0);
    `;
    const env = {
      ...process.env,
      COORDINATOR: new URL("./single-account.js", import.meta.url).href,
      ROTATION: new URL("./pool/rotation-state.js", import.meta.url).href,
      STORE: storePath,
      STATE: path.join(dir, "state.json"),
      LOCK: path.join(dir, "state.json.lock"),
      DIR: dir,
      TOKEN: `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`,
      ...(locked ? {} : { UNLOCKED: "1" }),
    };
    const children = [0, 1].map(() => spawn(process.execPath, ["--input-type=module", "-e", child], { env, stdio: ["pipe", "pipe", "inherit"] }));
    const outputs = children.map((proc) => {
      let text = "";
      proc.stdout.on("data", (chunk) => { text += chunk; });
      return { text: () => text, exited: new Promise((resolve) => proc.on("exit", resolve)) };
    });
    // Both read the expired login before either starts.
    while (!outputs.every((out) => out.text().includes("ready"))) await new Promise((resolve) => setTimeout(resolve, 10));
    for (const proc of children) proc.stdin.write("go\n");
    await Promise.all(outputs.map((out) => out.exited));
    return { exchanges, results: outputs.map((out) => out.text().split("\n")[1] ?? "").sort() };
  }

  it("spends a refresh token once when two processes refresh at the same time", async (t) => {
    const { exchanges, results } = await race(t, true);
    assert.deepEqual(exchanges, ["race-r"]);
    assert.deepEqual(results, ["race-r/access", "race-r/access"]);
  });

  it("negative control: without the lock both processes send the same refresh token", async (t) => {
    const { exchanges } = await race(t, false);
    assert.deepEqual(exchanges, ["race-r", "race-r"]);
  });
});
