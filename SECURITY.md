# Security Policy

## Scope

This plugin runs inside the DSH Host with the permissions of the user running DSH. Treat these
surfaces as security-relevant:

- **Filesystem writes.** The plugin writes only under its memory root (`$DSH_HOME/memories` by
  default, or `storageDir` from the plugin config). It must never write outside that root, and
  `memory_read` must never follow a path that escapes it.
- **Data exfiltration into prompts.** Session transcripts are sent to the configured model
  provider during extraction. Memory content is injected into every turn's context.
- **Stored memory content.** Memory files are plain Markdown and may capture quoted user text.
  Secrets should be redacted by the extraction prompt, but treat the memory root as sensitive.
- **Model-driven writes.** The model can only append ad-hoc notes; it cannot rewrite the
  handbook. A change that grants broader write access is a security-relevant change.

## Reporting a vulnerability

Do not open a public issue. Use GitHub's private reporting:

https://github.com/Lushdawn/dsh-codex-memories/security/advisories/new

Please include the version, the DSH version, and a minimal reproduction. You can expect an
initial response within a week.

## Supported versions

Only the latest published minor receives fixes.

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |
| < 0.1 | No |
