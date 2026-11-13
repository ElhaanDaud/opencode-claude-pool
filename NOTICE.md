# Notices

## This fork

This is `opencode-claude-pool`, a fork of
[dotCipher/opencode-claude-bridge](https://github.com/dotCipher/opencode-claude-bridge)
installed from source. The `opencode-claude-bridge` package on npm is the
upstream project and does not contain this fork's code (the account pool, the
OpenCode 2 entry, and later changes). Upstream declares MIT in its
`package.json` but ships no LICENSE file; this repository's [LICENSE](LICENSE)
carries the MIT terms with the upstream author's and this fork's copyright.

## Projects credited in the README

The README credits these projects for approaches combined in the original
bridge. Where code from them is included, their notices apply:

| Project | License | Copyright notice |
|---|---|---|
| [shahidshabbir-se/opencode-anthropic-oauth](https://github.com/shahidshabbir-se/opencode-anthropic-oauth) | MIT | Copyright (c) 2026 Shahid Shabbir |
| [ex-machina-co/opencode-anthropic-auth](https://github.com/ex-machina-co/opencode-anthropic-auth) | MIT | Copyright (c) 2026 Ex Machina |
| [lehdqlsl/opencode-claude-auth-sync](https://github.com/lehdqlsl/opencode-claude-auth-sync) | MIT | Copyright (c) 2026 lehdqlsl |
| [vinzabe/PERMANENT-opencode-anthropic-oauth-fix](https://github.com/vinzabe/PERMANENT-opencode-anthropic-oauth-fix) | none published | — |

The last project publishes no license, so no code may be copied from it;
only ideas can be borrowed. Check a project's license before copying anything
new from it (license files checked 13 November 2026).

## Anthropic material

- `src/claude-tools.ts` contains tool definitions (names, descriptions,
  schemas) captured from Claude Code's own requests. That text is Anthropic's
  and is not covered by this project's MIT license. On OpenCode 1 it is now
  only a fallback for a built-in tool that arrives without a schema; OpenCode 2
  still sends it. Review this before redistributing the package.
- `npm run validate:oauth -- --live` captures Claude Code's system prompt into a
  local cache (`~/.cache/opencode-claude-bridge/`). It is never committed or
  packaged; keep it that way.

## Use of a Claude subscription

Neither this license nor the bridge's request shaping grants permission to use
a Claude subscription from a third-party tool. See
[Support boundary](README.md#support-boundary) in the README.
