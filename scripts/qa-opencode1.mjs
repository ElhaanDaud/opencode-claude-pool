#!/usr/bin/env node
// Credential-free acceptance test for the real OpenCode 1 host.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = { dist: path.join(repo, 'dist'), omo: 'file:///Users/apple/.config/opencode/omo-gpt61-4.19.4/dist/index.js', mode: 'both', out: path.join(os.tmpdir(), 'qa-opencode1-report.json'), keep: false, userPlugins: false };
const usage = 'Usage: node scripts/qa-opencode1.mjs [--dist <absolute-dir>] [--omo <file-url> | --no-omo] [--mode oauth|apikey|both] [--out <file>] [--keep] [--with-user-plugins]';
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--help' || arg === '-h') { console.log(usage); process.exit(0); }
  if (arg === '--keep') options.keep = true;
  else if (arg === '--with-user-plugins') options.userPlugins = true;
  else if (arg === '--no-omo') options.omo = null;
  else if (['--dist', '--omo', '--mode', '--out'].includes(arg) && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) options[arg.slice(2)] = process.argv[++i];
  else { console.error(`Invalid argument: ${arg}\n${usage}`); process.exit(2); }
}
if (!path.isAbsolute(options.dist) || !['oauth', 'apikey', 'both'].includes(options.mode) || (options.omo && !options.omo.startsWith('file:'))) {
  console.error(usage); process.exit(2);
}
const model = 'anthropic/claude-sonnet-4-6';
const names = { task: 'Agent', skill: 'Skill', grep: 'Grep', bash: 'Bash', read: 'Read', write: 'Write', edit: 'Edit', glob: 'Glob', webfetch: 'WebFetch', question: 'AskUserQuestion', todowrite: 'TodoWrite', plan_enter: 'EnterPlanMode', plan_exit: 'ExitPlanMode' };
const marker = 'QA-BASH-4817';
const checks = [];
let interrupted = false;
let stopActive = () => {};
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = true; stopActive(); });
const check = (name, ok, detail = '') => { checks.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`); };
const jsonWrite = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
const blocks = (body) => (body?.messages ?? []).flatMap((m) => Array.isArray(m.content) ? m.content : []);
const text = (value) => typeof value === 'string' ? value : JSON.stringify(value ?? '');
const resultFor = (body, id) => blocks(body).find((b) => b.type === 'tool_result' && b.tool_use_id === id);
const sessionIn = (r) => text(r?.content).match(/<task_metadata>[\s\S]*?session_id:\s*(ses_[\w-]+)[\s\S]*?<\/task_metadata>/)?.[1];
const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;
function stream(modelId, content) {
  let out = sse('message_start', { message: { id: 'msg_qa', type: 'message', role: 'assistant', model: modelId, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  content.forEach((b, index) => {
    out += sse('content_block_start', { index, content_block: b.type === 'text' ? { type: 'text', text: '' } : { type: 'tool_use', id: b.id, name: b.name, input: {} } });
    out += sse('content_block_delta', { index, delta: b.type === 'text' ? { type: 'text_delta', text: b.text } : { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    out += sse('content_block_stop', { index });
  });
  return out + sse('message_delta', { delta: { stop_reason: content[0]?.type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }) + sse('message_stop', {});
}
function inputs(tool, candidates) {
  const props = tool?.input_schema?.properties ?? {};
  return Object.fromEntries(Object.entries(candidates).filter(([key]) => Object.hasOwn(props, key)));
}
function callTool(body, key, id, candidates) {
  const tool = (body.tools ?? []).find((t) => t.name === key || t.name === names[key]);
  if (!tool) throw new Error(`Tool ${key} was not declared`);
  return { type: 'tool_use', id, name: tool.name, input: inputs(tool, candidates) };
}
function describe(req) {
  const b = req.body ?? {};
  const system = typeof b.system === 'string' ? [{ text: b.system }] : (b.system ?? []);
  const positions = [];
  function walk(value, location) {
    if (!value || typeof value !== 'object') return;
    if (value.cache_control !== undefined) positions.push({ path: location, value: value.cache_control });
    for (const [k, v] of Object.entries(value)) if (k !== 'cache_control') walk(v, `${location}.${k}`);
  }
  for (const key of ['tools', 'system', 'messages']) walk(b[key], key);
  return { role: req.role, session_id: req.headers['x-session-id'] ?? null, route: req.url, model: b.model ?? null, thinking: b.thinking ?? null, output_config: b.output_config ?? null, temperature: b.temperature ?? null, context_management: b.context_management ?? null, system_count: system.length, system: system.map((s) => (s.text ?? '').slice(0, 60)), cache_control: positions, tool_count: (b.tools ?? []).length, tools: (b.tools ?? []).map((t) => t.name) };
}
function diff(a, b) {
  if (!a || !b) return { unavailable: true };
  const pick = (r) => ({ route: new URL(r.url, 'http://fake').pathname + new URL(r.url, 'http://fake').search, model: r.body.model, settings: Object.fromEntries(['thinking', 'output_config', 'temperature', 'context_management'].map((k) => [k, r.body[k] ?? null])), system: describe(r).system, tools: (r.body.tools ?? []).map((t) => t.name) });
  const left = pick(a), right = pick(b);
  return Object.fromEntries(Object.keys(left).map((key) => [key, { equal: isDeepStrictEqual(left[key], right[key]), oauth: left[key], apikey: right[key] }]));
}

async function runMode(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `qa-oc1-${mode}-`));
  const home = path.join(root, 'home'), work = path.join(root, 'work'), stub = path.join(root, 'stub');
  const config = path.join(home, '.config'), cache = path.join(home, '.cache'), data = path.join(home, '.local', 'share');
  let server, child;
  const requests = [], sockets = new Set();
  const recorded = { mode, root: options.keep ? root : null, requests, summaries: [], output: '', trace: null };
  let parentId, stage = 0;
  try {
    for (const dir of [work, stub, path.join(config, 'opencode'), path.join(cache, 'opencode'), path.join(data, 'opencode'), path.join(home, '.claude'), path.join(home, 'pool')]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(stub, 'security'), '#!/bin/sh\necho "not found" >&2\nexit 44\n', { mode: 0o755 });
    const catalog = path.join(os.homedir(), '.cache', 'opencode', 'models.json');
    if (!fs.existsSync(catalog)) throw new Error(`Missing local model catalog: ${catalog}`);
    fs.copyFileSync(catalog, path.join(cache, 'opencode', 'models.json'));
    const git = spawnSync('git', ['init', '-q', work], { encoding: 'utf8' });
    if (git.status !== 0) throw new Error(`git init: ${git.stderr}`);
    const target = path.join(work, 'needle.txt');
    fs.writeFileSync(target, 'the needle is here\n');
    fs.mkdirSync(path.join(home, '.omo'), { recursive: true });
    jsonWrite(path.join(home, '.omo', 'omo.jsonc'), { categories: { quick: { model } } });
    const mcp = path.join(home, 'qa-mcp.mjs'), mcpLog = path.join(home, 'mcp-calls.jsonl');
    fs.writeFileSync(mcp, `import readline from 'node:readline';\nimport fs from 'node:fs';\nreadline.createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);if(q.id===undefined)return;let result;if(q.method==='initialize')result={protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'qa',version:'1'}};else if(q.method==='tools/list')result={tools:[{name:'echo',description:'Echo QA input',inputSchema:{type:'object',properties:{message:{type:'string'},file_path:{type:'string'}},required:['message','file_path']}}]};else if(q.method==='tools/call'){fs.appendFileSync(${JSON.stringify(mcpLog)},JSON.stringify(q.params.arguments)+'\\n');result={content:[{type:'text',text:JSON.stringify(q.params.arguments)}]};}else result={};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');});\n`);
    const access = `fake-access-${mode}`, refresh = `fake-refresh-${mode}`, expires = Date.now() + 36e6;
    jsonWrite(path.join(home, '.claude', '.credentials.json'), { claudeAiOauth: { accessToken: access, refreshToken: refresh, expiresAt: expires, scopes: ['user:inference'], subscriptionType: 'max' } });
    server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString();
          let body = null; try { body = JSON.parse(raw); } catch {}
          const entry = { method: req.method, url: req.url, headers: req.headers, body, role: 'other' };
          requests.push(entry);
          if (!new URL(req.url, 'http://fake').pathname.endsWith('/messages')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(req.url.includes('token') ? { access_token: 'fake-access-refreshed', refresh_token: 'fake-refresh-refreshed', expires_in: 3600 } : req.url.includes('usage') ? { five_hour: { utilization: 1, resets_at: new Date(Date.now() + 3600000).toISOString() } } : { account: { uuid: 'fake', email: 'fake@example.invalid' }, organization: { uuid: 'fake' } })); return;
          }
          const lastUser = [...(body?.messages ?? [])].reverse().find((m) => m.role === 'user');
          const first = text(lastUser?.content).includes('QA-PROBE') && !(Array.isArray(lastUser?.content) && lastUser.content.some((b) => b.type === 'tool_result'));
          if (!parentId && first && (body?.tools?.length ?? 0)) parentId = req.headers['x-session-id'] ?? '(header absent)';
          const hasProbe = (body?.messages ?? []).some((m) => m.role === 'user' && text(m.content).includes('QA-PROBE'));
          const isParent = Boolean(parentId && (parentId === '(header absent)' ? hasProbe && body?.tools?.length : req.headers['x-session-id'] === parentId));
          entry.role = isParent ? 'parent' : parentId && body?.tools?.length ? 'child' : 'other';
          let content = [{ type: 'text', text: entry.role === 'child' ? 'OK' : 'QA-DONE' }];
          if (isParent && stage === 0) {
            stage++;
            content = [
              callTool(body, 'skill', 'toolu_skill', { name: 'git-master' }),
              callTool(body, 'grep', 'toolu_grep', { pattern: 'needle', path: work, output_mode: 'content', head_limit: 5 }),
              callTool(body, 'bash', 'toolu_bash', { command: `echo ${marker}`, description: 'Print QA marker' }),
              callTool(body, 'read', 'toolu_read', { filePath: target, file_path: target }),
              callTool(body, 'task', 'toolu_task', { description: 'QA exploration', subagent_type: 'explore', load_skills: [], run_in_background: false, prompt: 'Reply with exactly: OK' }),
            ];
          } else if (isParent && stage === 1) {
            stage++;
            const id = sessionIn(resultFor(body, 'toolu_task'));
            if (id) content = [callTool(body, 'task', 'toolu_continue', { task_id: id, prompt: 'Reply with exactly: OK' })];
          } else if (isParent && stage === 2) {
            stage++;
            const skill = (body.tools ?? []).find((t) => t.name === 'skill' || t.name === 'Skill');
            const command = text(skill?.description).match(/<name>\/(init-deep)<\/name>/)?.[1] ?? 'qa-command-not-listed';
            content = [
              callTool(body, 'task', 'toolu_category', { description: 'QA category', category: 'quick', load_skills: [], run_in_background: false, prompt: 'Reply with exactly: OK' }),
              callTool(body, 'task', 'toolu_background', { description: 'QA background', subagent_type: 'explore', load_skills: [], run_in_background: true, prompt: 'Reply with exactly: OK' }),
              callTool(body, 'task', 'toolu_invalid_task', { description: 'QA invalid', load_skills: [], run_in_background: false, prompt: 'Reply with exactly: OK' }),
              callTool(body, 'skill', 'toolu_command', { name: command }),
              callTool(body, 'skill', 'toolu_invalid_skill', { name: 'qa-skill-does-not-exist-4817' }),
              callTool(body, 'qa_echo', 'toolu_mcp', { message: 'QA-MCP-4817', file_path: 'keep-this-exactly' }),
            ];
          } else if (isParent && stage === 3) {
            stage++;
            const id = text(resultFor(body, 'toolu_background')?.content).match(/\bbg_[\w-]+/)?.[0];
            if (id) content = [callTool(body, 'background_output', 'toolu_collect', { task_id: id, block: true, timeout: 15000 })];
          }
          const modelId = body?.model ?? 'claude-sonnet-4-6';
          const reply = () => {
            if (body?.stream === false) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'msg_qa', type: 'message', role: 'assistant', model: modelId, content, stop_reason: content[0].type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } })); }
            else { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); res.end(stream(modelId, content)); }
          };
          // OMO holds a child session for 2 s after it dispatches a prompt, and a
          // real model takes longer than that to answer; an instant fake doesn't.
          if (content.some((block) => block.id === 'toolu_continue')) setTimeout(reply, 3000);
          else reply();
        } catch (error) { recorded.serverError = String(error?.stack ?? error); res.writeHead(500); res.end('fake server error'); }
      });
    });
    server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const url = `http://127.0.0.1:${server.address().port}`;
    const env = { PATH: `${stub}${path.delimiter}${process.env.PATH ?? ''}`, HOME: home, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: cache, XDG_DATA_HOME: data, TERM: 'dumb', CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CLAUDE_POOL_ACCOUNTS_DIR: path.join(home, 'pool'), CLAUDE_POOL_STATE_PATH: path.join(home, 'state.json'), CLAUDE_POOL_AUTO_ENROLL: '0', ANTHROPIC_TOKEN_URL: `${url}/token`, ANTHROPIC_PROFILE_URL: `${url}/profile`, ANTHROPIC_USAGE_URL: `${url}/usage`, ANTHROPIC_TRUSTED_ORIGINS: url, ANTHROPIC_TRACE_PATH: path.join(home, 'trace.jsonl') };
    const mod = (p) => JSON.stringify(pathToFileURL(path.join(options.dist, p)).href);
    const preflight = `import {readClaudeCredentials} from ${mod('keychain.js')}; import {createAccountStore,createSecretBackend} from ${mod('pool/secret-store.js')}; import {defaultLockPath,defaultStatePath} from ${mod('pool/rotation-state.js')}; import {defaultJournalPath} from ${mod('pool/manager.js')}; console.log(JSON.stringify({token:readClaudeCredentials()?.claudeAiOauth?.accessToken,labels:await createAccountStore(createSecretBackend()).listLabels(),paths:[defaultLockPath(),defaultStatePath(),defaultJournalPath()]}));`;
    const pf = spawnSync(process.execPath, ['--input-type=module', '-e', preflight], { env, encoding: 'utf8', timeout: 30000 });
    let seen; try { seen = JSON.parse(pf.stdout.trim().split('\n').at(-1)); } catch {}
    const safe = pf.status === 0 && seen?.token === access && Array.isArray(seen.labels) && seen.labels.length === 0 && seen.paths?.length === 3 && seen.paths.every((p) => path.isAbsolute(p) && path.relative(home, p) !== '' && !path.relative(home, p).startsWith('..') && !path.isAbsolute(path.relative(home, p)));
    check(`${mode} preflight`, safe, safe ? 'fake login, empty pool, paths isolated' : `SAFETY STOP: ${pf.stderr.trim() || 'unexpected credentials, pool, or paths'}`);
    if (!safe) return recorded;
    const wrapper = path.join(config, 'opencode', 'wrapper.mjs');
    fs.writeFileSync(wrapper, `export { default } from ${JSON.stringify(pathToFileURL(path.join(options.dist, 'index.js')).href)};\n`);
    const extra = options.userPlugins ? ['file:///Users/apple/.config/opencode/cursor-auth-wrapper.mjs', 'opencode-kiro@0.4.0'] : [];
    if (options.userPlugins) {
      const source = '/Users/apple/.cache/opencode/packages/opencode-kiro@0.4.0';
      const dest = path.join(cache, 'opencode', 'packages', 'opencode-kiro@0.4.0');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(source, dest, { recursive: true });
    }
    jsonWrite(path.join(config, 'opencode', 'opencode.json'), { autoupdate: false, plugin: [pathToFileURL(wrapper).href, ...(options.omo ? [options.omo] : []), ...extra], mcp: { qa: { type: 'local', command: [process.execPath, mcp] } }, model, provider: { anthropic: { options: { baseURL: `${url}/v1` } } } });
    jsonWrite(path.join(data, 'opencode', 'auth.json'), { anthropic: mode === 'oauth' ? { type: 'oauth', access, refresh, expires } : { type: 'api', key: 'sk-ant-fake-qa' } });
    const run = await new Promise((resolve) => {
      child = spawn('opencode', ['run', ...(options.userPlugins ? ['--print-logs', '--log-level', 'DEBUG'] : []), '-m', model, 'QA-PROBE: execute the requested test.'], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      stopActive = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } };
      let output = '', timedOut = false;
      child.stdout.on('data', (c) => { output += c; }); child.stderr.on('data', (c) => { output += c; });
      const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 140000);
      child.on('error', (error) => { clearTimeout(timer); resolve({ output: output + String(error), code: null, timedOut }); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ output, code, timedOut }); });
    });
    recorded.output = run.output; recorded.exitCode = run.code; recorded.timedOut = run.timedOut;
    if (fs.existsSync(env.ANTHROPIC_TRACE_PATH)) recorded.trace = fs.readFileSync(env.ANTHROPIC_TRACE_PATH, 'utf8');
    const parent = requests.filter((r) => r.role === 'parent');
    check(`${mode} host`, run.code === 0 && !run.timedOut && parent.length > 0, `exit=${run.code}, timeout=${run.timedOut}, parent requests=${parent.length}${recorded.serverError ? `, server=${recorded.serverError}` : ''}`);
    const history = parent.at(-1)?.body;
    for (const [key, expected] of [['skill', /git/i], ['grep', /the needle is here/], ['bash', new RegExp(marker)], ['read', /the needle is here/], ['task', /\bOK\b/], ['continue', /\bOK\b/]]) {
      const result = resultFor(history, `toolu_${key}`);
      let ok = result && !result.is_error && expected.test(text(result.content));
      if (key === 'task') ok = ok && Boolean(sessionIn(result));
      if (key === 'continue') ok = ok && Boolean(sessionIn(result)) && sessionIn(result) === sessionIn(resultFor(history, 'toolu_task'));
      check(`${mode} ${key}`, ok, result ? text(result.content).slice(0, 160).replace(/\s+/g, ' ') : 'missing tool_result');
    }
    for (const [key, expected] of [['category', /Sisyphus-Junior[\s\S]*\bOK\b/i], ['background', /\bbg_[\w-]+/], ['collect', /\bOK\b/], ['command', /(?:skill|command).*init-deep/i], ['invalid_skill', /Skill or command "qa-skill-does-not-exist-4817" not found/i], ['invalid_task', /Invalid arguments: Must provide either category or subagent_type/i], ['mcp', /QA-MCP-4817/]]) {
      const result = resultFor(history, `toolu_${key}`);
      check(`${mode} ${key}`, result && expected.test(text(result.content)) && (key !== 'command' || !/not found/i.test(text(result.content))), result ? text(result.content).slice(0, 200).replace(/\s+/g, ' ') : 'missing tool_result');
    }
    const mcpArgs = fs.existsSync(mcpLog) ? fs.readFileSync(mcpLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
    check(`${mode} mcp arguments`, mcpArgs.some((args) => isDeepStrictEqual(args, { message: 'QA-MCP-4817', file_path: 'keep-this-exactly' })), JSON.stringify(mcpArgs));
    recorded.scenarios = Object.fromEntries(['skill', 'grep', 'bash', 'read', 'task', 'continue', 'category', 'background', 'collect', 'command', 'invalid_skill', 'invalid_task', 'mcp'].map((key) => {
      const result = resultFor(history, `toolu_${key}`);
      const session = sessionIn(result) ?? text(result?.content).match(/Session ID:\s*(ses_[\w-]+)/)?.[1];
      const childRequest = requests.find((r) => r.role === 'child' && r.headers['x-session-id'] === session);
      return [key, { parent: parent[0] ? { session_id: parent[0].headers['x-session-id'] ?? null, model: parent[0].body.model } : null, child: childRequest ? { session_id: session, model: childRequest.body.model } : null }];
    }));
    if (options.userPlugins) recorded.userPlugins = { configured: extra, loadStatus: 'unknown: host emitted no per-plugin load confirmation', anthropicRegistration: 'unknown: host did not expose per-plugin provider registration', output: run.output.split('\n').filter((line) => /cursor-auth|opencode-kiro|plugin.*anthropic/i.test(line)).slice(0, 80) };
    if (mode === 'oauth') {
      const errors = [];
      for (const req of requests.filter((r) => r.body?.messages && r.body?.tools?.length)) {
        const declared = new Set((req.body.tools ?? []).map((t) => t.name));
        for (const b of blocks(req.body)) if (b.type === 'tool_use' && !declared.has(b.name)) errors.push(b.name);
        if (req.body.tool_choice?.name && !declared.has(req.body.tool_choice.name)) errors.push(`choice:${req.body.tool_choice.name}`);
      }
      check('oauth history names declared', parent.length > 0 && errors.length === 0, errors.join(', '));
    }
    recorded.summaries = requests.map(describe);
    return recorded;
  } catch (error) {
    recorded.error = String(error?.stack ?? error); check(`${mode} harness`, false, recorded.error); return recorded;
  } finally {
    stopActive = () => {};
    if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    if (server?.listening) { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); }
    if (!options.keep) fs.rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  const modes = options.mode === 'both' ? ['apikey', 'oauth'] : [options.mode];
  const results = {};
  for (const mode of modes) { if (interrupted) break; results[mode] = await runMode(mode); }
  const parent = (mode) => results[mode]?.requests.find((r) => r.role === 'parent');
  const child = (mode) => results[mode]?.requests.find((r) => r.role === 'child');
  if (options.mode === 'both') {
    const api = parent('apikey'), oauth = parent('oauth');
    const wireTools = oauth?.body?.tools ?? [];
    const hostTools = api?.body?.tools ?? [];
    const schemaErrors = [], fieldErrors = [];
    for (const host of hostTools) {
      const wire = wireTools.find((t) => t.name === (names[host.name] ?? host.name));
      if (!wire || !isDeepStrictEqual(wire.input_schema, host.input_schema)) schemaErrors.push(host.name);
      if (!wire) fieldErrors.push(`${host.name}:missing`);
      else for (const key of Object.keys(host)) if (!(key in wire)) fieldErrors.push(`${host.name}.${key}`);
    }
    check('oauth native schemas', Boolean(api && oauth && hostTools.length && !schemaErrors.length), schemaErrors.join(', ') || (!api || !oauth ? 'missing parent request' : 'all host schemas match'));
    check('oauth tool fields preserved', Boolean(api && oauth && hostTools.length && !fieldErrors.length), fieldErrors.join(', ') || (!api || !oauth ? 'missing parent request' : 'all host fields present'));
    const apiMcp = hostTools.find((t) => t.name === 'qa_echo'), oauthMcp = wireTools.find((t) => t.name === 'qa_echo');
    check('oauth mcp definition unchanged', Boolean(apiMcp && oauthMcp && isDeepStrictEqual(apiMcp, oauthMcp)), apiMcp && oauthMcp ? 'all fields compared' : 'missing MCP definition');
  }
  const report = { options, checks, modes: results, diff: { parent: diff(parent('oauth'), parent('apikey')), child: diff(child('oauth'), child('apikey')) } };
  fs.writeFileSync(path.resolve(options.out), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(`DIFF  parent/child recorded in ${path.resolve(options.out)}`);
  console.log(`${checks.filter((c) => c.ok).length} passed; ${checks.filter((c) => !c.ok).length} failed`);
  process.exitCode = interrupted || checks.some((c) => !c.ok) ? 1 : 0;
}
main().catch((error) => { console.error(error); process.exitCode = 2; });
