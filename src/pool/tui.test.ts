import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { LabelConflictError } from "./enroll.js";
import { clipFrame, createPoolTui, findRedundant } from "./tui.js";
import type { TuiDeps } from "./tui.js";
import type { PoolSnapshot, PoolSnapshotRow } from "./manager.js";
import type { AccountState, RotationState } from "./types.js";
import { EventEmitter } from "node:events";

function lockedState(rotation: RotationState = { version: 1, activeLabel: null, accounts: {} }) {
  return { withLock: async <T>(fn: (state: RotationState) => T | Promise<T>) => fn(rotation) };
}

function row(label: string, status: PoolSnapshotRow["status"]): PoolSnapshotRow {
  return {
    label,
    email: null,
    tier: null,
    status,
    cooldownUntil: null,
    reason: null,
    failureCount: 0,
    tokenExpires: 0,
    active: false,
    fiveHourReset: null,
    sevenDayReset: null,
    bindingWindow: null,
    scopes: null,
    rateLimitTier: null,
    enrolledAt: 0,
    updatedAt: null,
  };
}

describe("dashboard regressions", () => {
  function fixture(options: { rows?: number; snapshot?: TuiDeps["pool"]["snapshot"]; fetchUsage?: TuiDeps["fetchUsage"]; raw?: (enabled: boolean) => void } = {}) {
    const writes: string[] = [];
    const stdin = Object.assign(new EventEmitter(), {
      isTTY: true, setRawMode: options.raw ?? (() => undefined), resume: () => undefined,
      pause: () => undefined, setEncoding: () => undefined,
    });
    const stdout = Object.assign(new EventEmitter(), {
      isTTY: true, columns: 100, rows: options.rows ?? 24,
      write: (text: string) => { writes.push(text); return true; },
    });
    const removed: string[] = [];
    const tui = createPoolTui({
      pool: {
        snapshot: options.snapshot ?? (async () => ({ activeLabel: null, now: 0, accounts: Array.from({ length: 30 }, (_, i) => row(`account-${i}`, "ready")) })),
        pendingRefreshLabel: () => "account-0",
      } as unknown as TuiDeps["pool"],
      accounts: { getAccount: async () => ({}), removeAccount: async (label: string) => { removed.push(label); } } as unknown as TuiDeps["accounts"],
      state: lockedState() as unknown as TuiDeps["state"],
      enroll: async () => "", whoami: async () => "cli@example.com", fetchUsage: options.fetchUsage,
      stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
    });
    return { tui, stdin, stdout, writes, removed };
  }
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

  it("keeps a crowded removal confirmation visible within the terminal", async () => {
    const ui = fixture({ snapshot: async () => ({ activeLabel: null, now: 0, accounts: Array.from({ length: 30 }, (_, i) => ({ ...row(`account-${i}`, "ready"), reason: "detail", scopes: ["scope"] })) }) });
    const started = ui.tui.start();
    await tick();
    await ui.tui.onKey("\r");
    await ui.tui.onKey("x");
    const frame = ui.writes.at(-1) ?? "";
    ui.tui.stop();
    await started;
    assert.match(frame, /Remove "account-0"/);
    assert.ok(frame.split("\n").length - 1 <= 24);
  });

  it("does not accept a confirmation that cannot fit on screen", async () => {
    const ui = fixture({ rows: 3 });
    const started = ui.tui.start();
    await tick();
    await ui.tui.onKey("x");
    await ui.tui.onKey("y");
    ui.tui.stop();
    await started;
    assert.deepEqual(ui.removed, []);
  });

  it("restores the terminal when raw mode setup fails", async () => {
    const raw: boolean[] = [];
    const ui = fixture({ raw: (enabled) => { raw.push(enabled); if (enabled) throw new Error("raw failed"); } });
    await assert.rejects(ui.tui.start(), /raw failed/);
    assert.deepEqual(raw, [true, false]);
    assert.match(ui.writes.join(""), /\u001b\[\?25h\u001b\[\?1049l/);
  });

  it("cleans up when the first snapshot fails", async () => {
    const ui = fixture({ snapshot: async () => { throw new Error("snapshot failed"); } });
    await assert.rejects(ui.tui.start(), /snapshot failed/);
    assert.match(ui.writes.join(""), /\u001b\[\?25h\u001b\[\?1049l/);
  });

  it("surfaces periodic reload errors", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    let calls = 0;
    const ui = fixture({ snapshot: async () => {
      if (calls++) throw new Error("reload failed");
      return { activeLabel: null, now: 0, accounts: [row("a", "ready")] };
    } });
    const started = ui.tui.start();
    await tick();
    t.mock.timers.tick(30_000);
    await tick();
    const frame = ui.writes.at(-1) ?? "";
    ui.tui.stop();
    await started;
    assert.match(frame, /reload failed/);
  });

  it("does not let an older detail request overwrite a newer usage refresh", async () => {
    const resolvers: Array<(value: import("./usage.js").AccountUsage) => void> = [];
    const ui = fixture({
      snapshot: async () => ({ activeLabel: null, now: 0, accounts: [{ ...row("a", "ready"), tokenExpires: Date.now() + 3600000 }] }),
      fetchUsage: () => new Promise((resolve) => { resolvers.push(resolve); }),
    });
    const started = ui.tui.start();
    await tick();
    const older = ui.tui.onKey("\r");
    const newer = ui.tui.onKey("s");
    const value = (utilization: number) => ({ fiveHour: { utilization, resetsAt: null, lockedReason: null }, sevenDay: null, sevenDayOpus: null, fetchedAt: 0 });
    resolvers[1]!(value(80));
    await newer;
    resolvers[0]!(value(10));
    await older;
    const frame = ui.writes.at(-1) ?? "";
    ui.tui.stop();
    await started;
    assert.match(frame, /80%/);
  });

  it("reports a rejected usage fetch as failure", async () => {
    const ui = fixture({ fetchUsage: async () => { throw new Error("network down"); } });
    const started = ui.tui.start();
    await tick();
    await ui.tui.onKey("s");
    const frame = ui.writes.at(-1) ?? "";
    ui.tui.stop();
    await started;
    assert.match(frame, /usage failed/);
  });

  it("forces manual refresh using the stored access token", async () => {
    let rejected: string | undefined;
    const tui = createPoolTui({
      pool: {
        snapshot: async () => ({ activeLabel: null, now: 0, accounts: [row("a", "ready")] }),
        pendingRefreshLabel: () => null,
        refreshLabel: async (_label: string, access?: string) => { rejected = access; return { expires: Date.now() + 3600000 }; },
      } as unknown as TuiDeps["pool"],
      accounts: { getAccount: async () => ({ oauth: { access: "fresh-access", expires: Date.now() + 3600000 } }) } as unknown as TuiDeps["accounts"],
      state: {} as TuiDeps["state"], enroll: async () => "",
      stdout: { columns: 100, rows: 30, write: () => true, on: () => undefined } as unknown as NodeJS.WriteStream,
      stdin: {} as NodeJS.ReadStream,
    });
    await tui.reload();
    await tui.onKey("f");
    assert.equal(rejected, "fresh-access");
  });
});

describe("pool TUI selection", () => {
  it("keeps the selection on the same account when a reload re-sorts the rows", async () => {
    const snapshots: PoolSnapshot[] = [
      { activeLabel: null, now: 0, accounts: [row("b", "ready"), row("c", "ready"), row("a", "cooling")] },
      // "a" finished cooling, so it now sorts first and shifts every row down.
      { activeLabel: null, now: 0, accounts: [row("a", "ready"), row("b", "ready"), row("c", "ready")] },
    ];
    let reloads = 0;
    const activated: string[] = [];

    const tui = createPoolTui({
      pool: {
        snapshot: async () => snapshots[Math.min(reloads++, snapshots.length - 1)]!,
        pendingRefreshLabel: () => null,
      } as unknown as TuiDeps["pool"],
      accounts: {} as TuiDeps["accounts"],
      state: {
        setActive: async (label: string | null) => {
          if (label) activated.push(label);
        },
      } as unknown as TuiDeps["state"],
      enroll: async () => "",
      stdout: { columns: 100, rows: 30, write: () => true, on: () => undefined } as unknown as NodeJS.WriteStream,
      stdin: {} as NodeJS.ReadStream,
    });

    await tui.reload();
    await tui.onKey("j");
    await tui.reload();
    await tui.onKey("a");

    assert.deepEqual(activated, ["c"]);
  });

  it("removing an account also drops its rotation state", async () => {
    const calls: string[] = [];
    const rotation: RotationState = { version: 1, activeLabel: "a", accounts: { a: {} as AccountState } };
    const tui = createPoolTui({
      pool: {
        snapshot: async () => ({ activeLabel: null, now: 0, accounts: [row("a", "disabled")] }),
        pendingRefreshLabel: () => null,
      } as unknown as TuiDeps["pool"],
      accounts: {
        getAccount: async () => ({}),
        removeAccount: async (label: string) => {
          calls.push(`keychain:${label}`);
        },
      } as unknown as TuiDeps["accounts"],
      state: lockedState(rotation) as unknown as TuiDeps["state"],
      enroll: async () => "",
      stdout: { columns: 100, rows: 30, write: () => true, on: () => undefined } as unknown as NodeJS.WriteStream,
      stdin: {} as NodeJS.ReadStream,
    });

    await tui.reload();
    await tui.onKey("x");
    await tui.onKey("y");

    assert.deepEqual(calls, ["keychain:a"]);
    assert.equal(Object.hasOwn(rotation.accounts, "a"), false);
    assert.equal(rotation.activeLabel, null);
  });

  it("disables the selected account by hand, and u re-enables it", async () => {
    let status: PoolSnapshotRow["status"] = "ready";
    const calls: string[] = [];
    const tui = createPoolTui({
      pool: {
        snapshot: async () => ({ activeLabel: null, now: 0, accounts: [row("a", status)] }),
        pendingRefreshLabel: () => null,
      } as unknown as TuiDeps["pool"],
      accounts: {} as TuiDeps["accounts"],
      state: {
        markDisabled: async (label: string, reason: string) => {
          calls.push(`disable:${label}:${reason}`);
          status = "disabled";
        },
        resetHealth: async (label: string) => {
          calls.push(`enable:${label}`);
          status = "ready";
        },
      } as unknown as TuiDeps["state"],
      enroll: async () => "",
      stdout: { columns: 100, rows: 30, write: () => true, on: () => undefined } as unknown as NodeJS.WriteStream,
      stdin: {} as NodeJS.ReadStream,
    });

    await tui.reload();
    await tui.onKey("d");
    await tui.onKey("d");
    await tui.onKey("u");

    assert.deepEqual(calls, ["disable:a:disabled by hand", "enable:a"]);
  });
});

describe("pool TUI prune", () => {
  const mine = (label: string, status: PoolSnapshotRow["status"], active = false): PoolSnapshotRow => ({
    ...row(label, status),
    email: "me@example.com",
    active,
  });

  it("keeps the healthy re-login when the dead entry is still the active one", () => {
    // markDisabled leaves activeLabel pointing at the dead entry.
    assert.deepEqual([...findRedundant([mine("me-2", "ready"), mine("me", "disabled", true)])], ["me"]);
    assert.deepEqual([...findRedundant([mine("me-2", "ready"), mine("me", "cooling", true)])], ["me"]);
  });

  it("uses the active entry only to break a tie between equally healthy siblings", () => {
    assert.deepEqual([...findRedundant([mine("me", "ready"), mine("me-2", "ready", true)])], ["me"]);
    assert.deepEqual([...findRedundant([mine("me", "disabled"), mine("me-2", "disabled", true)])], ["me"]);
  });

  it("prunes the dead entry, never its healthy sibling", async () => {
    const removed: string[] = [];
    const accounts = [mine("me-2", "ready"), mine("me", "disabled", true)];
    const tui = createPoolTui({
      pool: {
        snapshot: async () => ({ activeLabel: "me", now: 0, accounts }),
        pendingRefreshLabel: () => null,
      } as unknown as TuiDeps["pool"],
      accounts: {
        getAccount: async () => ({}),
        removeAccount: async (label: string) => {
          removed.push(label);
        },
      } as unknown as TuiDeps["accounts"],
      state: lockedState() as unknown as TuiDeps["state"],
      enroll: async () => "",
      stdout: { columns: 100, rows: 30, write: () => true, on: () => undefined } as unknown as NodeJS.WriteStream,
      stdin: {} as NodeJS.ReadStream,
    });

    await tui.reload();
    await tui.onKey("p");
    await tui.onKey("y");

    assert.deepEqual(removed, ["me"]);
  });
});

describe("pool TUI enroll", () => {
  function tuiWithEnroll(enroll: TuiDeps["enroll"]) {
    return createPoolTui({
      pool: {
        snapshot: async () => ({ activeLabel: null, now: 0, accounts: [] }),
        pendingRefreshLabel: () => null,
      } as unknown as TuiDeps["pool"],
      accounts: {} as TuiDeps["accounts"],
      state: {} as TuiDeps["state"],
      enroll,
      stdout: { columns: 100, rows: 30, write: () => true, on: () => undefined } as unknown as NodeJS.WriteStream,
      stdin: {} as NodeJS.ReadStream,
    });
  }

  it("offers to replace a label held by an account with no known email", async () => {
    const calls: Array<{ label?: string; replace?: boolean }> = [];
    const tui = tuiWithEnroll(async (label, options) => {
      calls.push({ label, replace: options?.replace });
      if (!options?.replace) throw new LabelConflictError("alice", null);
      return "alice";
    });

    await tui.onKey("e");
    await tui.onKey("y");

    assert.deepEqual(calls, [
      { label: undefined, replace: undefined },
      { label: "alice", replace: true },
    ]);
  });

  it("does not replace anything when the prompt is declined", async () => {
    const calls: Array<boolean | undefined> = [];
    const tui = tuiWithEnroll(async (_label, options) => {
      calls.push(options?.replace);
      throw new LabelConflictError("alice", null);
    });

    await tui.onKey("e");
    await tui.onKey("n");

    assert.deepEqual(calls, [undefined]);
  });

  it("ignores action keys while an enroll is in flight, so no prompt is queued behind it", async () => {
    const removed: string[] = [];
    let finishEnroll!: (label: string) => void;
    const tui = createPoolTui({
      pool: {
        snapshot: async () => ({ activeLabel: null, now: 0, accounts: [row("bob", "ready")] }),
        pendingRefreshLabel: () => null,
      } as unknown as TuiDeps["pool"],
      accounts: {
        getAccount: async () => ({}),
        removeAccount: async (label: string) => {
          removed.push(label);
        },
      } as unknown as TuiDeps["accounts"],
      state: lockedState() as unknown as TuiDeps["state"],
      enroll: () =>
        new Promise((resolve) => {
          finishEnroll = resolve;
        }),
      stdout: { columns: 100, rows: 30, write: () => true, on: () => undefined } as unknown as NodeJS.WriteStream,
      stdin: {} as NodeJS.ReadStream,
    });
    await tui.reload();

    const enrolling = tui.onKey("e");
    await tui.onKey("x");
    finishEnroll("alice");
    await enrolling;
    await tui.onKey("y");

    assert.deepEqual(removed, []);
  });

  it("never offers to replace an account that belongs to a known other email", async () => {
    const calls: Array<boolean | undefined> = [];
    const tui = tuiWithEnroll(async (_label, options) => {
      calls.push(options?.replace);
      throw new LabelConflictError("alice", "alice@work.io");
    });

    await tui.onKey("e");
    await tui.onKey("y");

    assert.deepEqual(calls, [undefined]);
  });

  it("quitting while an action is in flight does not redraw over the restored shell", async () => {
    const { EventEmitter } = await import("node:events");
    const stdin = Object.assign(new EventEmitter(), {
      isTTY: true, setRawMode: () => undefined, resume: () => undefined, pause: () => undefined, setEncoding: () => undefined,
    });
    let restored = false;
    const afterRestore: string[] = [];
    const stdout = Object.assign(new EventEmitter(), {
      isTTY: true, columns: 100, rows: 30,
      write(chunk: string) {
        if (restored) afterRestore.push(chunk);
        if (chunk.includes("\u001b[?1049l")) restored = true;
        return true;
      },
    });
    let finishUsage: () => void = () => undefined;
    const tui = createPoolTui({
      pool: {
        snapshot: async () => ({ activeLabel: "a", now: 0, accounts: [row("a", "ready")] }),
        pendingRefreshLabel: () => null,
      } as unknown as TuiDeps["pool"],
      accounts: {} as TuiDeps["accounts"],
      state: {} as TuiDeps["state"],
      enroll: async () => "",
      fetchUsage: () =>
        new Promise((resolve) => {
          finishUsage = () => resolve({ fiveHour: null, sevenDay: null, extra: null } as never);
        }),
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });
    const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

    const started = tui.start();
    await tick();
    stdin.emit("data", "s");
    await tick();
    stdin.emit("data", "q");
    await started;
    finishUsage();
    await tick();

    assert.equal(afterRestore.length, 1);
    assert.match(afterRestore[0]!, /finishing the current action/);
  });
});

describe("pool TUI key decoding", () => {
  /** Start the TUI on a fake TTY and feed it stdin chunks, one read each. */
  async function feed(chunks: string[]): Promise<{ activated: string[]; quit: boolean }> {
    const { EventEmitter } = await import("node:events");
    const stdin = Object.assign(new EventEmitter(), {
      isTTY: true, setRawMode: () => undefined, resume: () => undefined, pause: () => undefined, setEncoding: () => undefined,
    });
    const stdout = Object.assign(new EventEmitter(), { isTTY: true, columns: 100, rows: 30, write: () => true });
    const activated: string[] = [];
    const tui = createPoolTui({
      pool: {
        snapshot: async () => ({ activeLabel: null, now: 0, accounts: [row("a", "ready"), row("b", "ready")] }),
        pendingRefreshLabel: () => null,
      } as unknown as TuiDeps["pool"],
      accounts: {} as TuiDeps["accounts"],
      state: {
        setActive: async (label: string | null) => {
          if (label) activated.push(label);
        },
      } as unknown as TuiDeps["state"],
      enroll: async () => "",
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });
    const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

    let quit = false;
    const started = tui.start().then(() => {
      quit = true;
    });
    await tick();
    for (const chunk of chunks) {
      stdin.emit("data", chunk);
      await tick();
    }
    const quitByKeys = quit;
    // A frozen TUI must fail the assertion, not hang the run on its timer.
    tui.stop();
    await started;
    return { activated, quit: quitByKeys };
  }

  it("keeps reading keys after a bare Esc or an Alt+key", async () => {
    const result = await feed(["\u001b", "j", "\u001bz", "a", "\u0003"]);

    assert.deepEqual(result, { activated: ["b"], quit: true });
  });

  it("reads SS3 arrows and escape sequences split across reads", async () => {
    const result = await feed(["\u001bOB", "a", "\u001b[", "A", "a", "q"]);

    assert.deepEqual(result, { activated: ["b", "a"], quit: true });
  });
});

describe("TUI frame clipping", () => {
  it("never emits a line that reaches the terminal width", () => {
    // A line of exactly `columns` characters wraps, so the frame drifts and the
    // previous frame bleeds through — it rendered as duplicated footers and
    // merged text. Enforced at the write point so no caller can reintroduce it.
    const visible = (line: string): number =>
      line.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").length;
    const frame = [`${"a".repeat(200)}`, `short`, `${"b".repeat(80)}`].join("\n");
    for (const line of clipFrame(frame, 61).split("\n")) {
      assert.ok(visible(line) <= 61, `line too wide: ${visible(line)}`);
    }
  });

  it("emits exactly one line per terminal row so a shorter frame leaves no tail", () => {
    // Frames change height (expanding a detail pane, a message appearing).
    // Relying on erase-to-end-of-screen left the tail of a taller previous
    // frame on screen, which read as a duplicated footer and stale text merged
    // into the detail pane.
    const tall = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
    const short = "only one line";
    for (const frame of [tall, short]) {
      const outLines = clipFrame(frame, 40, 8).replace(/\n$/, "").split("\n");
      assert.equal(outLines.length, 8, "frame height must be constant");
    }
    // Padding rows must carry the erase code, not just be blank.
    assert.ok(clipFrame(short, 40, 4).includes("\u001b[K"));
  });

  it("appends the erase code to every line regardless of call site", () => {
    // Requiring each out.push to append EOL was fragile: two detail-pane
    // templates contained nested backticks, a bulk edit silently skipped them,
    // and those lines then displayed fragments of the longer content they
    // overwrote. Centralising it makes the omission impossible.
    const frame = ["\u001b[2m  5h —  7d —\u001b[0m", "plain", "already\u001b[K"].join("\n");
    const lines = clipFrame(frame, 80, 5).replace(/\n$/, "").split("\n");
    assert.ok(
      lines.every((line) => line.endsWith("\u001b[K")),
      "every line must erase its own tail",
    );
    assert.ok(
      !lines.some((line) => line.endsWith("\u001b[K\u001b[K")),
      "must not double up an existing erase code",
    );
  });

  it("preserves escape sequences when clipping", () => {
    const line = `\u001b[2m${"x".repeat(100)}\u001b[0m\u001b[K`;
    const out = clipFrame(line, 10);
    assert.ok(out.includes("\u001b[2m"), "leading style dropped");
    assert.ok(out.includes("\u001b[K"), "erase-to-EOL dropped");
    assert.equal(out.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").length, 10);
  });
});

describe("pool TUI signals", () => {
  const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  /** A TUI on a fake TTY whose token refresh (`f`) stays in flight until finish(). */
  async function signalTui(t: import("node:test").TestContext) {
    const { EventEmitter } = await import("node:events");
    let hungUp = false;
    const eio = () => Object.assign(new Error("EIO"), { code: "EIO" });
    const stdin = Object.assign(new EventEmitter(), {
      isTTY: true, resume: () => undefined, pause: () => undefined, setEncoding: () => undefined,
      // Like tty.ReadStream: a failed tcsetattr is emitted, synchronously.
      setRawMode: () => (hungUp ? stdin.emit("error", eio()) : undefined),
    });
    const writes: string[] = [];
    const stdout = Object.assign(new EventEmitter(), {
      isTTY: true, columns: 100, rows: 30,
      write(chunk: string) {
        if (hungUp) process.nextTick(() => stdout.emit("error", eio()));
        else writes.push(chunk);
        return true;
      },
    });
    const exits: Array<number | undefined> = [];
    t.mock.method(process, "exit", ((code?: number) => void exits.push(code)) as never);
    let finish: () => void = () => undefined;
    const tui = createPoolTui({
      pool: {
        snapshot: async () => ({ activeLabel: "a", now: 0, accounts: [row("a", "ready")] }),
        pendingRefreshLabel: () => null,
        refreshLabel: () =>
          new Promise((resolve) => {
            finish = () => resolve({ access: "new", refresh: "rotated", expires: Date.now() + 3_600_000 });
          }),
      } as unknown as TuiDeps["pool"],
      accounts: { getAccount: async () => ({ oauth: { access: "old" } }) } as unknown as TuiDeps["accounts"],
      state: {} as TuiDeps["state"],
      enroll: async () => "",
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });
    const listeners = SIGNALS.map((signal) => process.listenerCount(signal));
    const started = tui.start();
    await tick();
    return {
      stdin,
      writes,
      exits,
      started,
      hangUp: () => {
        hungUp = true;
      },
      finish: () => finish(),
      leaked: () => SIGNALS.filter((signal, i) => process.listenerCount(signal) !== listeners[i]),
    };
  }

  it("a signal mid-refresh restores the terminal but exits only once the refresh lands", async (t) => {
    // Killing the process while the token request is in flight can drop the
    // reply carrying the rotated refresh token, after the old one is dead.
    const ui = await signalTui(t);
    ui.stdin.emit("data", "f");
    await tick();

    process.emit("SIGTERM", "SIGTERM");
    await ui.started;
    assert.deepEqual(ui.exits, []);
    assert.match(ui.writes.join(""), /\u001b\[\?1049l[^]*finishing the current action/);

    ui.finish();
    await tick();
    assert.deepEqual(ui.exits, [143]);
    assert.deepEqual(ui.leaked(), []);
  });

  it("closing the terminal mid-refresh still waits for the refresh", async (t) => {
    // Observed on a real pty: the restore write fails with EIO, and SIGHUP
    // arrives twice, so neither may end the process early.
    const ui = await signalTui(t);
    ui.stdin.emit("data", "f");
    await tick();

    ui.hangUp();
    process.emit("SIGHUP", "SIGHUP");
    process.emit("SIGHUP", "SIGHUP");
    await tick();
    assert.deepEqual(ui.exits, []);

    ui.finish();
    await tick();
    assert.deepEqual(ui.exits, [143]);
    assert.deepEqual(ui.leaked(), []);
  });

  it("a second signal exits at once, so the user can always get out", async (t) => {
    const ui = await signalTui(t);
    ui.stdin.emit("data", "f");
    await tick();

    process.emit("SIGTERM", "SIGTERM");
    process.emit("SIGINT", "SIGINT");
    assert.deepEqual(ui.exits, [130]);

    ui.finish();
    await tick();
    assert.deepEqual(ui.leaked(), []);
  });

  it("gives up waiting on a refresh that never settles after 2 minutes", async (t) => {
    const ui = await signalTui(t);
    ui.stdin.emit("data", "f");
    await tick();

    t.mock.timers.enable({ apis: ["setTimeout"] });
    process.emit("SIGTERM", "SIGTERM");
    t.mock.timers.tick(119_999);
    assert.deepEqual(ui.exits, []);
    t.mock.timers.tick(1);
    assert.deepEqual(ui.exits, [143]);

    ui.finish();
    await tick();
  });

  it("exits at once with no action in flight, and q leaves no signal handlers behind", async (t) => {
    const idle = await signalTui(t);
    process.emit("SIGTERM", "SIGTERM");
    await idle.started;
    assert.deepEqual(idle.exits, [143]);
    assert.deepEqual(idle.leaked(), []);

    const quit = await signalTui(t);
    quit.stdin.emit("data", "q");
    await quit.started;
    assert.deepEqual(quit.leaked(), []);
  });
});
