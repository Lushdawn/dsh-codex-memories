/**
 * Model-facing memory tools: `memory_search`, `memory_read`, `memory_list`, `memory_note`.
 *
 * The first three mirror the Codex memory extension's search/read/list surface (including
 * `match_mode` and `context_lines`), and `memory_note` is the write-a-note-only path: the
 * model may never edit the handbook directly, exactly as Codex restricts updates to
 * `extensions/ad_hoc/notes/`.
 *
 * @module dsh-codex-memories/tools
 */

import { SEARCHABLE_ROOTS } from './store.js'

const MAX_MATCHES = 200
const MAX_FILE_BYTES = 2_000_000
const MAX_READ_LINES = 400

const MATCH_MODES = ['any', 'all', 'on_same_line']

/** Render plain text as one content block array. */
function text(content) {
  return [{ type: 'text', text: content }]
}

/** Resolve the store-relative files a search may touch. */
async function searchableFiles(store, filename) {
  const files = []
  for (const root of SEARCHABLE_ROOTS) {
    if (root.endsWith('.md')) {
      if (await store.exists(root)) files.push(root)
      continue
    }
    for (const relative of await store.listSessionSummaries()) files.push(relative)
  }
  if (typeof filename === 'string' && filename.trim().length > 0) {
    const needle = filename.trim().toLowerCase()
    return files.filter(file => file.toLowerCase().includes(needle))
  }
  return files
}

/** Count how many distinct queries occur in a line. */
function queriesInLine(line, queries, caseSensitive) {
  const haystack = caseSensitive ? line : line.toLowerCase()
  let hits = 0
  for (const query of queries) {
    const needle = caseSensitive ? query : query.toLowerCase()
    if (haystack.includes(needle)) hits += 1
  }
  return hits
}

/**
 * Search the memory folder.
 *
 * `match_mode`:
 * - `any` (default): a line matching any query is a hit.
 * - `all`: only files where every query matched at least once contribute their hits.
 * - `on_same_line`: a line must contain every query.
 */
export async function searchMemories(store, args) {
  const queries = Array.isArray(args?.queries)
    ? args.queries.map(value => String(value ?? '').trim()).filter(Boolean)
    : []
  if (queries.length === 0) throw new Error('queries must be a non-empty array of strings')

  const mode = MATCH_MODES.includes(args?.match_mode) ? args.match_mode : 'any'
  const caseSensitive = args?.case_sensitive === true
  const contextLines = Number.isInteger(args?.context_lines) ? Math.max(0, Math.min(6, args.context_lines)) : 0
  const files = await searchableFiles(store, args?.filename)

  const results = []
  let total = 0
  let truncated = false

  for (const relative of files) {
    const content = await store.read(relative)
    if (content === undefined) continue
    if (content.length > MAX_FILE_BYTES) continue
    const lines = content.split(/\r?\n/)

    const hits = []
    const matchedQueries = new Set()
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      const count = queriesInLine(line, queries, caseSensitive)
      if (count === 0) continue
      if (mode === 'on_same_line' && count < queries.length) continue
      for (const query of queries) {
        if ((caseSensitive ? line : line.toLowerCase()).includes(caseSensitive ? query : query.toLowerCase())) {
          matchedQueries.add(query)
        }
      }
      const start = Math.max(0, index - contextLines)
      const end = Math.min(lines.length - 1, index + contextLines)
      const hit = {
        line: index + 1,
        text: line.length > 400 ? `${line.slice(0, 400)}…` : line,
        start: start + 1,
        end: end + 1,
      }
      // Only present when requested: DSH tool results are lossless JSON, where `undefined`
      // is not a value.
      if (contextLines > 0) hit.context = lines.slice(start, end + 1)
      hits.push(hit)
    }

    if (hits.length === 0) continue
    if (mode === 'all' && matchedQueries.size < queries.length) continue

    total += hits.length
    if (total > MAX_MATCHES) {
      truncated = true
      hits.splice(Math.max(0, hits.length - (total - MAX_MATCHES)))
      if (hits.length === 0) break
    }
    results.push({ path: relative, matches: hits })
    if (total >= MAX_MATCHES) break
  }

  return { files: results, total, truncated, queries, match_mode: mode }
}

