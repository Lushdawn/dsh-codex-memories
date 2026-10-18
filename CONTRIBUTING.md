# Contributing

Thanks for taking a look. This plugin is intentionally small and dependency-free, so most
changes stay inside a single `lib/` module.

## Local setup

There is nothing to install: the plugin has no runtime dependencies and the test harness runs
on Node 20+ alone.

```bash
git clone https://github.com/Lushdawn/dsh-codex-memories.git
cd dsh-codex-memories
npm run check   # syntax check every module
npm test        # offline end-to-end smoke test
```

`npm test` never touches a live DSH host or the network. It builds a mock Cordis context,
drives the real plugin through stage 1, stage 2, the tools and the `/memory` command, and
asserts on the Markdown artifacts it produces (under `tests/.test-home`, which is gitignored).

## Testing against a real host

The smoke test proves the pipeline, not the host contract. Before opening a PR that touches
registration (`ctx.systemPrompt`, `ctx.tools`, `ctx.commands`) or Cordis lifecycle, install
into a throwaway profile:

```bash
dsh plugin --profile verify add link:<absolute path to this checkout>
dsh --profile verify
# in the session: /memory status, then /memory extract, then /memory consolidate
dsh plugin --profile verify remove @lushdawn/dsh-codex-memories
```

## What to change where

| Area | File |
| --- | --- |
| Prompt wording, output schemas, extraction rules | `lib/prompts.js` |
| Markdown layout, `index.json` shape, atomic writes | `lib/store.js` |
| How session events become a transcript | `lib/render.js` |
| Model call plumbing and reply parsing | `lib/llm.js` |
| Tool parameters and search semantics | `lib/tools.js` |
| Registration, pipeline orchestration, `/memory` | `lib/index.js` |

## Prompt changes

The prompts are a reconstruction of Codex's memory system, including its strict output
schemas. If you change a schema, change the parser in `lib/llm.js` and the assertions in
`tests/smoke.mjs` in the same commit — a silent mismatch there corrupts stored memory rather
than throwing.

Keep these invariants unless you are deliberately changing behaviour:

- stage 1 may return a no-op (all three fields empty), and it must never write files then;
- `memory_summary.md` always starts with the line `v1`;
- the model may only append ad-hoc notes, never edit the handbook directly;
- phase 2 receives only the selected raw memories, not the whole archive.

## Style

- Plain ESM JavaScript, no TypeScript build step, no new dependencies without a strong reason.
- Keep the code comments explaining *why*, not what the line does.
- Follow the existing naming and file layout; `.editorconfig` covers whitespace.

## Reporting bugs

Open an issue with the template. For anything security-related, follow `SECURITY.md` instead of
opening a public issue.

## Release (maintainers)

```bash
# 1. update CHANGELOG.md and the version in package.json
npm run check && npm test
npm pack --dry-run        # confirm the file list
git commit -am "chore: release vX.Y.Z"
git tag vX.Y.Z && git push --follow-tags
npm publish --access public
```
