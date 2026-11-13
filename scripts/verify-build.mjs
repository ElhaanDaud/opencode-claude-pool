import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { distHash, sourceHash } from "./build-info.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = path.resolve(process.argv[2] ?? path.join(root, "dist"));
const info = JSON.parse(readFileSync(path.join(directory, "BUILD-INFO.json"), "utf8"));
const source = sourceHash();
const dist = distHash(directory);
if (source !== info.sourceSha256 || dist !== info.distSha256) {
  if (source !== info.sourceSha256) console.error("FAIL sourceSha256 mismatch");
  if (dist !== info.distSha256) console.error("FAIL distSha256 mismatch");
  process.exitCode = 1;
} else {
  console.log("PASS sourceSha256 and distSha256 match BUILD-INFO.json");
}
