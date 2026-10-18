/**
 * File-based memory store.
 *
 * Layout (under the configured root, default `$DSH_HOME/memories`):
 *
 *   MEMORY.md                    durable handbook (durable retrieval layer)
 *   memory_summary.md            prompt-loaded compact layer, first line must be `v1`
 *   raw_memories.md              mechanical merge of stage-1 raw memories
 *   session_summaries/<slug>.md  one structured recap per session
 *   extensions/ad_hoc/notes/     user-authored notes, consolidated by phase 2
 *   index.json                   stage-1 cache, job records, consolidation watermark
 *   .git/                        optional; created only when git is available
 *
 * Codex keeps the same shape in `~/.codex/memories` with a sqlite index. DSH carries no
 * sqlite dependency, so `index.json` plays that role: the durable artifacts stay plain
 * Markdown and remain hand-editable.
 *
 * @module dsh-codex-memories/store
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { AD_HOC_INSTRUCTIONS } from './prompts.js'

export const MEMORY_FILE = 'MEMORY.md'
export const SUMMARY_FILE = 'memory_summary.md'
export const RAW_FILE = 'raw_memories.md'
export const INDEX_FILE = 'index.json'
export const SUMMARIES_DIR = 'session_summaries'
export const EXTENSIONS_DIR = 'extensions'
export const AD_HOC_DIR = 'extensions/ad_hoc'
export const NOTES_DIR = 'extensions/ad_hoc/notes'

/** Files the search tool is allowed to scan, in retrieval priority order. */
export const SEARCHABLE_ROOTS = [MEMORY_FILE, SUMMARY_FILE, RAW_FILE, SUMMARIES_DIR]

const INITIAL_MEMORY = `# Task Group: (no memories yet)

scope: empty handbook. Populate it with the \`/memory consolidate\` command after a few sessions.
applies_to: cwd=unknown; reuse_rule=none yet
`

const INITIAL_SUMMARY = `v1

## User Profile

No profile yet.

## User preferences

## General Tips

## What's in Memory

### Older Memory Topics
`

const INITIAL_RAW = `# Raw Memories

Merged stage-1 raw memories (stable ascending thread-id order):
`

/** A tiny promise chain that serializes writes to one store instance. */
class Mutex {
  constructor() {
    this.tail = Promise.resolve()
  }

  run(operation) {
    const result = this.tail.then(operation, operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
}

/** One memory store bound to an absolute root directory. */
export class MemoryStore {
  /** @param {string} root absolute memory root */
  constructor(root) {
    this.root = root
    this.mutex = new Mutex()
  }

  /** Absolute path for a store-relative path. */
  resolve(relative) {
    return path.join(this.root, relative)
  }

  /** Create the layout and seed missing artifacts. Never overwrites existing files. */
  async ensure() {
    await fs.mkdir(this.root, { recursive: true })
    await fs.mkdir(this.resolve(SUMMARIES_DIR), { recursive: true })
    await fs.mkdir(this.resolve(NOTES_DIR), { recursive: true })
    await this.#seed(MEMORY_FILE, INITIAL_MEMORY)
    await this.#seed(SUMMARY_FILE, INITIAL_SUMMARY)
    await this.#seed(RAW_FILE, INITIAL_RAW)
    await this.#seed(path.posix.join(AD_HOC_DIR, 'instructions.md'), AD_HOC_INSTRUCTIONS)
    await this.#seed(INDEX_FILE, JSON.stringify(emptyIndex(), null, 2))
  }

  async #seed(relative, content) {
    const target = this.resolve(relative)
    try {
      await fs.access(target)
    } catch {
      await atomicWrite(target, content)
    }
  }

  async exists(relative) {
    try {
      await fs.access(this.resolve(relative))
      return true
    } catch {
      return false
    }
  }

  async read(relative) {
    try {
      return await fs.readFile(this.resolve(relative), 'utf8')
    } catch {
      return undefined
    }
  }

  async write(relative, content) {
    const target = this.resolve(relative)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await atomicWrite(target, content)
  }

  /** Read the compact prompt-loaded summary, or an empty string when absent. */
  async readSummaryText() {
    return (await this.read(SUMMARY_FILE)) ?? ''
  }

  async readMemoryText() {
    return (await this.read(MEMORY_FILE)) ?? ''
  }

  async readRawText() {
    return (await this.read(RAW_FILE)) ?? ''
  }

  async readIndex() {
    const text = await this.read(INDEX_FILE)
    if (!text) return emptyIndex()
    try {
      const parsed = JSON.parse(text)
      return normalizeIndex(parsed)
    } catch {
      return emptyIndex()
    }
  }

  async writeIndex(index) {
    await this.mutex.run(async () => {
      await this.write(INDEX_FILE, JSON.stringify(index, null, 2))
    })
  }

  /** Mutate the index under the store lock and persist the result. */
  async updateIndex(mutate) {
    return this.mutex.run(async () => {
      const index = await this.readIndex()
      const result = await mutate(index)
      await this.write(INDEX_FILE, JSON.stringify(index, null, 2))
      return result
    })
  }

  /** Persist one session summary file and return its store-relative path. */
  async writeSessionSummary(slug, content) {
    const safe = safeSlug(slug)
    const relative = path.posix.join(SUMMARIES_DIR, `${safe}.md`)
    await this.write(relative, content.endsWith('\n') ? content : `${content}\n`)
    return relative
  }

  /** Append one ad-hoc note and return its store-relative path. */
  async writeNote(note) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const relative = path.posix.join(NOTES_DIR, `${stamp}.md`)
    await this.write(relative, note.endsWith('\n') ? note : `${note}\n`)
    return relative
  }

