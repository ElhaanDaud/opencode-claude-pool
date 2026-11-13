import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { createAccountStore, createFileBackend } from "./secret-store.js";

const script = `
  const { createAccountStore, createFileBackend } = await import(process.env.SECRETS);
  const { createRotationStateStore } = await import(process.env.ROTATION);
  const { createRotationManager } = await import(process.env.MANAGER);
  const { enrollFromClaudeCli, removeEnrolledAccount } = await import(process.env.ENROLL);
  const backend = createFileBackend(process.env.ACCOUNTS);
  const accounts = createAccountStore(process.env.FAULT ? {
    ...backend, set: async (label, value) => {
      if (process.env.FAULT === 'crash') process.exit(137);
      throw new Error('injected store write failure');
    }
  } : backend);
  const state = createRotationStateStore({ path: process.env.STATE, lockPath: process.env.LOCK,
    lockPollMs: 10, staleLockMs: 150, lockTimeoutMs: 4000 });
  const manager = createRotationManager({ accounts, state, journalPath: process.env.JOURNAL,
    mirrorFn: async () => {}, refreshFn: async (token) => {
      const response = await fetch(process.env.TOKEN, { method: 'POST', body: token });
      if (!response.ok) throw new Error('refresh rejected ' + response.status);
      return response.json();
    }
  });
  process.stdout.write('ready\\n');
  await new Promise(resolve => process.stdin.once('data', resolve));
  try {
    let result;
    if (process.env.ACTION === 'hold') {
      await state.withLock(async () => { process.stdout.write('locked\\n'); await new Promise(() => {}); });
    } else if (process.env.ACTION === 'replace') {
      result = await enrollFromClaudeCli({ accounts, label: 'work', replace: true, resolveEmail: false,
        lock: fn => state.withLock(() => fn()), readCredentials: () => JSON.stringify({ claudeAiOauth: {
          accessToken: 'replacement', refreshToken: 'replacement-r', expiresAt: Date.now() + 3600000
        } }) });
    } else if (process.env.ACTION === 'remove') {
      result = await removeEnrolledAccount(accounts, state, 'work');
    } else if (process.env.ACTION === 'refresh') {
      result = await manager.refreshLabel('work');
    } else {
      result = await manager.acquire();
    }
    process.stdout.write('result ' + JSON.stringify(result) + '\\n');
  } catch (error) { process.stdout.write('error ' + String(error) + '\\n'); }
  process.exit(0);
`;

