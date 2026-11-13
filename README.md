# opencode-claude-pool

Use your Claude Pro/Max subscription in [OpenCode](https://opencode.ai). If you're logged into the Claude CLI, it just works — no extra setup.

## Install

This fork is installed from source. The `opencode-claude-bridge` package on
npm is the upstream project and does not include the account pool.

### Install with AI

Copy this one line into your AI coding agent (OpenCode, Claude Code, Cursor and so on):

```
Follow the instructions at https://raw.githubusercontent.com/ElhaanDaud/opencode-claude-pool/main/INSTALL-AI.md to install opencode-claude-pool on this machine.
```

The agent checks your OpenCode version, builds `main` (one build serves both
OpenCode 1 and 2) and registers the entry that version loads. It edits your OpenCode config
in place after backing it up. Logging accounts in (`claude login`) stays with
you, because each login is interactive. The full instructions it follows are in
[INSTALL-AI.md](INSTALL-AI.md).

### OpenCode 1 (manual)

Check your version with `opencode --version`. For `1.x`:

**1. Clone and build**

```bash
git clone https://github.com/ElhaanDaud/opencode-claude-pool.git ~/src/opencode-claude-bridge
cd ~/src/opencode-claude-bridge && npm ci --ignore-scripts && npm run build
```

**2. Create a wrapper**

Don't point OpenCode at `dist/index.js` directly. The loader calls every named
export as a plugin factory, and this module exports helpers, so loading fails
with `modelId.match is not a function`. A wrapper that re-exports only the
default avoids that:

```bash
echo "export { default } from \"$HOME/src/opencode-claude-bridge/dist/index.js\";" \
  > ~/.config/opencode/claude-bridge-wrapper.mjs
```

**3. Register it** in `~/.config/opencode/opencode.json` (use your absolute home path):

```json
{
  "plugin": ["file:///Users/YOU/.config/opencode/claude-bridge-wrapper.mjs"]
}
```

Restart OpenCode. If you're logged into the Claude CLI (`claude login`), the plugin auto-syncs your credentials — just select an Anthropic model and start chatting. If not, you'll be prompted to authenticate via browser OAuth or enter an API key.

**Upgrade:**

```bash
cd ~/src/opencode-claude-bridge && git pull && npm ci --ignore-scripts && npm run build
```

Then restart OpenCode. Full walkthrough, Linux notes and troubleshooting: [SETUP.md](SETUP.md).

### OpenCode 2 (manual)

OpenCode 2 has a new plugin API and cannot load the V1 plugin, so it loads a
separate entry, `dist/opencode2`, from the same build. For `opencode --version` `2.x`:

**1. Clone and build**

```bash
git clone https://github.com/ElhaanDaud/opencode-claude-pool.git ~/src/opencode-claude-bridge
cd ~/src/opencode-claude-bridge && npm ci --ignore-scripts && npm run build
```

A checkout of the old `feat/opencode-2` branch can switch over:
`git checkout main && git pull && npm ci --ignore-scripts && npm run build`.

**2. Register the build directory** in `~/.config/opencode/opencode.json`. V2
uses the `plugins` key (plural) and only loads a local plugin from a directory,
so no wrapper is needed:

```json
{
  "plugins": ["file:///Users/YOU/src/opencode-claude-bridge/dist/opencode2"]
}
```

V1 and V2 read the same config file. Don't keep a V1 `plugin` entry for the
wrapper there: V2 migrates it and fails to load it.

**3. Restart OpenCode and check** that a prompt works:
`opencode run -m anthropic/claude-haiku-4-5-20251001 "Reply with exactly: OK"`.
On 2.1, `opencode plugin list` doesn't list directory plugins; `opencode run
--standalone --print-logs ...` shows a `loading plugin` line for
`dist/opencode2/server.js`.

**Credentials on V2**, in order: the pool; the "Claude Pro / Max (OAuth)" login
(`opencode auth login anthropic --method claude-pro-max`, a browser sign-in
that V2 stores and refreshes); then the Claude CLI login, read-only and never
refreshed. The V2 login is its own token chain, so refreshing it never logs
Claude Code out. V2 also imports OpenCode 1's login on first start; the bridge
never uses that copy, since nothing in V2 refreshes it and its refresh token is
still OpenCode 1's. When the Claude CLI login has expired and nothing else is
available, the request isn't sent and OpenCode shows how to log in again. An
Anthropic API key you configure in V2 takes precedence and is left alone. With
enrolled accounts or a Claude CLI login, the bridge turns V2's anthropic
provider on itself, so no key is needed; restart OpenCode after enrolling the
first account.

Enrollment, `claude-pool` and the pool itself are shared with V1, so
[Multi-account rotation](#multi-account-rotation) applies unchanged. The
request rewrite (bearer, Claude Code headers, billing block, system prompt,
thinking fields), pool rotation and Claude Code's tool definitions all work as
on V1, through V2's `http.request` and `http.response` hooks. What differs:

- Tools without a faithful Claude Code counterpart keep V2's own definition
  (`patch`, `execute`, MCP tools). Claude arguments V2 has no field for are
  dropped, e.g. Grep's `output_mode` and context lines, WebFetch's `prompt`.
- Pool toasts come from a separate TUI entry that watches the rotation state
  file, so a TUI attached to a remote server doesn't show them.
- When every account is cooling, the request isn't sent: OpenCode shows the
  pool's message and doesn't retry. Rotation that runs out of accounts
  mid-request ends the same way.
- V2 has no `auth.json`, so nothing is mirrored there.

**Upgrade:** `cd ~/src/opencode-claude-bridge && git pull && npm ci --ignore-scripts && npm run build`, then restart OpenCode.

### Uninstall and roll back

1. **Stop using it in OpenCode.** Remove the bridge's entry from your OpenCode config — the `plugin` entry for `claude-bridge-wrapper.mjs` (OpenCode 1) or the `plugins` entry for `dist/opencode2` (OpenCode 2) — or restore the backup you made before installing. Delete `~/.config/opencode/claude-bridge-wrapper.mjs`. Restart OpenCode.
2. **Remove the shell hook**, if you installed it: delete the `claude-pool` function that `install-hook` appended to `~/.zshrc` or `~/.bashrc`.
3. **Optionally remove the pool and its state.** `claude-pool remove <label>` for each account (or delete the `opencode-claude-bridge` Keychain items / `~/.local/share/opencode-claude-bridge/accounts/`), then `~/.local/share/opencode-claude-bridge/`. Any `*.stale` journal there may hold the only live token of a login; delete it only once you no longer need that login.
4. **OpenCode's own login** in `~/.local/share/opencode/auth.json` stays until you run `opencode auth logout`. Claude Code's login is untouched throughout.

To roll back to an earlier version instead: `git checkout <commit or tag> && npm ci --ignore-scripts && npm run build`, then restart OpenCode. Logins are not part of a rollback: a refresh token copied or backed up earlier has usually been spent since, so restoring it doesn't bring a login back. If a login stops working after a rollback, sign in again (`claude login`, then `claude-pool enroll`; or `opencode auth login`). Check what you are running with `npm run verify:build` and the `build …` line the plugin logs at startup.

## How the bridge works

The plugin sits between OpenCode and the Anthropic API:

> **OpenCode** -> **opencode-claude-bridge** -> **Anthropic API**

### Authentication

Supports both OAuth and API key auth:

- **OAuth (Pro/Max)** — Without a pool, OpenCode uses one of two logins, and each has exactly one refresher (see [Who refreshes which login](#who-refreshes-which-login)):
  - **Claude Code's login**, copied at startup from the Claude CLI (macOS Keychain, or `~/.claude/.credentials.json`). Read-only: Claude Code keeps refreshing it, and OpenCode follows its copy. Also selectable as the "Claude Code login (read-only)" method.
  - **A login of OpenCode's own**, from the "Claude Pro / Max (OAuth)" method (`opencode auth login`), a browser sign-in. Only the bridge refreshes it, so it never logs Claude Code out.
- **API key** — Log in with the "Claude API Key" method (`opencode auth login --provider anthropic --method "Claude API Key"`, or `/connect` in the TUI) and OpenCode stores the key and sends it as `x-api-key`. A stored key is never replaced by the Claude CLI login or an enrolled pool, and its requests go out exactly as OpenCode sends them, without the Claude Code rewrite. Log in with the OAuth method to switch back. A standard `provider` entry in your OpenCode config with an `apiKey` also works: the plugin only activates its OAuth handling for the built-in `anthropic` provider, so custom API key providers pass through unchanged.

### Who refreshes which login

Anthropic rotates the refresh token on every refresh and kills the old one at once, so two programs refreshing one login log each other out. Each login therefore has one owner:

| Login | Refreshed by | When its access token expires or is rejected |
|---|---|---|
| Claude Code's (copied from the CLI) | Claude Code only | OpenCode re-reads the CLI and uses its newer token; if the CLI's has expired too, the request fails saying to run `claude` once |
| OpenCode's own (browser sign-in) | the bridge only | refreshed under the shared cross-process lock, written to a journal before it is saved, re-read under the lock so two OpenCode processes spend it once. A save OpenCode refuses keeps the journal; however many refreshes happen while saves fail, the login stays OpenCode's own and its newest tokens are saved once storage works |
| An enrolled pool account | the pool only | see [Refresh tokens rotate](#refresh-tokens-rotate) |

- A login whose owner the bridge never recorded (one stored by an older version) is treated as a Claude Code copy: its refresh token may already be spent, and resending a spent token can look like token theft.
- OpenCode's own login never borrows Claude Code's token, even if Claude Code is logged into a valid account and OpenCode's is rejected; the request fails and says how to sign in again. Following the Claude CLI to whatever account it is logged into happens only for the Claude Code copy, and each request's `metadata.user_id` names the account whose token it carries.
- `claude-pool enroll` hands a login to the pool. Run `claude login` again afterwards so Claude Code has a chain of its own; `claude-pool` warns when the two still share one.
- Startup copies Claude Code's login into OpenCode's store, but never over a login of OpenCode's own.
- A cancelled request stops waiting at once; a refresh it already sent still finishes and is saved, since the old refresh token is spent the moment it is sent.

### Logout, disconnect and removal

- `opencode auth logout` (or disconnecting Anthropic) removes OpenCode's stored login only. A refresh still in flight when you log out, or switch to an API key, never writes its tokens over that: they are kept in a `.stale` file in `~/.local/share/opencode-claude-bridge/` instead. At the next start the bridge connects again from the Claude CLI login or the pool, if either is there. To stop OpenCode using your subscription, remove the plugin, or log the Claude CLI out and remove pooled accounts.
- `claude-pool remove <label>` (or `x` in the dashboard) deletes that account's stored tokens and rotation state, under the rotation lock. It does not revoke the login at Anthropic and does not touch Claude Code's own login or OpenCode's store.
- Logging out of the Claude CLI does not remove a copy OpenCode already holds; that copy works until it expires, and is then not refreshed.

### Wire-level request matching

Every outbound OAuth request is rewritten to match what Claude Code sends on the wire:

- **Headers** — `user-agent`, `anthropic-beta`, `anthropic-version`, `x-app`, `x-stainless-*`, `x-claude-code-session-id` and `anthropic-dangerous-direct-browser-access`; `x-api-key` is removed. The billing metadata (`cc_version`, `cc_entrypoint`, `cch`) is not a header: it is sent as the first system block (`x-anthropic-billing-header: …`).
- **Body fields** — `metadata` (session ID, billing info) and the `?beta=true` URL parameter; defaults for `thinking`, `output_config.effort` and `context_management` only where the caller set none (see [Model handling](#model-handling)).
- **System prompt** — the billing block and Claude Code's identity line lead. If a Claude Code prompt was captured with the validator (`~/.cache/opencode-claude-bridge/claude-system-prompt.json`), its sections that describe Claude Code follow; its `# Memory` and `# Session-specific guidance` sections are never sent, because they describe the session it was captured in (a memory directory under that project, that session's skills). A capture from a Claude Code version other than the installed one is still used, with a warning in the log to capture it again. OpenCode's own system blocks (agent prompt, AGENTS.md, instructions) follow, as OpenCode wrote them: the bridge no longer renames "OpenCode" in them.
- **Prompt caching** — OpenCode's own `cache_control` markers are kept where OpenCode put them. The capture's markers are dropped, and if a request still carries more than the API's limit of 4, markers on tools go first (any later marker caches the tools too), then the earliest message markers, then the earliest system ones.
- **Custom and MCP tools** — sent under the names OpenCode gives them, with OpenCode's own description and schema, after Claude Code's core tools. No prefix is added and their names are not translated in either direction: only OpenCode's built-in tools with a Claude Code counterpart are renamed (`bash` -> `Bash`), so a tool merely named like one, such as `mcp_bash`, keeps its name.

### Tools

Each of OpenCode's built-in tools that has a Claude Code counterpart goes out under the Claude Code name (`bash` -> `Bash`, `task` -> `Agent`, `question` -> `AskUserQuestion`, `plan_enter` -> `EnterPlanMode`, `plan_exit` -> `ExitPlanMode`, and `read`, `edit`, `write`, `glob`, `grep`, `webfetch`, `todowrite`, `skill`) but with the active tool's own definition: its description, its schema and every other field OpenCode sent, such as `eager_input_streaming`. That definition is what the tool behind it will actually do — OpenCode's `bash` has `workdir` and no background or sandbox switch, `webfetch` fetches a URL in a format rather than running an extraction prompt, `todowrite`'s `priority` is a priority, and with OhMyOpenCode, `task`, `skill` and `grep` list its categories, agents, skills and output modes. When the wire name differs by more than letter case, the description starts with one sentence naming the tool as the instructions call it (`task(...)` means `Agent`).

- Names are mapped per request and only for tools active in that request, so a custom or MCP tool keeps its name: one already called `Read`, or `mcp_bash`, is sent as is, and the built-in it collides with keeps its own name. The same mapping renames the tool's calls in history, a named `tool_choice`, and the model's calls in the response back to OpenCode's names.
- Arguments pass through as the schema the model was shown declares them, in both directions. Where a model uses a Claude Code name the host tool doesn't declare (`file_path` for `filePath`), it is renamed only if the host declares the other one; a field the host tool doesn't declare is dropped.
- A continuation call (`task_id`) is sent to the task tool as made: no agent is filled in, so it resumes with the agent it had.
- Only a built-in that arrives without a schema falls back to Claude Code's captured definition, minus any field the bridge would have to drop; its arguments are then translated between the two shapes.
- Custom and MCP tools are sent exactly as OpenCode gave them, after the built-ins. Both groups are sorted by name so the request prefix stays stable for prompt caching.
- For non-Claude models on OpenRouter-style targets, OpenCode's tools go out untouched. OpenCode 2 still sends Claude Code's definitions for its built-ins; see [OpenCode 2](#opencode-2-manual).

### Conversation repair

The API rejects a conversation where a tool call isn't answered by a result in the next turn, a result has no call in the turn before it, or results come after other content in a turn. A turn is every consecutive message from one role: the API merges them, so the bridge matches calls and results per turn too, and a user turn it repairs is sent as one message. Context compaction can leave one, and every later request in that session then fails. The bridge repairs only those: a missing result becomes an error result saying the bridge added it because no result is in the conversation; a result without its call becomes text that says so, with its content kept; results move to the front of their message. Assistant messages, including thinking blocks and their signatures, are never changed. A valid conversation is sent untouched, and each repair is logged.

A conversation that ends on an assistant message gets a user turn of `Continue.`, since the endpoint requires one. OpenCode's content-free `Continue with your tasks.` nudge is dropped instead. An assistant tail meant as a prefill is therefore answered afresh rather than continued.

### Model handling

The bridge ships a fallback catalog, used only for model IDs that OpenCode's own list is missing: Fable 5.1, Opus 5.5 / 4.6 / 4.5, Sonnet 5.5 / 5 / 4.6 / 4.5, Haiku 5.5 / 4.5. It also normalizes `thinking` for models that reject some modes:

- **Sonnet 5.5** rejects both `{type:"enabled", budget_tokens}` and `{type:"disabled"}`. `enabled` is rewritten to `adaptive`.
- **Haiku 5.5** rejects `{type:"enabled"}`, which is rewritten to `adaptive`.
- `temperature` is forced to `1` whenever thinking is enabled or adaptive, which the API requires.
- A forced `tool_choice` (`any`, or a named `tool`) can't be combined with thinking, so the forced tool wins: no thinking is injected, and the caller's `enabled` or `adaptive` thinking becomes `disabled`. A named tool is renamed to its Claude Code name. Sonnet 5.5 can't turn thinking off, so it drops a forced `tool_choice` instead and keeps thinking; `auto` and `none` still pass through. The log says so once per model, since the model may then answer without calling the tool.

Defaults apply only where the caller chose nothing: adaptive `thinking` on models that support it, `output_config.effort` of `medium` (`ANTHROPIC_DEFAULT_EFFORT`), and a `context_management` edit that clears old thinking, added only when thinking is on. A caller that set a temperature other than 1 keeps it and gets no default thinking, except on Sonnet 5.5, which always thinks. Every setting the bridge sets or changes is recorded with its reason (`default` or `compatibility`) in the [request trace](#request-trace).

### Dynamic fingerprint computation

The `cc_version` billing metadata suffix (a 3-character hex string like `df0` or `e0a`) is computed dynamically per request using the same algorithm as Claude Code:

```
SHA256(salt + text[4] + text[7] + text[20] + CLI_VERSION).slice(0, 3)
```

`text` is the first user message's text. Any index past the end of the text contributes `"0"`. The salt is hardcoded in Claude Code's source. The value changes per conversation because the first message changes.

## Multi-account rotation

> Setup (macOS and Linux), enrollment order and troubleshooting: **[SETUP.md](SETUP.md)**

A single Claude subscription has a rolling 5-hour window and a rolling 7-day
quota. When either is spent, every request fails until it resets. The account
pool lets you enroll several subscriptions and rotate to the next one
automatically when the active account's window is exhausted.

The pool is **opt-in**: with no accounts enrolled the plugin behaves exactly as
it did before.

### Enrolling accounts

Both the Claude CLI keychain and OpenCode's `auth.json` hold exactly one Claude
credential, so `claude login` overwrites whichever account was there before.
Enrollment captures the current account into the pool first, which makes the
sequence repeatable:

```bash
claude login          # as the first account
claude-pool enroll    # label is derived from the account's email

claude login          # as the second account
claude-pool enroll

claude-pool dashboard # confirm both are present
```

Pass a label explicitly to override the derived one: `claude-pool enroll work`.

### Automatic enrollment

Once at least one account is pooled, the plugin adopts newly logged-in accounts
on startup. For instant adoption without restarting OpenCode, install a shell
hook so `claude login` enrolls as it completes:

```bash
node scripts/claude-pool.mjs install-hook >> ~/.zshrc && source ~/.zshrc
```

Accounts are matched by refresh token, then by email, so re-logging into a
pooled account never duplicates it. A healthy entry keeps its own tokens, since
sharing one login with the Claude CLI logs one side out; an entry that rotation
has disabled, for example after its refresh was rejected, is repaired from the
newer login and re-enabled. Set `CLAUDE_POOL_AUTO_ENROLL=0` to disable.

### Commands

| Command | Purpose |
| --- | --- |
| `claude-pool enroll [label] [--replace]` | Add the account Claude CLI is logged into |
| `claude-pool auto` | Enroll the logged-in account if the pool has not seen it, or repair its disabled entry from a newer login. Does nothing while the pool is empty |
| `claude-pool install-hook` | Print a shell function that runs `auto` after `claude login` |
| `claude-pool whoami` | Show which account Claude CLI is logged into, and whether it is pooled |
| `claude-pool status` | Active account and what rotation would pick next |
| `claude-pool dashboard` | Interactive manager (prints the status when not in a terminal) |
| `claude-pool enable <label>` | Re-enable one account (clears its cooldown or disabled flag) |
| `claude-pool remove <label>` | Drop an account |
| `claude-pool clear-cooldowns` | Re-enable every account (clears all cooldowns and disabled flags) |
| `claude-pool help` | Show usage |

`claude-pool` is declared as a `bin` in `package.json`. From a source checkout,
either run `node scripts/claude-pool.mjs <command>` or install the shell hook
above, which defines a `claude-pool` function.

### Notifications

Pool events appear as OpenCode toasts: an account switch, an account added by
auto-enrollment, an account disabled (with the re-login hint), and every
account cooling down (with the earliest reset). Identical toasts are shown at
most once per minute.

### When rotation happens

Every failed response is classified before the response body is read:

| Signal | Action |
| --- | --- |
| `429` with a reset of 60s or less | Back off, retry the **same** account (up to 3 attempts within the wait budget below, then rotate) |
| `429` with a longer reset, or `anthropic-ratelimit-unified-status` not `allowed` | Cool the account down until its reset, switch accounts |
| `429` with no determinable reset | Cool down for 1 hour, switch |
| `403` Anthropic JSON error whose message says suspended / disabled / banned / deactivated / revoked | Disable the account, switch |
| Other `403`, including non-JSON block pages | Cool down for 1 hour, switch |
| `401` | Credential rejected even after refresh — disable, switch |
| `5xx` | Retry the same account with exponential backoff (1s, 2s, 4s), then pass through |
| Every account cooling | Fail fast as `429`, naming the cooling accounts soonest first with each one's wait (up to four, then a count) |

Retries in place share one 10s wait budget per request, across every account.
A retry that would overrun it is not slept: a `429` cools the account down until
its reset and rotates, a `5xx` passes through. A pool answering "retry in 60s"
everywhere therefore fails fast, and OpenCode's own retry, which shows the wait,
takes over.

**How many attempts one request can make.** Every retry the bridge makes in
place, with or without a pool, comes out of that one 10s wait budget, and what
the bridge finally returns is retried again by OpenCode itself, so the two
multiply:

- Without a pool, one call sends at most 4 requests: the first, one more after
  a rejected token is replaced, and up to 2 retries of a 429/529 that fit the
  budget. Three OpenCode attempts at a persistently overloaded API therefore
  send up to 9 (pinned by a test).
- With a pool, each account is retried in place only within the shared budget,
  gets one resend after its token is refreshed on a 401, and each account is
  tried at most once per call.
- Waiting for another process's token refresh holds a request for at most 10s
  and then returns a 503 that OpenCode retries; a refresh already sent is never
  abandoned, even when the request is cancelled.
- Every response that isn't returned is closed, and a cancelled request stops
  retrying at once.

The [request trace](#request-trace) records each call's `sends`, retries,
rotations and token refreshes (with the reason: expiry, rejection or a 429 near
expiry).

A 401/403 penalty is only applied once **another account succeeds** with the
same request. If the next account fails identically, the request is blamed and
neither account is penalised. If no other account is available, or the next
one is merely rate-limited, the error passes through unpenalised.

Reset windows are read from `retry-after`, then Anthropic's
`anthropic-ratelimit-unified-*` headers (epoch seconds), preferring whichever
window `representative-claim` reports as binding. When the unified status
rejects the account, the cooldown runs until that window resets even if
`retry-after` is shorter; a longer `retry-after` still wins. When no reset can be
determined the account is cooled rather than retried, because retrying a truly
exhausted account is worse than briefly parking a healthy one.

Rotation only occurs **before** the response body is read. Once SSE streaming
has begun a second stream cannot be spliced into the first, so mid-stream
errors are passed through untouched.

### Where credentials live

Accounts are stored one per macOS Keychain item under the service
`opencode-claude-bridge` (a `0600` file per account on other platforms). The
pool is the source of truth; OpenCode's single `anthropic` slot in `auth.json`
is a mirror of whichever account is currently active.

Rotation bookkeeping — active account, cooldowns, failure counts — lives
separately in `~/.local/share/opencode-claude-bridge/rotation-state.json` and
contains no secrets. It is written atomically and guarded by a cross-process
lock, so several OpenCode processes can share one pool safely.

### Refresh tokens rotate

Anthropic issues a **new** refresh token on every refresh and invalidates the
old one immediately, with no grace window. Losing the replacement permanently
locks you out of that account.

Refreshes therefore journal the new tokens to disk before committing them to
the keychain, and any journal found at startup is replayed (or renamed aside,
never deleted, if its account was since removed or re-enrolled). Concurrent
refreshes of one account collapse into a single call, since two parallel
refreshes would spend the same token twice. Across processes, refreshes are
serialised by the rotation lock. A stale lock is reclaimed only once its holder
is provably gone (same host: the PID no longer exists; other host: older than
3 minutes).

A refresh the token endpoint rejects disables the account. A network error or
5xx cools it down for 60 seconds instead, so a brief outage can't disable every
account in turn.

The practical consequence: **after the pool refreshes an account, the Claude
CLI's own stored copy of that credential is stale.** That is expected. Run
`claude-pool dashboard` rather than trusting the CLI's view.

### Recovery policies and their limits

These are deliberate choices, not guarantees:

- **Corrupt rotation state** is moved aside (`rotation-state.json.corrupt-<time>`) and the pool starts from defaults, so accounts that were disabled or cooling are tried again. A dead login fails its refresh again and is disabled again; an exhausted one gets a 429 and cools until its real reset. The cost is a few failed attempts, and no token is lost: the state file holds no credentials.
- **A lost token response can't be recovered.** If the network drops after Anthropic has rotated a refresh token but before its reply arrives, the old token is spent and the new one never reached this machine. Journals cover everything after the reply arrives, not that gap; that login needs a new sign-in.
- **A save the journal couldn't cover** — the journal write itself fails — still saves the tokens, logging the failure, since skipping the save would drop the only valid ones. A journal that can't be moved aside stops further refreshes of that login rather than overwrite it.
- **Writes are read-compare-write, not atomic swaps.** Every writer in this package takes the rotation lock, and a refresh re-reads the stored login before saving: one replaced meanwhile (another `opencode auth login`, a hand edit) is kept and the refresh's tokens are set aside in a `.stale` file. A writer that doesn't take the lock can still land in the instant between that check and the save.
- **The lock is a local-machine lock.** On one host a stale lock is reclaimed only once its holder's process is gone. On a shared or network filesystem a holder on another host can't be checked, so its lock is reclaimed by age (3 minutes); don't share the pool's directory between machines that refresh at the same time. The lock does not coordinate an unmodified Claude Code, which is why its login is never refreshed here.
- **Releasing the lock** removes it only if it still holds this process's id, so a lock reclaimed and taken over by another process is never removed by the old holder.

### Trusted destinations

The bridge sends your subscription login only to `https://api.anthropic.com`. A provider `baseURL` pointing elsewhere (a proxy, a gateway) gets a 400 naming the setting instead, and nothing is sent. To allow one you trust, list its origin:

```bash
export ANTHROPIC_TRUSTED_ORIGINS="https://llm-proxy.internal.example"   # comma- or space-separated
```

Requests that carry the login never follow redirects: a redirect is handed back to OpenCode as the response, so it can't carry the login to another host. API-key requests are sent by OpenCode itself and are unaffected.

### Request trace

Set `ANTHROPIC_TRACE_PATH=/path/to/trace.jsonl` to append one JSON line per OAuth request: the build that served it (version, commit, source hash), OpenCode's session id (which links a parent session to the subagents it starts), the route, model, which login served it (pool label, or `single` with its owner), the thinking/effort/temperature/tool_choice/context settings actually sent, every setting the bridge set or changed with its reason, any conversation repair, the retries, rotations and token refreshes it took (with why) and how many requests it sent, the tool names, the status and the time taken. It holds no tokens and no prompt text. If the file can't be written, requests carry on and the log says so once.

The trace shows what was sent, not how well the model did. Comparing quality between API-key and subscription use needs the same model, settings and tasks on both — see `scripts/qa-opencode1.mjs` under [Local validation](#local-validation) for the offline half of that.

## Requirements

- [OpenCode](https://opencode.ai) v1.2+, or v2 (tested on 2.1.0 and 2.1.2; see [OpenCode 2](#opencode-2-manual))
- For OAuth: [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) installed and logged in (`claude login`)
- macOS (Keychain) or Linux (`~/.claude/.credentials.json` fallback)
- For API key: just configure a `provider` with `apiKey` in your OpenCode config as usual

## Environment overrides

All OAuth and header parameters can be overridden via environment variables:

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_CLIENT_ID` | `9d1c250a-...` | OAuth client ID |
| `ANTHROPIC_TOKEN_URL` | `https://platform.claude.com/v1/oauth/token` | Token endpoint |
| `ANTHROPIC_AUTHORIZE_URL` | `https://claude.ai/oauth/authorize` | Authorization endpoint |
| `ANTHROPIC_CLI_VERSION` | Auto-detected from `claude --version` or `2.1.98` | Claude CLI version string |
| `ANTHROPIC_CLI_BUILD_ID` | `835` | Build ID for headers |
| `ANTHROPIC_ENTRYPOINT` | `sdk-cli` | Entrypoint value for billing |
| `ANTHROPIC_SDK_VERSION` | `0.94.0` | Stainless SDK version |
| `ANTHROPIC_BETA_FLAGS` | Current Claude Code beta flags | Comma-separated beta feature flags |
| `ANTHROPIC_BILLING_CCH` | (computed) | Client attestation hash override |
| `ANTHROPIC_SYSTEM_PROMPT_PATH` | `~/.cache/opencode-claude-bridge/claude-system-prompt.json` | Path to cached system prompt |
| `ANTHROPIC_DEFAULT_EFFORT` | `medium` | Thinking effort level |
| `ANTHROPIC_SESSION_ID` | (generated) | Override session ID |
| `ANTHROPIC_USER_AGENT` | `claude-cli/<version> (external, <entrypoint>)` | Full user-agent override |
| `ANTHROPIC_PROFILE_URL` | `https://api.anthropic.com/api/oauth/profile` | Account profile endpoint (email lookup) |
| `ANTHROPIC_USAGE_URL` | `https://api.anthropic.com/api/oauth/usage` | Usage endpoint (dashboard) |
| `ANTHROPIC_MANUAL_REDIRECT_URL` | `https://platform.claude.com/oauth/code/callback` | Redirect for copy-paste OAuth |
| `ANTHROPIC_SCOPES` | Claude CLI's full scope set | OAuth scopes |
| `ANTHROPIC_CLEAR_THINKING_TYPE` | `clear_thinking_20251015` | `context_management` edit type |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Where the Claude CLI credential file lives (Linux) |
| `CLAUDE_POOL_AUTO_ENROLL` | enabled | Set to `0` to disable auto-enrollment on startup |
| `CLAUDE_POOL_ACCOUNTS_DIR` | unset | Store accounts as 0600 files in this directory on any platform instead of the keychain (testing) |
| `CLAUDE_POOL_STATE_PATH` | `~/.local/share/opencode-claude-bridge/rotation-state.json` | Rotation state file (the lock stays at the default path) |
| `ANTHROPIC_TRUSTED_ORIGINS` | unset | Extra origins (e.g. a proxy) allowed to receive the subscription login; `https://api.anthropic.com` always is |
| `ANTHROPIC_TRACE_PATH` | unset | Append a per-request JSON trace (no tokens or prompt text) to this file |

Most users won't need to change these. The bridge detects the installed Claude CLI version, re-checks it every 10 minutes since Claude Code auto-updates, and uses matching defaults.

## Local validation

### What the tests do and don't show

`npm test` builds into `build/test` (never into the package's `dist/`) and
reports its results by kind of evidence, with what it leaves out:

| Class | What it is | How to run | Last run (13 Nov 2026) |
|---|---|---|---|
| fixture | in-process unit tests on fixed inputs | `npm test` | 305/305 |
| injected-boundary | fake servers, stubbed `security`, fault injection at one boundary | `npm test` | 294/294 |
| process | real child processes racing on real lock, journal and store files | `npm test` | 64/64 |
| native | the pool's macOS Keychain backend against a temporary keychain it creates and deletes | `npm run test:native` | 2/2 |
| real host | OpenCode 1.18.30 + OhMyOpenCode 4.19.4 against a fake API, API key vs OAuth: skills, commands, grep, bash, read, MCP, category/subagent/background/continuation tasks, invalid input | `node scripts/qa-opencode1.mjs` | 36/36 |
| real host, OpenCode 2 | the V2 entry under a real OpenCode 2 | `node scripts/qa-opencode2.mjs --bin …` | **not run**: no OpenCode 2.x build was available from npm |
| other platforms | Linux; Windows | — | **not run**: no Docker daemon here; no Windows host |
| Bun | the stream translator under standalone Bun 1.4.4 | (ad hoc driver) | 5/5, and the stream tests 8/8 under `bun test` |
| live provider | real Anthropic requests with your logins | the `--live` tools below | not part of any test run |
| quality | whether the model does better or worse through the bridge | — | **none exist**: nothing here measures model quality |

Green totals cover only the first four classes. They say the code does what
its tests describe against fakes, not that Anthropic accepts the requests, nor
anything about answer quality.

### Scripts and what they touch

| Script | Credentials | Tokens | Inference | Prompts | Safe offline |
|---|---|---|---|---|---|
| `npm test` | fake only (temp HOME) | — | — | — | yes |
| `npm run test:native` | a temporary macOS keychain it creates and deletes | — | — | — | yes (macOS) |
| `node scripts/qa-opencode1.mjs` | fake only (temp HOME, stubbed `security`) | — | fake API | — | yes |
| `node scripts/qa-opencode2.mjs` | fake only | — | fake API | — | yes |
| `node scripts/qa-rotation.mjs --live` | **your pool accounts** | **may refresh them** | **one real request** | — | no |
| `npm run validate:oauth -- --live …` | **your Claude Code and OpenCode logins** | — | **real requests** | **captures Claude Code's prompt** | no |
| `./scripts/intercept-claude.sh --live` | **your Claude Code login** | — | **a real request** | **saves its prompt to /tmp** | no |

The live tools refuse to start without `--live`. Their output can contain
prompts, file contents and account details, and the bridge's log names your
account labels: read anything before you share it. Tokens are never written to
logs, captures or traces on purpose, but no tool checks every byte it prints.

To validate how local OpenCode traffic is being classified and how closely it matches Claude Code on the wire (live: see the table above):

```bash
npm run validate:oauth -- --live --model claude-sonnet-4-6 --prompt "Reply with exactly VALIDATE."
```

The validator will:

- Query the OAuth usage endpoint before and after each run
- Capture an official Claude Code request through a local proxy
- Capture an OpenCode request using this repo's local `dist/index.js`
- Write Claude Code's captured system prompt to `~/.cache/opencode-claude-bridge/claude-system-prompt.json` (or `ANTHROPIC_SYSTEM_PROMPT_PATH`, if set)
- Save request and response artifacts under `tmp/validate-*`
- Write a `report.json` with request diffs, body hashes, and usage snapshots

After the first successful validator run, the bridge will automatically reuse that cached Claude Code system prompt. This is currently the key step that makes OpenCode traffic behave like standard Claude Code usage.

If OpenCode is being treated as an OAuth app / extra-usage flow, the report will usually show it in one of two ways:

- The OpenCode run fails with an extra-usage style API error
- The usage buckets diverge from the Claude Code run even when the headers look similar

To check the OpenCode 1 plugin end to end without touching your accounts:

```bash
npm run build && node scripts/qa-opencode1.mjs
```

It runs the real `opencode` (1.x) with this build and, if installed, OhMyOpenCode against a local fake Anthropic API in a throwaway environment (its own HOME, config, pool and a stand-in for the macOS `security` tool), after checking that the plugin can see only fake credentials. The same scripted workload runs twice — on a stored API key, which the bridge passes through, and on the OAuth path — and drives skill, grep, bash, read, a subagent and a continuation of it through OpenCode's own tools. It reports PASS/FAIL for each, checks that the OAuth tools carry the host's own schemas and fields, and writes the requests both runs sent, parent and subagent separately, to a JSON report (`--out`).

To check the OpenCode 2 plugin end to end without touching your accounts:

```bash
npm run build && node scripts/qa-opencode2.mjs --bin "$(command -v opencode)"
```

It runs the real OpenCode 2 binary against a local fake Anthropic API in a
throwaway environment (its own HOME, config and pool), so it never reaches your
keychain or anthropic.com, and reports PASS/FAIL per scenario: plugin load,
request rewrite, tool translation, rotation and the exhausted pool.

## Updating for new Claude CLI versions

When Claude Code updates, the required headers or body fields may change. To capture exactly what the latest Claude CLI sends:

```bash
./scripts/intercept-claude.sh --live claude-sonnet-4-6
```

This starts a local proxy, runs Claude CLI through it with OAuth, and saves the request headers (credentials redacted) and body to a private `/tmp/claude-intercept.XXXXXX/` directory. Compare against the plugin's constants and fetch wrapper to spot differences.

Key things that have changed across versions:

- `anthropic-beta` flags (required set changes)
- Body fields (`thinking`, `metadata`, `context_management`)
- `user-agent` version string
- `x-stainless-package-version`
- `x-claude-code-session-id`
- Billing header shape (`cc_version`, `cc_entrypoint`, `cch`)
- Tool definitions and parameter schemas

## Architecture

```
src/
  index.ts           — Plugin entry: model catalog, tool replacement, request/response
                       transformation, thinking normalization, pool rotation loop
  claude-tools.ts    — 26 Claude Code tool definitions (10 shared + 16 stubs),
                       fingerprint computation, parameter translation
  stream.ts          — SSE rewriting: buffers tool_use input per block, translates names/args
  constants.ts       — CLI version detection, URLs, env overrides, header values
  keychain.ts        — Claude CLI credential read (macOS Keychain / credentials file)
  oauth.ts           — OAuth PKCE flow and token refresh
  single-account.ts  — Who owns the non-pool login; its one refresh path (lock, journal)
  request-policy.ts  — Setting-change log, cache markers, captured-prompt sections,
                       trusted destinations, request trace
  history.ts         — Repairs tool call/result pairing the API would reject
  opencode2/
    server.ts        — OpenCode 2 server plugin: request rewrite, rotation, V2 login method
    tools.ts         — V2 tools <-> Claude Code tool definitions, both directions
    tui.ts           — OpenCode 2 TUI plugin: pool toasts from the rotation state file
  pool/
    manager.ts       — Account acquisition, refresh with journal + in-flight dedupe
    rotation-state.ts — Rotation state file and cross-process lock
    classifier.ts    — Maps failed responses to retry / cooldown / disable decisions
    selection.ts     — Picks the next usable account
    secret-store.ts  — Per-account credential storage (Keychain or 0600 files)
    enroll.ts        — Enrollment and auto-adoption of new logins
    bridge.ts        — Wires the pool into the plugin (mirror into auth.json)
    usage.ts         — OAuth usage endpoint client
    notify.ts        — Deduplicated OpenCode toasts
    dashboard.ts, tui.ts — `claude-pool dashboard` interactive manager
    types.ts         — Shared pool types

scripts/
  claude-pool.mjs             — `claude-pool` CLI (bin entry)
  qa-rotation.mjs             — End-to-end rotation scenarios (real API + local fake upstream)
  run-tests.mjs               — npm test: runs the compiled tests by evidence class, lists exclusions
  build-info.mjs, verify-build.mjs — dist/BUILD-INFO.json (source and output hashes) and its check
  check-package.mjs           — fails if the npm package holds tests or anything outside dist/
  qa-opencode1.mjs            — Real OpenCode 1 (+ OhMyOpenCode) against a local fake Anthropic API,
                                API key vs OAuth on one workload
  qa-opencode2.mjs            — Real OpenCode 2 binary against a local fake Anthropic API
  validate-opencode-oauth.js  — Side-by-side wire comparison tool
  intercept-claude.sh         — mitmproxy-based Claude CLI request capture
```

Tests live next to their sources (`*.test.ts`) and run with `npm test`, which
builds first and runs everything under `dist/` with `node --test`.

## Support boundary

Anthropic's supported way for a third-party tool to use Claude is an API key or
a supported cloud provider; its help center and Claude Code's legal and
compliance page say so, and say that routing third-party traffic through a
subscription is not what subscription plans are for. This bridge makes OpenCode
requests look like Claude Code's to use a Claude Pro/Max subscription. Neither
this project's MIT license nor how closely its requests match Claude Code's
gives permission to do that, and Anthropic can classify, limit or refuse such
traffic at any time. If you need a supported setup, log in with the "Claude API
Key" method: those requests go out exactly as OpenCode sends them.

Before more work goes into matching Claude Code's wire format, decide which of
the two you are building for. This project's direction is to keep OpenCode's
and OhMyOpenCode's own behaviour authoritative and prove it through the real
host, not to chase wire similarity.

## Trying another bridge

Switching to a different OpenCode–Claude bridge is reversible only if it is
done as a trial:

1. Pin the exact OpenCode, OhMyOpenCode and bridge versions (no `@latest`, no
   moving branch) and use a separate HOME/XDG profile for the trial.
2. Give the trial its own login. A refresh token copied from this pool or from
   Claude Code is not independent: whichever side refreshes first logs the
   other out. Never run two bridges that refresh the same login.
3. Check what you need from this one: the pool, its quota-aware rotation and
   dashboard, OhMyOpenCode's task/skill/continuation behaviour, and any
   custom/MCP tools. `scripts/qa-opencode1.mjs` shows how to exercise the
   latter through the real host offline.
4. Stop the trial on any account crossover (a request served by an account it
   wasn't meant to use), any refresh failure or race, or any tool, skill or
   continuation regression.
5. To roll back, stop the trial's refresher first, restore the pinned versions
   and configuration, and sign in again if a login's chain moved on. Restoring
   an older backup of a refresh token is not a rollback; it has usually been
   spent.

## Credits

Combines approaches from [shahidshabbir-se/opencode-anthropic-oauth](https://github.com/shahidshabbir-se/opencode-anthropic-oauth), [ex-machina-co/opencode-anthropic-auth](https://github.com/ex-machina-co/opencode-anthropic-auth), [vinzabe/PERMANENT-opencode-anthropic-oauth-fix](https://github.com/vinzabe/PERMANENT-opencode-anthropic-oauth-fix), and [lehdqlsl/opencode-claude-auth-sync](https://github.com/lehdqlsl/opencode-claude-auth-sync).

## License

MIT — see [LICENSE](LICENSE). This is a source-installed fork; the
`opencode-claude-bridge` package on npm is the upstream project. Third-party
notices, and the Anthropic material this repository contains, are listed in
[NOTICE.md](NOTICE.md).