  /** List session summary files as store-relative paths, newest first. */
  async listSessionSummaries() {
    let entries
    try {
      entries = await fs.readdir(this.resolve(SUMMARIES_DIR), { withFileTypes: true })
    } catch {
      return []
    }
    return entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
      .map(entry => path.posix.join(SUMMARIES_DIR, entry.name))
      .sort()
  }

  /** List ad-hoc note files as store-relative paths. */
  async listNotes() {
    let entries
    try {
      entries = await fs.readdir(this.resolve(NOTES_DIR), { withFileTypes: true })
    } catch {
      return []
    }
    return entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
      .map(entry => path.posix.join(NOTES_DIR, entry.name))
      .sort()
  }

  /**
   * Rebuild `raw_memories.md` from the cached stage-1 records, in stable ascending
   * thread-id order — the same mechanical merge Codex performs.
   */
  async composeRawMemories(index) {
    const ids = Object.keys(index.sessions).sort()
    const blocks = [INITIAL_RAW.trimEnd()]
    for (const id of ids) {
      const record = index.sessions[id]
      if (!record?.rawMemory) continue
      blocks.push('')
      blocks.push(`## Session \`${id}\``)
      blocks.push(`updated_at: ${new Date(record.sourceUpdatedAt ?? 0).toISOString()}`)
      if (record.cwd) blocks.push(`cwd: ${record.cwd}`)
      if (record.sessionPath) blocks.push(`session_path: ${record.sessionPath}`)
      if (record.summaryFile) blocks.push(`session_summary_file: ${path.posix.basename(record.summaryFile)}`)
      blocks.push('')
      blocks.push('---')
      blocks.push(record.rawMemory.trimEnd())
    }
    const text = `${blocks.join('\n')}\n`
    await this.write(RAW_FILE, text)
    return text
  }
}

/** Backing shape of `index.json`. */
export function emptyIndex() {
  return {
    version: 1,
    sessions: {},
    jobs: {},
    progress: {
      maxSessionCount: 0,
      lastConsolidatedAt: 0,
      lastExtractAt: 0,
    },
  }
}

function normalizeIndex(value) {
  const base = emptyIndex()
  if (!value || typeof value !== 'object') return base
  return {
    version: 1,
    sessions: value.sessions && typeof value.sessions === 'object' ? value.sessions : {},
    jobs: value.jobs && typeof value.jobs === 'object' ? value.jobs : {},
    progress: { ...base.progress, ...(value.progress && typeof value.progress === 'object' ? value.progress : {}) },
  }
}

/** Turn arbitrary text into a filesystem-safe, stable slug. */
export function safeSlug(value, fallback = 'session') {
  const cleaned = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return cleaned.length > 0 ? cleaned : fallback
}

/** Write a file atomically: temp file in the same directory, then rename. */
export async function atomicWrite(target, content) {
  const dir = path.dirname(target)
  const temp = path.join(dir, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`)
  await fs.writeFile(temp, content, 'utf8')
  try {
    await fs.rename(temp, target)
  } catch (error) {
    await fs.rm(temp, { force: true })
    throw error
  }
}