/** Read one memory file by line range. Paths are store-relative. */
export async function readMemoryFile(store, args) {
  const relative = String(args?.path ?? '').trim().replace(/^\.\//, '')
  if (!relative) throw new Error('path is required')
  if (relative.includes('..')) throw new Error('path must stay inside the memory root')

  const content = await store.read(relative)
  if (content === undefined) throw new Error(`no memory file at ${relative}`)
  if (content.length > MAX_FILE_BYTES) throw new Error(`${relative} is too large to read whole`)

  const lines = content.split(/\r?\n/)
  const start = Number.isInteger(args?.start_line) ? Math.max(1, args.start_line) : 1
  const requestedEnd = Number.isInteger(args?.end_line) ? args.end_line : start + MAX_READ_LINES - 1
  const end = Math.max(start, Math.min(lines.length, requestedEnd, start + MAX_READ_LINES - 1))

  return {
    path: relative,
    start_line: start,
    end_line: end,
    total_lines: lines.length,
    truncated: end < requestedEnd || end < lines.length,
    lines: lines.slice(start - 1, end).map((line, offset) => ({ number: start + offset, text: line })),
  }
}

/** List the memory folder inventory with sizes and freshness. */
export async function listMemoryFiles(store) {
  const groups = [
    { name: 'handbook', files: ['MEMORY.md', 'memory_summary.md', 'raw_memories.md'] },
    { name: 'session_summaries', files: await store.listSessionSummaries() },
    { name: 'ad_hoc_notes', files: await store.listNotes() },
  ]

  const entries = []
  for (const group of groups) {
    for (const relative of group.files) {
      if (!(await store.exists(relative))) continue
      const content = (await store.read(relative)) ?? ''
      entries.push({
        path: relative,
        group: group.name,
        bytes: Buffer.byteLength(content, 'utf8'),
        lines: content.length === 0 ? 0 : content.split(/\r?\n/).length,
      })
    }
  }

  const index = await store.readIndex()
  return {
    root: store.root,
    entries,
    sessions_extracted: Object.keys(index.sessions).length,
    pending_consolidation: Object.values(index.sessions).filter(record => record?.selectedForPhase2).length,
    last_consolidated_at: index.progress.lastConsolidatedAt || 0,
  }
}

/** Append one ad-hoc note; the only write path the model is offered. */
export async function addAdHocNote(store, args) {
  const note = String(args?.note ?? '').trim()
  if (!note) throw new Error('note must be a non-empty string')
  const relative = await store.writeNote(note)
  return { path: relative, bytes: Buffer.byteLength(note, 'utf8') }
}

/** Build the four tool definitions for `ctx.tools.register`. */
export function memoryTools(store, options = {}) {
  const enabled = options.enabled !== false

  const search = {
    name: 'memory_search',
    description:
      'Search the memory folder (MEMORY.md, memory_summary.md, raw_memories.md and session summaries) '
      + 'for line-level matches. Returns file-relative paths with line numbers so results can be cited '
      + 'as <file>:<start>-<end>|note=[...]. Use this first in a quick memory pass.',
    parameters: {
      type: 'object',
      properties: {
        queries: {
          type: 'array',
          items: { type: 'string' },
          description: 'One or more search strings. Case sensitivity follows case_sensitive.',
        },
        match_mode: {
          type: 'string',
          enum: MATCH_MODES,
          description: 'any = a line matching any query; all = only files where every query matched; on_same_line = a line must contain every query.',
        },
        context_lines: {
          type: 'integer',
          description: 'Include this many lines of context around each match (0-6).',
        },
        case_sensitive: { type: 'boolean', description: 'Match case-sensitively.' },
        filename: { type: 'string', description: 'Only search files whose store-relative path contains this substring.' },
      },
      required: ['queries'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          files: { type: 'array', items: { type: 'object' } },
          total: { type: 'integer' },
          truncated: { type: 'boolean' },
        },
      },
      render(_args, value) {
        const found = value?.files ?? []
        if (found.length === 0) return text('No memory matches.')
        const lines = []
        for (const file of found) {
          lines.push(`## ${file.path}`)
          for (const match of file.matches ?? []) {
            lines.push(`${match.line}: ${match.text}`)
          }
          lines.push('')
        }
        if (value?.truncated) lines.push('[truncated]')
        return text(lines.join('\n').trimEnd())
      },
    },
    async execute(args) {
      return searchMemories(store, args)
    },
  }

  const read = {
    name: 'memory_read',
    description:
      'Read a memory file by store-relative path and inclusive line range. Use after memory_search '
      + 'points at a specific file, or to open MEMORY.md regions and session summaries.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Store-relative path, for example MEMORY.md or session_summaries/<slug>.md.' },
        start_line: { type: 'integer', description: 'First line, 1-based. Defaults to 1.' },
        end_line: { type: 'integer', description: 'Last line, inclusive. Defaults to start_line + 399.' },
      },
      required: ['path'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          start_line: { type: 'integer' },
          end_line: { type: 'integer' },
          total_lines: { type: 'integer' },
          truncated: { type: 'boolean' },
        },
      },
      render(_args, value) {
        const body = (value?.lines ?? []).map(line => `${line.number}: ${line.text}`).join('\n')
        const header = `${value?.path}:${value?.start_line}-${value?.end_line} of ${value?.total_lines}`
        return text(`${header}\n\n${body}`)
      },
    },
    async execute(args) {
      return readMemoryFile(store, args)
    },
  }

  const list = {
    name: 'memory_list',
    description:
      'List the memory folder inventory: the handbook files, every session summary, ad-hoc notes, and '
      + 'pending consolidation state. Use to orient before opening files.',
    parameters: {
      type: 'object',
      properties: {},
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          root: { type: 'string' },
          entries: { type: 'array', items: { type: 'object' } },
          sessions_extracted: { type: 'integer' },
          pending_consolidation: { type: 'integer' },
        },
      },
      render(_args, value) {
        const lines = [`Memory root: ${value?.root ?? '(unknown)'}`, '']
        for (const entry of value?.entries ?? []) {
          lines.push(`- ${entry.path} (${entry.bytes}B, ${entry.lines} lines)`)
        }
        lines.push('')
        lines.push(`sessions extracted: ${value?.sessions_extracted ?? 0}`)
        lines.push(`pending consolidation: ${value?.pending_consolidation ?? 0}`)
        return text(lines.join('\n'))
      },
    },
    async execute() {
      return listMemoryFiles(store)
    },
  }

  const note = {
    name: 'memory_note',
    description:
      'Append one ad-hoc memory note under extensions/ad_hoc/notes/. This is the ONLY way to update '
      + 'memories, and it must be used only when the user explicitly asks to remember, correct, or '
      + 'forget something. Never claim a note was consolidated; consolidation happens later.',
    parameters: {
      type: 'object',
      properties: {
        note: {
          type: 'string',
          description: 'The note body: what to remember, correct, or forget, and why (cite the user wording).',
        },
      },
      required: ['note'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          bytes: { type: 'integer' },
        },
      },
      render(_args, value) {
        return text(`Wrote ${value?.path ?? 'note'} (${value?.bytes ?? 0} bytes). It will be consolidated on the next /memory consolidate.`)
      },
    },
    async execute(args) {
      return addAdHocNote(store, args)
    },
  }

  return enabled ? [search, read, list, note] : [search, read, list]
}