async function fixture(t: TestContext, delay = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pool-process-"));
  const accountsPath = path.join(dir, "accounts");
  const accounts = createAccountStore(createFileBackend(accountsPath));
  await accounts.putAccount({ label: "work", enrolledAt: 1, oauth: { access: "old", refresh: "old-r", expires: 0 } });
  const exchanges: string[] = [];
  const live = new Set(["old-r"]);
  let notify: (() => void) | undefined;
  const requested = new Promise<void>((resolve) => { notify = resolve; });
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      exchanges.push(body);
      notify?.();
      const valid = live.delete(body);
      setTimeout(() => {
        if (!valid) { res.writeHead(400); res.end("invalid_grant"); return; }
        res.end(JSON.stringify({ access: "fresh", refresh: "fresh-r", expires: Date.now() + 3_600_000 }));
      }, delay);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const env = { ...process.env, HOME: dir, ACCOUNTS: accountsPath,
    STATE: path.join(dir, "state.json"), LOCK: path.join(dir, "state.lock"),
    JOURNAL: path.join(dir, "refresh-journal.json"), TOKEN: `http://127.0.0.1:${address.port}`,
    SECRETS: new URL("./secret-store.js", import.meta.url).href,
    ROTATION: new URL("./rotation-state.js", import.meta.url).href,
    MANAGER: new URL("./manager.js", import.meta.url).href,
    ENROLL: new URL("./enroll.js", import.meta.url).href };
  const children: ReturnType<typeof spawn>[] = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  function child(options: Record<string, string> = {}) {
    const proc = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...env, ...options }, stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(proc);
    let output = "";
    let errors = "";
    proc.stdout?.on("data", (chunk) => { output += String(chunk); });
    proc.stderr?.on("data", (chunk) => { errors += String(chunk); });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      proc.once("error", reject);
      proc.once("exit", (code, signal) => resolve({ code, signal }));
    });
    async function waitFor(text: string) {
      const deadline = Date.now() + 5000;
      while (!output.includes(text)) {
        if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`child exited: ${output} ${errors}`);
        if (Date.now() > deadline) throw new Error(`child timed out: ${output} ${errors}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    return { proc, exited, waitFor, output: () => output, go: () => proc.stdin?.write("go\n") };
  }
  async function run(options: Record<string, string> = {}) {
    const c = child(options);
    await c.waitFor("ready\n"); c.go();
    const exit = await c.exited;
    return { ...exit, output: c.output() };
  }
  return { dir, accounts, env, exchanges, requested, child, run };
}

test("simultaneous processes exchange one rotating token", async (t) => {
  const f = await fixture(t, 250);
  const children = [f.child(), f.child({ ACTION: "refresh" })];
  await Promise.all(children.map((c) => c.waitFor("ready\n")));
  children.forEach((c) => c.go());
  await Promise.all(children.map((c) => c.exited));
  assert.deepEqual(f.exchanges, ["old-r"]);
  for (const c of children) assert.match(c.output(), /"(?:accessToken|access)":"fresh"/);
  assert.equal((await f.accounts.getAccount("work"))?.oauth.refresh, "fresh-r");
});

test("negative control with distinct locks sends the spent token twice", async (t) => {
  const f = await fixture(t, 250);
  const children = [f.child({ ACTION: "refresh" }), f.child({ ACTION: "refresh", LOCK: path.join(f.dir, "other.lock"), JOURNAL: path.join(f.dir, "other-journal.json") })];
  await Promise.all(children.map((c) => c.waitFor("ready\n")));
  children.forEach((c) => c.go());
  await Promise.all(children.map((c) => c.exited));
  assert.deepEqual(f.exchanges, ["old-r", "old-r"]);
  assert.equal(children.filter((c) => c.output().includes("error ")).length, 1);
});

for (const fault of ["crash", "throw"] as const) {
  test(`${fault} during store commit leaves a journal for another process`, async (t) => {
    const f = await fixture(t);
    const first = await f.run({ ACTION: "refresh", FAULT: fault });
    if (fault === "crash") assert.equal(first.code, 137);
    else assert.match(first.output, /injected store write failure/);
    assert.equal((await f.accounts.getAccount("work"))?.oauth.refresh, "old-r");
    const journal = JSON.parse(fs.readFileSync(f.env.JOURNAL, "utf8"));
    assert.equal(journal.replaces, "old-r");
    assert.equal(journal.tokens.refresh, "fresh-r");
    const second = await f.run();
    assert.match(second.output, /"accessToken":"fresh"/);
    assert.equal((await f.accounts.getAccount("work"))?.oauth.refresh, "fresh-r");
    assert.equal(fs.existsSync(f.env.JOURNAL), false);
    assert.deepEqual(f.exchanges, ["old-r"]);
  });
}

for (const action of ["replace", "remove"] as const) {
  test(`${action} waits for another process's in-progress refresh`, async (t) => {
    const f = await fixture(t, 500);
    const a = f.child({ ACTION: "refresh" });
    await a.waitFor("ready\n"); a.go();
    await f.requested;
    const b = f.child({ ACTION: action });
    await b.waitFor("ready\n"); b.go();
    const [aExit, bExit] = await Promise.all([a.exited, b.exited]);
    assert.equal(aExit.code, 0); assert.equal(bExit.code, 0);
    assert.match(a.output(), /"access":"fresh"/);
    assert.match(b.output(), /result /);
    const record = await f.accounts.getAccount("work");
    if (action === "replace") assert.equal(record?.oauth.refresh, "replacement-r");
    else assert.equal(record, null);
    assert.deepEqual(f.exchanges, ["old-r"]);
  });
}

test("dead lock holder is reclaimed after the configured stale age", async (t) => {
  const f = await fixture(t);
  const holder = f.child({ ACTION: "hold" });
  await holder.waitFor("ready\n"); holder.go();
  await holder.waitFor("locked\n");
  holder.proc.kill("SIGKILL");
  assert.equal((await holder.exited).signal, "SIGKILL");
  assert.equal(fs.existsSync(f.env.LOCK), true);
  const start = Date.now();
  const result = await f.run();
  assert.ok(Date.now() - start < 2500);
  assert.match(result.output, /"accessToken":"fresh"/);
  assert.deepEqual(f.exchanges, ["old-r"]);
});

test("mismatched journal is quarantined without overwriting a re-enrollment", async (t) => {
  const f = await fixture(t);
  await f.accounts.putAccount({ label: "work", enrolledAt: 2, oauth: { access: "new", refresh: "new-r", expires: Date.now() + 3_600_000 } });
  fs.writeFileSync(f.env.JOURNAL, JSON.stringify({ label: "work", replaces: "old-r", writtenAt: Date.now(), tokens: { access: "journal", refresh: "journal-r", expires: Date.now() + 3_600_000 } }));
  const result = await f.run();
  assert.match(result.output, /"accessToken":"new"/);
  assert.equal((await f.accounts.getAccount("work"))?.oauth.refresh, "new-r");
  assert.equal(fs.existsSync(f.env.JOURNAL), false);
  const stale = fs.readdirSync(f.dir).filter((name) => name.endsWith(".stale"));
  assert.equal(stale.length, 1);
  assert.deepEqual(f.exchanges, []);
});
