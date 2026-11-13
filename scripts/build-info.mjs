import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function filesIn(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesIn(file) : [file];
  });
}

function hashFiles(base, files) {
  const hash = createHash("sha256");
  const entries = files.map((file) => [path.relative(base, file).split(path.sep).join("/"), file]);
  entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  for (const [name, file] of entries) {
    const content = readFileSync(file);
    hash.update(`${Buffer.byteLength(name)}:${name}:${content.length}:`);
    hash.update(content);
  }
  return hash.digest("hex");
}

export function sourceHash() {
  const configPath = path.join(root, "tsconfig.build.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root, undefined, configPath);
  if (parsed.errors.length) throw new Error(ts.formatDiagnostics(parsed.errors, {
    getCanonicalFileName: (name) => name, getCurrentDirectory: () => root, getNewLine: () => "\n",
  }));
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const files = program.getSourceFiles().map((file) => path.resolve(file.fileName))
    .filter((file) => file.startsWith(`${path.join(root, "src")}${path.sep}`));
  files.push(path.join(root, "scripts", "claude-pool.mjs"));
  return hashFiles(root, files);
}

export function distHash(directory) {
  return hashFiles(directory, filesIn(directory).filter((file) => file !== path.join(directory, "BUILD-INFO.json")));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  copyFileSync(path.join(root, "scripts", "claude-pool.mjs"), path.join(root, "dist", "claude-pool.mjs"));
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const info = {
    name: pkg.name, version: pkg.version, commit: git("rev-parse", "HEAD"),
    dirty: Boolean(git("status", "--porcelain", "--untracked-files=normal")),
    sourceSha256: sourceHash(), distSha256: distHash(path.join(root, "dist")),
    node: process.version, typescript: ts.version, builtAt: new Date().toISOString(),
  };
  writeFileSync(path.join(root, "dist", "BUILD-INFO.json"), `${JSON.stringify(info, null, 2)}\n`);
}
