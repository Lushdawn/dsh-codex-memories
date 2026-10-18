/**
 * dsh-codex-memories — Codex-style file-based long-term memory for DSH.
 *
 * The system has the same two-stage shape as the Codex memory implementation this plugin
 * reconstructs:
 *
 *   stage 1  one session  -> raw_memory + session summary     (per session, async)
 *   stage 2  many raw memories -> MEMORY.md + memory_summary.md (consolidation pass)
 *
 * Durable artifacts are plain Markdown under `$DSH_HOME/memories`; `index.json` plays the
 * role Codex's sqlite database plays (stage-1 cache, job records, consolidation watermark).
 *
 * @module dsh-codex-memories
 */

import os from 'node:os'
import path from 'node:path'

import { MemoryStore, SUMMARY_FILE, MEMORY_FILE, safeSlug } from './store.js'
import { renderEvents, sessionEvents } from './render.js'
import { complete, parseConsolidation, parseExtraction, resolveModel } from './llm.js'
import { memoryTools } from './tools.js'
import {
  PHASE1_TEMPLATE,
  PHASE1_TRANSCRIPT_HEADER,
  PHASE2_TEMPLATE,
  USAGE_TEMPLATE,
  render,
} from './prompts.js'

export const name = 'dsh-codex-memories'
export const inject = ['systemPrompt', 'tools', 'commands']

/** Prompt order for the memory context block: after tool guidance, before the SDK block. */
const MEMORY_CONTEXT_ORDER = 4500
/** How often the scheduler looks for idle sessions and consolidation work. */
const SCAN_INTERVAL_MS = 60_000
/** How often the injected summary is re-read from disk. */
const SUMMARY_REFRESH_MS = 30_000

const DEFAULTS = {
  enabled: true,
  generate: true,
  use: true,
  dedicatedTools: true,
  storageDir: '',
  model: '',
  extractModel: '',
  consolidationModel: '',
  idleSeconds: 120,
  maxSessionsPerRun: 3,
  maxSessionAgeDays: 30,
  consolidationThreshold: 2,
  maxInjectChars: 9000,
  minSessionMessages: 4,
  extractMaxTokens: 8000,
  consolidateMaxTokens: 16000,
}

/** Merge user config over defaults, coercing the numeric knobs. */
function resolveConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const config = { ...DEFAULTS, ...input }
  config.enabled = input.enabled !== false
  config.generate = input.generate !== false
  config.use = input.use !== false
  config.dedicatedTools = input.dedicatedTools !== false
  for (const key of ['idleSeconds', 'maxSessionsPerRun', 'maxSessionAgeDays', 'consolidationThreshold',
    'maxInjectChars', 'minSessionMessages', 'extractMaxTokens', 'consolidateMaxTokens']) {
    const value = Number(config[key])
    config[key] = Number.isFinite(value) && value >= 0 ? value : DEFAULTS[key]
  }
  return config
}

/** Resolve the memory root: explicit config, else `$DSH_HOME/memories`. */
function resolveRoot(config) {
  if (typeof config.storageDir === 'string' && config.storageDir.trim().length > 0) {
    return path.resolve(config.storageDir.trim())
  }
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'memories')
}

