# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-10-18

### Added

- `author`, `scripts` (`test`, `check`) and `sideEffects` metadata in `package.json`.
- `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `.editorconfig`.
- GitHub Actions CI running the offline smoke test and syntax checks.
- Issue and pull-request templates.

## [0.1.0] - 2026-10-18

### Added

- Initial release.
- Stage 1 extraction per session into `raw_memory` plus a structured session summary.
- Stage 2 consolidation into `MEMORY.md` and `memory_summary.md` (strict `v1` schema).
- Prompt-injected memory summary with decision boundary, quick memory pass and citation format.
- Model tools: `memory_search`, `memory_read`, `memory_list`, `memory_note`.
- `/memory` command: `status`, `show`, `extract`, `backfill`, `consolidate`, `forget`, `on`, `off`.
- Automatic extraction after an idle window, plus a boot-time backfill over stored sessions.
- Durable storage as plain Markdown with an `index.json` extraction cache.
