/**
 * The live validator's capture and report functions, with fake credentials.
 * Importing the validator runs nothing; only running it does.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

type Capture = { index: number; label: string; method?: string; url?: string; headers: Record<string, unknown>; body: string };
type RequestLike = { method?: string; url?: string; headers: Record<string, unknown> };

/** The repository root, found from wherever this test was compiled to. */
function repoRoot(): string {
  for (let dir = path.dirname(fileURLToPath(import.meta.url)); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "scripts", "validate-opencode-oauth.js"))) return dir;
    if (path.dirname(dir) === dir) return process.cwd();
  }
}

const validator = await import(pathToFileURL(path.join(repoRoot(), "scripts", "validate-opencode-oauth.js")).href) as {
  captureOf: (req: RequestLike, body: Buffer, label: string, index: number) => Capture;
  compareRequests: (reference: Capture | undefined, candidate: Capture | undefined) => Record<string, unknown>;
};

const capture = (headers: Record<string, unknown>, label = "claude") =>
  validator.captureOf({ method: "POST", url: "/v1/messages", headers }, Buffer.from("{}"), label, 1);

describe("live validator artifacts", () => {
  it("keeps no credential value in a capture", () => {
    const recorded = capture({
      authorization: "Bearer FAKE-BEARER-4817",
      "x-api-key": "FAKE-KEY-4817",
      cookie: "session=FAKE-COOKIE-4817",
      "set-cookie": "a=FAKE-SET-4817",
      "proxy-authorization": "Basic FAKE-PROXY-4817",
      "user-agent": "claude-cli/2.1.0",
    });
    assert.doesNotMatch(JSON.stringify(recorded), /FAKE-/);
    assert.equal(recorded.headers["user-agent"], "claude-cli/2.1.0");
  });

  it("reports one-sided and differing credential headers by presence only", () => {
    const report = JSON.stringify(validator.compareRequests(
      capture({ "x-api-key": "FAKE-KEY-A", cookie: "FAKE-COOKIE-A" }),
      capture({ "x-api-key": "FAKE-KEY-B", "proxy-authorization": "FAKE-PROXY-B" }, "opencode"),
    ));
    assert.doesNotMatch(report, /FAKE-/);
    const diff = JSON.parse(report).headerDiff as Record<string, { claude: unknown; opencode: unknown }>;
    assert.deepEqual(diff.cookie, { claude: "<redacted>", opencode: null });
    assert.deepEqual(diff["proxy-authorization"], { claude: null, opencode: "<redacted>" });
    assert.equal("x-api-key" in diff, false);
  });

  it("writes no credential even from captures that kept their values", () => {
    const raw = (headers: Record<string, unknown>): Capture => ({ index: 1, label: "raw", method: "POST", url: "/v1/messages", headers, body: "{}" });
    const report = JSON.stringify(validator.compareRequests(
      raw({ "x-api-key": "FAKE-KEY-A", Cookie: "FAKE-COOKIE-A" }),
      raw({ "x-api-key": "FAKE-KEY-B", "user-agent": "ua" }),
    ));
    assert.doesNotMatch(report, /FAKE-/);
  });
});