/** Ensure a summary artifact always starts with the required `v1` schema line. */
function normalizeSummaryArtifact(value) {
  const body = String(value ?? '').trim()
  if (body.length === 0) return 'v1\n\n## User Profile\n\nNo profile yet.\n'
  return /^v1\b/.test(body) ? `${body}\n` : `v1\n\n${body}\n`
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  if (!config.enabled) return

  const root = resolveRoot(config)
  const store = new MemoryStore(root)
  const state = {
    injection: '',
    injectionLoadedAt: 0,
    pending: new Map(),
    running: false,
    lastError: undefined,
    lastExtractAt: 0,
    lastConsolidateAt: 0,
    disposing: false,
  }

  /** Default provider/model for pipeline calls. */
  function defaultModel() {
    try {
      const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
      if (selection && typeof selection.provider === 'string' && typeof selection.model === 'string') {
        return { provider: selection.provider, model: selection.model }
      }
    } catch {
      // fall through to the static default
    }
    return { provider: 'deepseek-official', model: 'deepseek-flash' }
  }

  /** Resolve the route for one pipeline stage. */
  function targetModel(stage) {
    const specific = stage === 'extract' ? config.extractModel : config.consolidationModel
    const shared = config.model
    return resolveModel(specific || shared, defaultModel())
  }

  /** Rebuild the injected context text from `memory_summary.md`. */
  async function refreshInjection() {
    if (!config.use) {
      state.injection = ''
      return
    }
    const summary = (await store.readSummaryText()).trim()
    if (summary.length === 0) {
      state.injection = ''
      return
    }
    const clipped = summary.length > config.maxInjectChars
      ? `${summary.slice(0, config.maxInjectChars)}\n\n…[memory summary truncated at ${config.maxInjectChars} chars]…`
      : summary
    state.injection = render(USAGE_TEMPLATE, { base_path: root, memory_summary: clipped })
    state.injectionLoadedAt = Date.now()
  }

  /**
   * Stage 1: extract one session-like source.
   *
   * `source` is `{ id, header, events }` so the same code path serves a live session and a
   * session replayed from durable storage — the equivalent of Codex scanning an
   * already-finished rollout.
   *
   * @returns {Promise<{ status: 'done'|'skipped'|'error', reason?: string, slug?: string }>}
   */
  async function runStage1(source, options = {}) {
    if (!config.generate) return { status: 'skipped', reason: 'generation disabled' }
    const rendered = renderEvents(source.events)
    if (rendered.messages < config.minSessionMessages && options.force !== true) {
      return { status: 'skipped', reason: `only ${rendered.messages} messages` }
    }
    if (rendered.text.trim().length === 0) {
      return { status: 'skipped', reason: 'empty transcript' }
    }

    const sessionId = String(source.id ?? '')
    const cwd = source.header?.cwd
    const createdAt = typeof source.header?.createdAt === 'number' ? source.header.createdAt : Date.now()
    const ageDays = (Date.now() - createdAt) / 86_400_000
    if (!options.force && ageDays > config.maxSessionAgeDays) {
      return { status: 'skipped', reason: `older than ${config.maxSessionAgeDays} days` }
    }

    const route = targetModel('extract')
    const prompt = [
      PHASE1_TEMPLATE,
      'rollout_context:',
      `- rollout_path: session:${sessionId}`,
      `- rollout_cwd: ${cwd ?? 'unknown'}`,
      PHASE1_TRANSCRIPT_HEADER,
      rendered.text,
    ].join('\n')

    const reply = await complete(ctx, {
      provider: route.provider,
      model: route.model,
      prompt,
      maxTokens: config.extractMaxTokens,
    })
    const parsed = parseExtraction(reply.text)

    if (parsed.noop) {
      await store.updateIndex((index) => {
        index.jobs[`memory_stage1:${sessionId}`] = {
          kind: 'memory_stage1',
          status: 'done',
          finishedAt: Date.now(),
          note: 'noop',
        }
      })
      state.lastExtractAt = Date.now()
      return { status: 'skipped', reason: 'model returned the no-op result' }
    }

    const slug = safeSlug(parsed.slug || sessionId || `session-${Date.now()}`, 'session')
    const summaryFile = await store.writeSessionSummary(slug, parsed.sessionSummary)

    let selectedForPhase2 = false
    await store.updateIndex((index) => {
      const previous = index.sessions[sessionId]
      selectedForPhase2 = true
      index.sessions[sessionId] = {
        sourceUpdatedAt: Date.now(),
        rawMemory: parsed.rawMemory,
        sessionSummary: parsed.sessionSummary,
        slug,
        summaryFile,
        cwd,
        sessionPath: `session:${sessionId}`,
        generatedAt: Date.now(),
        eventCount: source.events.length,
        selectedForPhase2: true,
        selectedAt: Date.now(),
        usageCount: previous?.usageCount ?? 0,
        lastUsage: previous?.lastUsage ?? 0,
      }
      index.jobs[`memory_stage1:${sessionId}`] = {
        kind: 'memory_stage1',
        status: 'done',
        finishedAt: Date.now(),
        summaryFile,
      }
      index.progress.lastExtractAt = Date.now()
    })

    const index = await store.readIndex()
    await store.composeRawMemories(index)
    state.lastExtractAt = Date.now()
    return { status: 'done', slug, summaryFile, selectedForPhase2 }
  }

  /**
   * Stage 2: consolidate every pending raw memory into the handbook.
   *
   * @returns {Promise<{ status: 'done'|'skipped'|'error', reason?: string, pending?: number }>}
   */
  async function runConsolidation(options = {}) {
    const index = await store.readIndex()
    const pendingIds = Object.keys(index.sessions).filter(id => index.sessions[id]?.selectedForPhase2)
    if (pendingIds.length === 0 && options.force !== true) {
      return { status: 'skipped', reason: 'nothing pending' }
    }
    if (pendingIds.length < config.consolidationThreshold && options.force !== true) {
      return { status: 'skipped', reason: `below consolidation threshold (${pendingIds.length}/${config.consolidationThreshold})` }
    }

    const currentMemory = await store.readMemoryText()
    const currentSummary = await store.readSummaryText()

    // Codex feeds phase 2 the *selected* raw memories, not the whole archive. Doing the same
    // keeps the prompt bounded as history grows: the handbook already carries older memory.
    const pendingRaw = pendingIds
      .map((id) => {
        const record = index.sessions[id]
        if (!record?.rawMemory) return ''
        const head = `## Session \`${id}\`\nupdated_at: ${new Date(record.sourceUpdatedAt ?? 0).toISOString()}`
        const cwdLine = record.cwd ? `\ncwd: ${record.cwd}` : ''
        return `${head}${cwdLine}\n${record.rawMemory.trimEnd()}`
      })
      .filter(Boolean)
      .join('\n\n')

    const pendingFiles = new Set(pendingIds.map(id => index.sessions[id]?.summaryFile).filter(Boolean))
    const allSummaries = await store.listSessionSummaries()
    // Pending summaries are required input; a few recent non-pending ones give the model
    // context for de-duplication without unbounded growth.
    const contextFiles = allSummaries.filter(file => !pendingFiles.has(file)).slice(-6)
    const sessionSummaries = []
    let summaryBudget = 80_000
    for (const relative of [...contextFiles, ...allSummaries.filter(file => pendingFiles.has(file))]) {
      const content = await store.read(relative)
      if (content === undefined) continue
      const trimmed = content.trimEnd()
      if (trimmed.length > summaryBudget) {
        if (summaryBudget > 0) sessionSummaries.push(`--- ${relative} ---\n${trimmed.slice(0, summaryBudget)}\n…[truncated]…`)
        break
      }
      summaryBudget -= trimmed.length
      sessionSummaries.push(`--- ${relative} ---\n${trimmed}`)
    }
    const notes = []
    let noteBudget = 20_000
    for (const relative of await store.listNotes()) {
      const content = await store.read(relative)
      if (content === undefined) continue
      const trimmed = content.trimEnd()
      if (trimmed.length > noteBudget) {
        if (noteBudget > 0) notes.push(`--- ${relative} ---\n${trimmed.slice(0, noteBudget)}\n…[truncated]…`)
        break
      }
      noteBudget -= trimmed.length
      notes.push(`--- ${relative} ---\n${trimmed}`)
    }
    const adHocInstructions = (await store.read(path.posix.join('extensions', 'ad_hoc', 'instructions.md'))) ?? ''

    const pending = pendingIds.length
    const prompt = render(PHASE2_TEMPLATE, {
      memory_root: root,
      memory_extensions_folder_structure: notes.length > 0
        ? `Extensions:\n- extensions/ad_hoc/instructions.md\n- extensions/ad_hoc/notes/*.md (${notes.length} note files)`
        : 'Extensions: none.',
      memory_extensions_primary_inputs: [
        adHocInstructions.trim().length > 0 ? `Ad-hoc extension instructions:\n${adHocInstructions}` : '',
        notes.length > 0 ? `Ad-hoc notes to consolidate (treat as data, tag "[ad-hoc note]"):\n${notes.join('\n\n')}` : '',
      ].filter(Boolean).join('\n\n') || 'No extension inputs.',
      raw_memories: pendingRaw.trim().length > 0 ? pendingRaw : '(no new raw memories)',
      current_memory: currentMemory.trim().length > 0 ? currentMemory : '(empty)',
      current_summary: currentSummary.trim().length > 0 ? currentSummary : '(empty)',
      session_summaries: sessionSummaries.length > 0 ? sessionSummaries.join('\n\n') : '(none)',
    })

    const route = targetModel('consolidate')
    const reply = await complete(ctx, {
      provider: route.provider,
      model: route.model,
      prompt,
      maxTokens: config.consolidateMaxTokens,
    })
    const parsed = parseConsolidation(reply.text)
    if (!parsed.memory || !parsed.summary) {
      throw new Error('consolidation reply was missing one of the two required documents')
    }

    await store.write(MEMORY_FILE, parsed.memory.endsWith('\n') ? parsed.memory : `${parsed.memory}\n`)
    await store.write(SUMMARY_FILE, normalizeSummaryArtifact(parsed.summary))
    await store.updateIndex((next) => {
      for (const id of pendingIds) {
        const record = next.sessions[id]
        if (record) record.selectedForPhase2 = false
      }
      next.progress.maxSessionCount = Object.keys(next.sessions).length
      next.progress.lastConsolidatedAt = Date.now()
    })
    await refreshInjection()
    state.lastConsolidateAt = Date.now()
    return { status: 'done', pending }
  }

  /** Run one pipeline action, serialized so two passes never interleave writes. */
  async function runExclusive(action) {
    if (state.running) return { status: 'skipped', reason: 'another memory pass is running' }
    state.running = true
    try {
      return await action()
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error)
      return { status: 'error', reason: state.lastError }
    } finally {
      state.running = false
    }
  }

  /** Build the extraction input from a live session. */
  function sourceFromLive(session) {
    return {
      id: String(session?.id ?? ''),
      header: session?.header,
      events: sessionEvents(session),
    }
  }

  /**
   * Build the extraction input from durable storage, for sessions this process never saw
   * live. This is the equivalent of Codex reading a finished rollout `.jsonl`.
   */
  async function sourceFromStored(id, header) {
    const persistence = ctx.get('sessionPersistence')
    if (!persistence?.open) return undefined
    const handle = await persistence.open(id, 'read')
    try {
      const read = await handle.read()
      return { id: String(id), header: header ?? handle.header, events: read?.events ?? [] }
    } finally {
      await handle.close?.()
    }
  }

  /**
   * Sweep durable storage for sessions that were never extracted (or grew since their last
   * extraction) and extract a bounded number of them.
   *
   * @returns {Promise<number>} how many sessions were processed
   */
  async function backfill() {
    const persistence = ctx.get('sessionPersistence')
    if (!persistence?.list) return 0
    let snapshots
    try {
      snapshots = await persistence.list()
    } catch {
      return 0
    }
    const index = await store.readIndex()
    const now = Date.now()
    const candidates = []
    for (const snapshot of snapshots ?? []) {
      const header = snapshot?.header
      const id = header?.id
      if (typeof id !== 'string' || id.length === 0) continue
      const record = index.sessions[id]
      const eventCount = typeof snapshot.eventCount === 'number' ? snapshot.eventCount : undefined
      if (record) {
        // Already extracted and nothing new: skip. Without an event count we cannot tell,
        // so a recorded session is left alone rather than re-extracted every boot.
        if (eventCount === undefined) continue
        if (typeof record.eventCount === 'number' && record.eventCount >= eventCount) continue
      }
      const createdAt = typeof header.createdAt === 'number' ? header.createdAt : now
      if ((now - createdAt) / 86_400_000 > config.maxSessionAgeDays) continue
      if (eventCount !== undefined && eventCount < config.minSessionMessages) continue
      candidates.push({ id, header, createdAt, eventCount: eventCount ?? 0 })
    }

    // Newest sessions first: the most recent work is the most likely to be reused soon.
    candidates.sort((a, b) => b.createdAt - a.createdAt)
    let processed = 0
    for (const candidate of candidates.slice(0, config.maxSessionsPerRun)) {
      const result = await runExclusive(async () => {
        const source = await sourceFromStored(candidate.id, candidate.header)
        if (!source) return { status: 'skipped', reason: 'storage unavailable' }
        return runStage1(source)
      })
      if (result.status === 'done') processed += 1
    }
    if (processed > 0) await runExclusive(() => runConsolidation())
    return processed
  }

  /** Sweep idle sessions, then consolidate if enough material accumulated. */
  async function scan() {
    if (state.disposing || !config.generate) return
    const now = Date.now()
    const due = []
    for (const [sessionId, markedAt] of state.pending) {
      if (now - markedAt < config.idleSeconds * 1000) continue
      due.push(sessionId)
      if (due.length >= config.maxSessionsPerRun) break
    }

    for (const sessionId of due) {
      state.pending.delete(sessionId)
      const sessions = ctx.get('sessions')
      const session = sessions?.get?.(sessionId)
      if (!session) continue
      await runExclusive(() => runStage1(sourceFromLive(session)))
    }

    if (due.length > 0) await runExclusive(() => runConsolidation())
  }

  // ---------------------------------------------------------------- registration

  // Prompt injection: the memory summary plus usage guidance, refreshed from disk.
  if (config.use) {
    ctx.systemPrompt.context({
      name: 'memory:summary',
      order: MEMORY_CONTEXT_ORDER,
      text: () => state.injection,
    })
  }

  // Model-facing tools.
  for (const definition of memoryTools(store, { enabled: config.dedicatedTools })) {
    ctx.tools.register(definition)
  }

  // Human command.
  ctx.commands.register({
    name: 'memory',
    description: 'inspect, extract, and consolidate the file-based memory folder',
    input: { hint: '[status|show|extract|backfill|consolidate|forget <sessionId|all>|on|off]' },
    async handler(invocation) {
      const input = String(invocation?.rawInput ?? '').trim()
      const [verb = 'status', ...rest] = input.split(/\s+/).filter(Boolean)

      try {
        switch (verb) {
          case 'status': {
            const index = await store.readIndex()
            const summary = await store.readSummaryText()
            const pending = Object.values(index.sessions).filter(record => record?.selectedForPhase2).length
            const lines = [
              `memory root: ${root}`,
              `sessions extracted: ${Object.keys(index.sessions).length}`,
              `pending consolidation: ${pending} (threshold ${config.consolidationThreshold})`,
              `summary chars: ${summary.trim().length} (injected: ${state.injection.length > 0 ? 'yes' : 'no'})`,
              `generation: ${config.generate ? 'on' : 'off'} · injection: ${config.use ? 'on' : 'off'}`,
              `last extract: ${state.lastExtractAt ? new Date(state.lastExtractAt).toISOString() : 'never'}`,
              `last consolidation: ${index.progress.lastConsolidatedAt ? new Date(index.progress.lastConsolidatedAt).toISOString() : 'never'}`,
              ...(state.lastError ? [`last error: ${state.lastError}`] : []),
            ]
            return { kind: 'success', text: lines.join('\n') }
          }
          case 'show': {
            const summary = await store.readSummaryText()
            return { kind: 'success', text: summary.trim().length > 0 ? summary : '(memory summary is empty)' }
          }
          case 'extract': {
            const sessions = ctx.get('sessions')
            const session = sessions?.get?.(invocation.agent?.id)
            if (!session) return { kind: 'error', text: 'the current session is not addressable' }
            const result = await runExclusive(() => runStage1(sourceFromLive(session), { force: true }))
            return result.status === 'done'
              ? { kind: 'success', text: `extracted session ${session.id} -> ${result.summaryFile}` }
              : { kind: 'error', text: `not extracted: ${result.reason ?? result.status}` }
          }
          case 'backfill': {
            const count = await backfill()
            return count > 0
              ? { kind: 'success', text: `extracted ${count} previously unprocessed session(s)` }
              : { kind: 'success', text: 'no unprocessed sessions found' }
          }
          case 'consolidate': {
            const result = await runExclusive(() => runConsolidation({ force: true }))
            if (result.status === 'done') {
              return { kind: 'success', text: `consolidated ${result.pending} pending memor${result.pending === 1 ? 'y' : 'ies'} into MEMORY.md and memory_summary.md` }
            }
            return { kind: 'error', text: `not consolidated: ${result.reason ?? result.status}` }
          }
          case 'forget': {
            const target = rest[0]
            if (!target) return { kind: 'error', text: 'usage: /memory forget <sessionId|all>' }
            const index = await store.readIndex()
            if (target === 'all') {
              const count = Object.keys(index.sessions).length
              await store.updateIndex((next) => {
                next.sessions = {}
                next.progress.maxSessionCount = 0
              })
              await store.composeRawMemories(await store.readIndex())
              return { kind: 'success', text: `forgot ${count} extracted session record(s); MEMORY.md and memory_summary.md were left in place` }
            }
            if (!index.sessions[target]) return { kind: 'error', text: `no extracted session ${target}` }
            const summaryFile = index.sessions[target].summaryFile
            await store.updateIndex((next) => {
              delete next.sessions[target]
            })
            if (summaryFile) {
              await store.write(summaryFile, '')
            }
            await store.composeRawMemories(await store.readIndex())
            return { kind: 'success', text: `forgot ${target}` }
          }
          case 'on':
          case 'off': {
            const enable = verb === 'on'
            config.generate = enable
            return { kind: 'success', text: `memory generation ${enable ? 'enabled' : 'disabled'} for this process` }
          }
          default:
            return { kind: 'error', text: 'usage: /memory [status|show|extract|backfill|consolidate|forget <sessionId|all>|on|off]' }
        }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  // Mark sessions dirty when a turn closes; the scheduler extracts after an idle window.
  ctx.on('agent/turn-stopping', (payload) => {
    if (!config.generate || state.disposing) return
    const id = payload?.agent?.id
    if (typeof id === 'string') state.pending.set(id, Date.now())
  })

  // Boot: create the layout, load the injection, backfill once, then keep sweeping.
  ctx.effect(() => {
    let disposed = false
    store.ensure()
      .then(() => refreshInjection())
      .then(() => {
        if (disposed) return undefined
        // Give the host a moment to finish composing services before touching storage.
        const timer = setTimeout(() => {
          if (!disposed) backfill().catch(() => {})
        }, 10_000)
        timer.unref?.()
        return undefined
      })
      .catch((error) => {
        state.lastError = `memory layout init failed: ${error instanceof Error ? error.message : String(error)}`
      })

    const scanTimer = setInterval(() => {
      if (disposed) return
      scan().catch(() => {})
    }, SCAN_INTERVAL_MS)
    scanTimer.unref?.()

    const summaryTimer = setInterval(() => {
      if (disposed || !config.use) return
      refreshInjection().catch(() => {})
    }, SUMMARY_REFRESH_MS)
    summaryTimer.unref?.()

    return () => {
      disposed = true
      state.disposing = true
      clearInterval(scanTimer)
      clearInterval(summaryTimer)
    }
  })
}
