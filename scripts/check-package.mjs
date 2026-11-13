import { spawnSync } from "node:child_process";

const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8" });
if (result.status !== 0) {
  process.stderr.write(result.stderr || String(result.error ?? "npm pack failed"));
  process.exit(1);
}
const files = JSON.parse(result.stdout)[0].files.map((file) => file.path);
const required = ["dist/index.js", "dist/opencode2/server.js", "dist/opencode2/tui.js", "dist/BUILD-INFO.json"];
const errors = files.filter((file) => /\.test\.(?:js|d\.ts)$/.test(file) ||
  !(file.startsWith("dist/") || /^(?:package\.json|README(?:\.[^/]*)?|LICENSE(?:\.[^/]*)?|NOTICE\.md)$/i.test(file)))
  .map((file) => `unexpected package file: ${file}`);
errors.push(...required.filter((file) => !files.includes(file)).map((file) => `missing package file: ${file}`));
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`PASS package contents (${files.length} files)`);
}
