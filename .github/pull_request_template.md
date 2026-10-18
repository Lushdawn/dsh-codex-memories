Thanks for the contribution.

## What this changes

<!-- One or two sentences. Link the issue it closes, if any. -->

## Area

- [ ] Extraction (stage 1) prompt or parser
- [ ] Consolidation (stage 2) prompt or parser
- [ ] Prompt injection / usage guidance
- [ ] Tools
- [ ] `/memory` command
- [ ] Storage / `index.json`
- [ ] Docs or metadata only

## Checks

- [ ] `npm run check` passes
- [ ] `npm test` passes
- [ ] If a prompt schema changed, `lib/llm.js` parsing and `tests/smoke.mjs` assertions were updated in this commit
- [ ] If registration or lifecycle changed, I verified it against a throwaway DSH profile (describe below)
- [ ] No new runtime dependency (or the reason is stated below)

## Fidelity notes

<!--
Does this keep the stage-1 no-op gate, the `v1` summary schema, the ad-hoc-only write rule,
and the "phase 2 receives selected raw memories only" bound? If you changed one of them on
purpose, say which and why.
-->
