import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { distHash, inputsHash, sourceHash } from "./build-info.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = path.resolve(process.argv[2] ?? path.join(root, "dist"));
const info = JSON.parse(readFileSync(path.join(directory, "BUILD-INFO.json"), "utf8"));
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

const checks = [
  ["package", `${info.name}@${info.version}`, `${pkg.name}@${pkg.version}`],
  ["typescript", info.typescript, ts.version],
  ["sourceSha256", info.sourceSha256, sourceHash()],
  ["inputsSha256", info.inputsSha256, inputsHash()],
  ["distSha256", info.distSha256, distHash(directory)],
];
const failed = checks.filter(([, recorded, current]) => recorded !== current);
for (const [name, recorded, current] of failed) {
  console.error(`FAIL ${name}: BUILD-INFO.json has ${recorded ?? "nothing"}, this checkout gives ${current}`);
}
if (failed.length > 0) process.exitCode = 1;
else console.log(`PASS ${checks.map(([name]) => name).join(", ")} match BUILD-INFO.json`);
