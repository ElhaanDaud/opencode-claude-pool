import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The npm installed beside this Node, not the first on PATH: a version manager's shim needs the real HOME.
const npmCli = realpathSync(path.join(path.dirname(process.execPath), "npm"));
// npm reads the proxy variables in any letter case.
const passThrough = new Set(["http_proxy", "https_proxy", "proxy", "no_proxy", "node_extra_ca_certs"]);
const scratch = mkdtempSync(path.join(os.tmpdir(), "opencode-claude-bridge-deps-"));
try {
  const userconfig = path.join(scratch, "user.npmrc");
  const globalconfig = path.join(scratch, "global.npmrc");
  writeFileSync(userconfig, "");
  writeFileSync(globalconfig, "");
  const env = { PATH: process.env.PATH, HOME: scratch, TMPDIR: os.tmpdir() };
  for (const [key, value] of Object.entries(process.env)) {
    if (passThrough.has(key.toLowerCase())) env[key] = value;
  }
  const result = spawnSync(process.execPath, [npmCli, "ci", "--ignore-scripts", "--no-audit", "--no-fund", "--no-update-notifier",
    "--userconfig", userconfig, "--globalconfig", globalconfig, "--cache", path.join(scratch, "cache")],
  { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
