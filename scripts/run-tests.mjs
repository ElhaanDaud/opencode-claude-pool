import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import ts from "typescript";

const root = path.resolve("build/test");
const manifest = {
  "api-key.test.js": "fixture", "history.test.js": "fixture", "index.test.js": "fixture",
  "opencode2/tools.test.js": "fixture", "pool/classifier-live.test.js": "fixture",
  "pool/classifier.test.js": "fixture", "pool/selection.test.js": "fixture",
  "stream-adversarial.test.js": "fixture", "stream.test.js": "fixture", "validator-redaction.test.js": "fixture",
  "keychain.test.js": "injected-boundary", "notices.test.js": "injected-boundary", "opencode2/server.test.js": "injected-boundary",
  "opencode2/shared.test.js": "injected-boundary", "opencode2/tui.test.js": "injected-boundary",
  "pool/bridge.test.js": "injected-boundary", "pool/enroll.test.js": "injected-boundary",
  "pool/manager.test.js": "injected-boundary", "pool/notify.test.js": "injected-boundary",
  "pool/security-fixes.test.js": "injected-boundary", "pool/secret-store.test.js": "injected-boundary",
  "pool/tui.test.js": "injected-boundary", "rotation-loop.test.js": "injected-boundary",
  "single-account.test.js": "injected-boundary", "tool-contracts.test.js": "injected-boundary",
  "build-info.test.js": "process", "oauth.test.js": "process", "pool/rotation-state.test.js": "process",
  "single-account-coordinator.test.js": "process", "pool/process-faults.test.js": "process",
};
const nativeFile = "pool/secret-store.test.js";
const nativeName = "keychain backend (macOS only)";
const native = process.argv.includes("--native");

// Node 20 filters each test name independently; newer releases also match ancestors.
const source = ts.createSourceFile(nativeFile, readFileSync(path.join(root, nativeFile), "utf8"), ts.ScriptTarget.Latest, true);
const names = { native: new Set(), ordinary: new Set() };
function collect(node, category = "ordinary") {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ["describe", "it"].includes(node.expression.text)) {
    const name = node.arguments[0];
    if (!name || !ts.isStringLiteral(name)) throw new Error("Secret-store test names must be string literals");
    if (name.text === nativeName) category = "native";
    names[category].add(name.text);
  }
  ts.forEachChild(node, (child) => collect(child, category));
}
collect(source);
if (!names.native.has(nativeName) || [...names.native].some((name) => names.ordinary.has(name))) {
  throw new Error("Cannot safely separate native secret-store tests by name");
}
function patternFor(category) {
  return `^(?:${[...names[category]].map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`;
}

function discover(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? discover(file) : file.endsWith(".test.js") ? [file] : [];
  });
}

const files = discover(root).sort().map((file) => path.relative(root, file).split(path.sep).join("/"));
const unknown = files.filter((file) => !Object.hasOwn(manifest, file));
console.log(`UNCLASSIFIED (default injected-boundary): ${unknown.length ? unknown.join(", ") : "none"}`);
console.log("EXCLUDED:");
if (!native) console.log(`  native: ${nativeName} — npm run test:native`);
console.log("  real host: node scripts/qa-opencode1.mjs; node scripts/qa-opencode2.mjs");
console.log("  live provider: node scripts/validate-opencode-oauth.js --live; scripts/intercept-claude.sh --live; node scripts/qa-rotation.mjs --live (each refuses to run without --live)");
console.log("  quality benchmarks: none exist");

const classes = native ? ["native"] : ["fixture", "injected-boundary", "process"];
for (const category of classes) {
  const selected = native ? [nativeFile] : files.filter((file) => (manifest[file] ?? "injected-boundary") === category);
  const groups = native ? [[selected, patternFor("native")]] : [
    [selected.filter((file) => file !== nativeFile), null],
    [selected.filter((file) => file === nativeFile), patternFor("ordinary")],
  ];
  const totals = { tests: 0, pass: 0, fail: 0, skipped: 0 };
  for (const [group, pattern] of groups) {
    if (!group.length) continue;
    const args = ["--test", "--test-reporter=tap"];
    if (pattern) args.push(`--test-name-pattern=${pattern}`);
    args.push(...group.map((file) => path.join(root, file)));
    const result = spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    if (result.status !== 0) {
      process.stdout.write(result.stdout ?? "");
      process.stderr.write(result.stderr || String(result.error ?? `test runner exited ${result.status}\n`));
      process.exitCode = 1;
    }
    for (const key of Object.keys(totals)) {
      const match = result.stdout?.match(new RegExp(`^# ${key} (\\d+)$`, "m"));
      if (match) totals[key] += Number(match[1]);
      else { console.error(`Missing ${key} total for ${category}`); process.exitCode = 1; }
    }
  }
  console.log(`${category}: tests=${totals.tests} pass=${totals.pass} fail=${totals.fail} skipped=${totals.skipped}`);
}
