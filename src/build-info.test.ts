// verify-build in a scratch checkout: the build it recorded passes; a changed build input or output fails.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

function repoRoot(): string {
  for (let dir = path.dirname(fileURLToPath(import.meta.url)); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "scripts", "build-info.mjs"))) return dir;
    if (path.dirname(dir) === dir) return process.cwd();
  }
}

const COPIED = ["package.json", "package-lock.json", "tsconfig.json", "tsconfig.build.json",
  "scripts/build-info.mjs", "scripts/verify-build.mjs", "scripts/claude-pool.mjs"];

describe("verify-build", () => {
  const root = repoRoot();
  let dir = "";
  let env: NodeJS.ProcessEnv = {};

  const verify = () => spawnSync(process.execPath, ["scripts/verify-build.mjs"], { cwd: dir, env, encoding: "utf8" });
  const failedChecks = (stderr: string) => [...stderr.matchAll(/^FAIL (\S+):/gm)].map((match) => match[1]).sort();

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-build-"));
    env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    for (const file of COPIED) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.copyFileSync(path.join(root, file), path.join(dir, file));
    }
    fs.symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"), "dir");
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src", "index.ts"), "export const answer = 42;\n");
    fs.mkdirSync(path.join(dir, "dist"));
    fs.writeFileSync(path.join(dir, "dist", "index.js"), "export const answer = 42;\n");
    const git = (...args: string[]) => execFileSync("git",
      ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args],
      { cwd: dir, env, stdio: "ignore" });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "scratch");
    execFileSync(process.execPath, ["scripts/build-info.mjs"], { cwd: dir, env, stdio: "pipe" });
  });

  after(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("passes for the build it recorded", () => {
    const info = JSON.parse(fs.readFileSync(path.join(dir, "dist", "BUILD-INFO.json"), "utf8"));
    assert.match(info.inputsSha256, /^[0-9a-f]{64}$/);
    const result = verify();
    assert.equal(result.status, 0, result.stderr);
  });

  const cases: Array<[string, string, (text: string) => string, string[]]> = [
    ["the package version", "package.json",
      (text) => text.replace(/"version": "[^"]*"/, '"version": "0.0.0-changed"'), ["inputsSha256", "package"]],
    ["a compiler option", "tsconfig.build.json",
      (text) => text.replace('"extends"', '"compilerOptions": { "removeComments": true },\n  "extends"'), ["inputsSha256"]],
    ["the lockfile", "package-lock.json", (text) => `${text}\n`, ["inputsSha256"]],
    ["the build script", "scripts/build-info.mjs", (text) => `${text}\n// changed\n`, ["inputsSha256"]],
    ["the recorded TypeScript version", "dist/BUILD-INFO.json",
      (text) => text.replace(/"typescript": "[^"]*"/, '"typescript": "0.0.0"'), ["typescript"]],
    ["a source file", "src/index.ts", (text) => `${text}// changed\n`, ["sourceSha256"]],
    ["an output file", "dist/index.js", (text) => `${text}// changed\n`, ["distSha256"]],
  ];
  for (const [what, file, change, expected] of cases) {
    it(`fails when ${what} changes`, () => {
      const target = path.join(dir, file);
      const original = fs.readFileSync(target, "utf8");
      const changed = change(original);
      assert.notEqual(changed, original);
      fs.writeFileSync(target, changed);
      try {
        const result = verify();
        assert.equal(result.status, 1, result.stdout);
        assert.deepEqual(failedChecks(result.stderr), expected, result.stderr);
      } finally {
        fs.writeFileSync(target, original);
      }
    });
  }

  it("passes again once every change is undone", () => {
    const result = verify();
    assert.equal(result.status, 0, result.stderr);
  });
});
