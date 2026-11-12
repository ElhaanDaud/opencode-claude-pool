import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getClaudeTokens, selectClaudeCredentials } from "./keychain.js";

it("skips malformed keychain candidates before a valid credential", () => {
  const malformed = JSON.parse('{"claudeAiOauth":{"expiresAt":9999999999999}}');
  const valid = JSON.parse('{"claudeAiOauth":{"accessToken":"access","refreshToken":"refresh","expiresAt":9999999999999}}');
  assert.deepEqual(selectClaudeCredentials([malformed, valid]), valid);
});

it("uses the valid unscoped keychain item when the scoped item is malformed", () => {
  const dir = mkdtempSync(join(tmpdir(), "keychain-test-"));
  const oldPath = process.env.PATH;
  const oldPlatform = process.platform;
  writeFileSync(join(dir, "security"), `#!/bin/sh\ncase "$*" in *" -a "*) printf '%s' '{"claudeAiOauth":{"expiresAt":9999999999999}}';; *) printf '%s' '{"claudeAiOauth":{"accessToken":"access","refreshToken":"refresh","expiresAt":9999999999999}}';; esac\n`, { mode: 0o700 });
  process.env.PATH = dir;
  Object.defineProperty(process, "platform", { value: "darwin" });
  try {
    assert.deepEqual(getClaudeTokens(), { access: "access", refresh: "refresh", expires: 9999999999999 });
  } finally {
    Object.defineProperty(process, "platform", { value: oldPlatform });
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
