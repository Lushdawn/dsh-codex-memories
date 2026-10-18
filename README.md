# dsh-codex-memories

Codex-style **long-term memory** for DSH: cross-session memory that ingests finished sessions, consolidates them into a searchable handbook, and injects a compact summary before every turn.

It reproduces the two-stage structure of the Codex memory system rather than approximating it: per-session extraction first, then a consolidation pass over many raw memories.

## Why

DSH sessions are isolated by default. A correction you made yesterday, a command that only works in one repo, a symptom/cause/fix you already paid for — none of it carries over unless you restate it. This plugin makes the agent remember:

- how you want it to work, without being told twice
- where the truth lives in a specific repo, and which commands actually run
- which failure has which fix

## How it works

```
session goes idle for N seconds
   └─ Stage 1  one model call per session -> session_summaries/<slug>.md + raw_memories.md
        └─ Stage 2  once enough memory accumulates -> MEMORY.md + memory_summary.md
             └─ before each turn, memory_summary.md is injected into the prompt
```

All durable artifacts are plain Markdown you can read, edit, version, or move. `index.json` holds the extraction cache, job records, and the consolidation watermark.

## Install

```bash
dsh plugin --profile web add @lushdawn/dsh-codex-memories
```

Local development:

```bash
dsh plugin --profile web add link:<absolute path to this directory>
```

Restart DSH, or let a live profile hot-load it.

## Commands

| Command | Effect |
| --- | --- |
| `/memory status` | memory root, extracted sessions, pending consolidation, last timestamps |
| `/memory show` | print the current `memory_summary.md` |
| `/memory extract` | extract the current session immediately |
| `/memory backfill` | scan stored sessions and extract the ones never processed |
| `/memory consolidate` | merge pending memory into `MEMORY.md` now |
| `/memory forget <sessionId\|all>` | drop extraction records (handbook content is kept) |
| `/memory on` / `off` | toggle automatic extraction for this process |

## Tools

Exposed to the model when `dedicatedTools` is on:

| Tool | Effect |
| --- | --- |
| `memory_search` | line-level keyword search across memory files (`any` / `all` / `on_same_line`) |
| `memory_read` | read one memory file by line range |
| `memory_list` | inventory of the memory folder and pending work |
| `memory_note` | append one ad-hoc note — the only write path the model is offered |

The model is instructed to cite memory as `MEMORY.md:12-14|note=[...]`.

## Configuration

Every field has a safe default; override in your profile patch:

```yaml
- insert:
    - id: dsh-codex-memories
      name: dsh-codex-memories
      config:
        storageDir: ''            # default $DSH_HOME/memories
        generate: true
        use: true
        dedicatedTools: true
        model: ''                 # e.g. deepseek-official/deepseek-flash
        extractModel: ''          # falls back to model
        consolidationModel: ''    # falls back to model
        idleSeconds: 120
        maxSessionsPerRun: 3
        maxSessionAgeDays: 30
        consolidationThreshold: 2
        maxInjectChars: 9000
        minSessionMessages: 4
        extractMaxTokens: 8000
        consolidateMaxTokens: 16000
```

When `model` is empty the plugin reads the current default model, then falls back to `deepseek-official/deepseek-flash`.

## Data layout

```
$DSH_HOME/memories/
├── MEMORY.md                    # durable handbook, Task Group organized
├── memory_summary.md            # prompt-loaded layer; first line must be v1
├── raw_memories.md              # mechanical stage-1 merge, ascending session id
├── session_summaries/<slug>.md  # one structured recap per session
├── extensions/ad_hoc/notes/     # notes written by you or the model
└── index.json                   # extraction cache, job records, watermark
```

## Cost and privacy

- **It spends tokens**: one Stage-1 call per session and one Stage-2 call per consolidation. Sessions under 4 messages are skipped; at most 3 sessions are processed per sweep.
- **Local files only**: no network access beyond the model API it calls.
- **It enters your prompt**: `memory_summary.md` is injected every turn, which is why it is capped by `maxInjectChars`.
- **Auditable**: every artifact is readable Markdown.
- **The model cannot rewrite the handbook**: it may only append ad-hoc notes; consolidation is a separate pass, so one turn cannot corrupt durable memory.

## Fidelity to Codex

The behavioral spec comes from reverse engineering Codex itself — the on-disk shape under `~/.codex/memories` plus the prompt templates embedded in `codex.exe`:

| Codex | dsh-codex-memories |
| --- | --- |
| `~/.codex/memories/` | `$DSH_HOME/memories/` |
| `MEMORY.md` / `memory_summary.md` / `raw_memories.md` | same names, same formats |
| `rollout_summaries/*.md` | `session_summaries/*.md` |
| `memories_1.sqlite` | `index.json` |
| Stage 1 extraction prompt | `PHASE1_TEMPLATE` in `lib/prompts.js` |
| Phase 2 consolidation prompt | `PHASE2_TEMPLATE` in `lib/prompts.js` |
| usage guidance + citation format | `USAGE_TEMPLATE` in `lib/prompts.js` |
| rollout scan backfill | `/memory backfill` + boot sweep |

See [docs/mechanism.md](docs/mechanism.md) for the full mechanism and the evidence behind it.

## Known limits

- Stage 2 asks for two complete documents in one reply. On a very large handbook the reply can hit the output cap; the old files are then kept and the pass reports an error instead of writing something corrupt.
- Automatic extraction needs the process alive during the idle window; otherwise the next boot's `backfill` catches up.
- Retrieval is keyword/line based, not semantic — the same tradeoff Codex makes. Route with `keywords` in `MEMORY.md`.

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). For anything
security-related, follow [SECURITY.md](SECURITY.md) instead of opening a public issue. Release
history lives in [CHANGELOG.md](CHANGELOG.md).

## License

MIT
