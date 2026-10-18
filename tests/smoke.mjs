/**
 * End-to-end smoke test for dsh-codex-memories.
 *
 * Runs the real plugin against a mock Cordis context: real store, real renderer, real tool
 * definitions, real command handler, and a stub `llm.stream` that returns a fixed stage-1
 * JSON and a fixed phase-2 document pair. Nothing here touches a live DSH host.
 *
 *   node tests/smoke.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply, name, inject } from '../lib/index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TEST_HOME = path.join(HERE, '.test-home')
const MEMORY_ROOT = path.join(TEST_HOME, 'memories')

process.env.DSH_HOME = TEST_HOME

const STAGE1_JSON = JSON.stringify({
  rollout_summary: `# 并行化构建脚本并保留旧行为

Rollout context: 用户在 Windows 上要求把构建脚本改成并行，同时保留旧的串行行为可用。
## Task 1: 并行化构建脚本
Outcome: success
Preference signals:
- when 用户说 "不要改 C 盘的东西，输出放 H 盘" -> 产物与临时文件应默认落在 H 盘。
Reusable knowledge:
- 构建脚本支持 BUILD_JOBS 环境变量覆盖并行度。
References:
- [1] BUILD_JOBS=8 ./build.sh -> 通过`,
  rollout_slug: 'parallel-build-script',
  raw_memory: `description: 将构建脚本并行化，保留串行回退，验证通过
task: parallelize-build-script
task_group: build-tooling
task_outcome: success
cwd: H:\\demo
keywords: build.sh, BUILD_JOBS, parallel, H drive

### Task 1: 并行化构建脚本
task: parallelize-build-script
task_group: build-tooling
task_outcome: success
Reusable knowledge:
- 构建脚本支持 BUILD_JOBS 环境变量覆盖并行度。
Failures and how to do differently:
- 第一次直接改默认并行度，用户要求保留旧行为；改为可选开关。
References:
- BUILD_JOBS=8 ./build.sh`,
})

const STAGE2_DOCS = `<<<MEMORY_MD>>>
# Task Group: build tooling

scope: 并行构建脚本与产物路径约定
applies_to: cwd=H:\\demo; reuse_rule=脚本路径与构建入口稳定时可复用

### session_summaries

- session_summaries/parallel-build-script.md (cwd=H:\\demo, session_path=session:session-test-1, updated_at=2026-10-18T00:00:00Z, thread_id=session-test-1)

### keywords

- build.sh, BUILD_JOBS, parallel

## User preferences

- 产物与临时文件默认落在 H 盘，不要写入 C 盘。 [Task 1]

## Reusable knowledge

- BUILD_JOBS 覆盖并行度，默认保持串行以保留旧行为。 [Task 1]
<<<END_MEMORY_MD>>>

<<<MEMORY_SUMMARY_MD>>>
v1

## User Profile

用户在 Windows 上开发构建工具，偏好保留旧行为的前提下做增量优化，产物放 H 盘。

## User preferences

- 产物与临时文件默认落在 H 盘，不要写入 C 盘。

## General Tips

- 改动构建脚本前先确认串行回退仍可用。

## What's in Memory

### H:\\demo

#### 2026-10-18

- 并行构建脚本: build.sh, BUILD_JOBS
  - desc: 把构建脚本并行化，同时保留串行回退。
  - learnings: BUILD_JOBS 可覆盖并行度；默认必须保持旧行为。
<<<END_MEMORY_SUMMARY_MD>>>
`

const STAGE1_JSON_2 = JSON.stringify({
  rollout_summary: `# 补充第二条历史会话

Rollout context: 一个此前未提取的历史会话，用于验证启动补齐。
## Task 1: 整理发布清单
Outcome: partial
Reusable knowledge:
- 发布清单需要包含许可证与 README 双语文档。
References:
- [1] ls docs -> README.zh.md 缺失`,
  rollout_slug: 'release-checklist',
  raw_memory: `description: 整理 DSH 插件发布清单，缺少中文 README
task: release-checklist
task_group: plugin-release
task_outcome: partial
cwd: H:\\demo2
keywords: release, README.zh.md, LICENSE

### Task 1: 整理发布清单
task: release-checklist
task_group: plugin-release
task_outcome: partial
Reusable knowledge:
- 发布清单需要包含许可证与 README 双语文档。`,
})

/** Deterministic stub model routed by prompt phase. */
function makeLlm() {
  const calls = []
  return {
    calls,
    stream(options) {
      calls.push(options)
      const prompt = String(options?.messages?.[0]?.content?.[0]?.text ?? '')
      let body
      if (prompt.includes('Phase 2 (Consolidation)')) body = STAGE2_DOCS
      else if (prompt.includes('session:session-stored-2')) body = STAGE1_JSON_2
      else body = STAGE1_JSON
      return (async function* stream() {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: body }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: body } }
        yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 100 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

const sessionEvents = [
  { type: 'turn/start', data: { turn: 1 } },
  {
    type: 'user/message',
    data: { content: [{ type: 'text', text: '请把构建脚本改成并行，但要保留旧的串行行为可用。' }] },
  },
  {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '我先读构建脚本，再改并行度开关。' }] } },
  },
  { type: 'tool/call', data: { name: 'read', arguments: '{"path":"build.sh"}' } },
  { type: 'tool/result', data: { message: { content: [{ type: 'text', text: '#!/bin/sh\\nmake -j1' }] } } },
  {
    type: 'user/message',
    data: { content: [{ type: 'text', text: '不要改 C 盘的东西，输出放 H 盘。' }] },
  },
  {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '已改为 BUILD_JOBS 控制并行度，并验证串行仍可用。' }] } },
  },
  { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
]

function makeSession() {
  return {
    id: 'session-test-1',
    header: { cwd: 'H:\\demo', createdAt: Date.now() },
    snapshotEvents: () => sessionEvents,
  }
}

/** A stored session the current process never saw live, used by the backfill path. */
const storedEvents = [
  { type: 'turn/start', data: { turn: 1 } },
  {
    type: 'user/message',
    data: { content: [{ type: 'text', text: '发布前把清单过一遍，中文 README 也补上。' }] },
  },
  {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '清单里缺 README.zh.md 和 LICENSE。' }] } },
  },
  {
    type: 'user/message',
    data: { content: [{ type: 'text', text: '先记下来，稍后补。' }] },
  },
  {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '已记录到待办。' }] } },
  },
]

/** Minimal Cordis-shaped context that records registrations. */
function makeContext(llm, session) {
  const registrations = { tools: [], commands: [], contexts: [], listeners: [] }
  const storedHeader = { id: 'session-stored-2', cwd: 'H:\\demo2', createdAt: Date.now() - 3_600_000 }
  const services = {
    llm,
    sessions: { get: id => (id === session.id ? session : undefined) },
    agentDefaultModel: { currentSelection: () => ({ provider: 'stub', model: 'stub-model' }) },
    sessionPersistence: {
      list: async () => [{ header: storedHeader, eventCount: storedEvents.length }],
      open: async () => ({
        header: storedHeader,
        read: async () => ({ events: storedEvents }),
        close: async () => {},
      }),
    },
  }
  const ctx = {
    get: key => services[key],
    on(event, handler) {
      registrations.listeners.push({ event, handler })
      return () => {}
    },
    effect(fn) {
      const dispose = fn()
      return () => dispose?.()
    },
    systemPrompt: {
      context(entry) {
        registrations.contexts.push(entry)
        return () => {}
      },
      section(entry) {
        registrations.contexts.push(entry)
        return () => {}
      },
    },
    tools: {
      register(definition) {
        registrations.tools.push(definition)
        return () => {}
      },
    },
    commands: {
      register(definition) {
        registrations.commands.push(definition)
        return () => {}
      },
    },
  }
  return { ctx, registrations }
}

async function main() {
  await fs.rm(TEST_HOME, { recursive: true, force: true })
  await fs.mkdir(TEST_HOME, { recursive: true })

  const llm = makeLlm()
  const session = makeSession()
  const { ctx, registrations } = makeContext(llm, session)

  assert.equal(name, 'dsh-codex-memories')
  assert.deepEqual(inject, ['systemPrompt', 'tools', 'commands'])

  apply(ctx, { idleSeconds: 0, consolidationThreshold: 1, minSessionMessages: 1 })

  // Layout is created asynchronously from the boot effect.
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try {
      await fs.access(path.join(MEMORY_ROOT, 'index.json'))
      break
    } catch {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }

  for (const file of ['MEMORY.md', 'memory_summary.md', 'raw_memories.md', 'index.json']) {
    await fs.access(path.join(MEMORY_ROOT, file))
  }
  await fs.access(path.join(MEMORY_ROOT, 'extensions', 'ad_hoc', 'instructions.md'))

  assert.equal(registrations.tools.length, 4, 'four memory tools register')
  assert.deepEqual(
    registrations.tools.map(tool => tool.name).sort(),
    ['memory_list', 'memory_note', 'memory_read', 'memory_search'],
  )
  assert.equal(registrations.commands.length, 1)
  assert.equal(registrations.commands[0].name, 'memory')
  assert.equal(registrations.contexts.length, 1)
  assert.equal(registrations.contexts[0].name, 'memory:summary')

  // --- stage 1 through the public command surface ---
  const command = registrations.commands[0]
  const invocation = { agent: session, rawInput: 'extract', attachments: [], signal: new AbortController().signal }
  const extracted = await command.handler(invocation)
  assert.equal(extracted.kind, 'success', `extract failed: ${extracted.text}`)

  const index1 = JSON.parse(await fs.readFile(path.join(MEMORY_ROOT, 'index.json'), 'utf8'))
  assert.ok(index1.sessions['session-test-1'], 'stage-1 record cached')
  assert.match(index1.sessions['session-test-1'].rawMemory, /parallelize-build-script/)

  const raw = await fs.readFile(path.join(MEMORY_ROOT, 'raw_memories.md'), 'utf8')
  assert.match(raw, /## Session `session-test-1`/, 'raw memories merged by thread id')
  assert.match(raw, /task_group: build-tooling/)

  const summaryPath = path.join(MEMORY_ROOT, 'session_summaries', 'parallel-build-script.md')
  const summary = await fs.readFile(summaryPath, 'utf8')
  assert.match(summary, /## Task 1: 并行化构建脚本/)

  // --- stage 2 through the public command surface ---
  const consolidated = await command.handler({ ...invocation, rawInput: 'consolidate' })
  assert.equal(consolidated.kind, 'success', `consolidate failed: ${consolidated.text}`)

  const memory = await fs.readFile(path.join(MEMORY_ROOT, 'MEMORY.md'), 'utf8')
  assert.match(memory, /# Task Group: build tooling/)
  assert.match(memory, /BUILD_JOBS/)
  const compact = await fs.readFile(path.join(MEMORY_ROOT, 'memory_summary.md'), 'utf8')
  assert.ok(compact.startsWith('v1'), 'summary starts with the v1 schema line')

  const index2 = JSON.parse(await fs.readFile(path.join(MEMORY_ROOT, 'index.json'), 'utf8'))
  assert.equal(index2.sessions['session-test-1'].selectedForPhase2, false, 'consolidation watermark cleared')
  assert.ok(index2.progress.lastConsolidatedAt > 0)

  // --- tools ---
  const tool = name => registrations.tools.find(entry => entry.name === name)
  const search = await tool('memory_search').execute({ queries: ['BUILD_JOBS'] })
  assert.ok(search.total >= 1, 'search finds the consolidated keyword')
  assert.ok(search.files.some(file => file.path === 'MEMORY.md'))
  const rendered = tool('memory_search').output.render({}, search)
  assert.match(rendered[0].text, /MEMORY\.md/)

  const read = await tool('memory_read').execute({ path: 'MEMORY.md', start_line: 1, end_line: 5 })
  assert.equal(read.start_line, 1)
  assert.ok(read.lines.length > 0)

  const list = await tool('memory_list').execute({})
  assert.ok(list.entries.some(entry => entry.path === 'session_summaries/parallel-build-script.md'))

  const note = await tool('memory_note').execute({ note: '用户要求：构建产物不要写 C 盘。' })
  assert.match(note.path, /^extensions\/ad_hoc\/notes\/.+\.md$/)

  // --- injection reflects the consolidated summary ---
  const injected = registrations.contexts[0].text()
  assert.match(injected, /MEMORY_SUMMARY BEGINS/)
  assert.match(injected, /BUILD_JOBS/)

  // --- the turn-stopping listener is wired for automatic extraction ---
  assert.ok(
    registrations.listeners.some(listener => listener.event === 'agent/turn-stopping'),
    'agent/turn-stopping listener registered',
  )

  // --- backfill extracts a stored session this process never saw live ---
  const backfilled = await command.handler({ ...invocation, rawInput: 'backfill' })
  assert.equal(backfilled.kind, 'success', `backfill failed: ${backfilled.text}`)
  assert.match(backfilled.text, /extracted 1/)

  const indexAfterBackfill = JSON.parse(await fs.readFile(path.join(MEMORY_ROOT, 'index.json'), 'utf8'))
  assert.ok(indexAfterBackfill.sessions['session-stored-2'], 'stored session extracted')
  assert.equal(indexAfterBackfill.sessions['session-stored-2'].eventCount, storedEvents.length)
  assert.ok(
    await fs.readFile(path.join(MEMORY_ROOT, 'session_summaries', 'release-checklist.md'), 'utf8'),
  )

  // A second backfill must not re-extract an unchanged session.
  const again = await command.handler({ ...invocation, rawInput: 'backfill' })
  assert.match(again.text, /no unprocessed sessions/)

  // The phase-2 prompt must carry only the *selected* raw memories: once session-test-1 was
  // consolidated, its raw block must not be replayed on the next pass.
  const phase2Prompts = llm.calls
    .map(call => String(call?.messages?.[0]?.content?.[0]?.text ?? ''))
    .filter(prompt => prompt.includes('Phase 2 (Consolidation)'))
  assert.ok(phase2Prompts.length >= 2, 'two consolidation passes ran')
  const lastPhase2 = phase2Prompts[phase2Prompts.length - 1]
  assert.ok(lastPhase2.includes('task_group: plugin-release'), 'new raw memory is present')
  assert.ok(
    !lastPhase2.includes('## Session `session-test-1`'),
    'already consolidated raw memory is not replayed',
  )

  // --- forget ---
  const forgotten = await command.handler({ ...invocation, rawInput: 'forget session-test-1' })
  assert.equal(forgotten.kind, 'success')
  const index3 = JSON.parse(await fs.readFile(path.join(MEMORY_ROOT, 'index.json'), 'utf8'))
  assert.equal(Object.keys(index3.sessions).length, 1, 'only the named session was forgotten')
  assert.ok(index3.sessions['session-stored-2'])

  const forgottenAll = await command.handler({ ...invocation, rawInput: 'forget all' })
  assert.equal(forgottenAll.kind, 'success')
  const index4 = JSON.parse(await fs.readFile(path.join(MEMORY_ROOT, 'index.json'), 'utf8'))
  assert.equal(Object.keys(index4.sessions).length, 0)

  const status = await command.handler({ ...invocation, rawInput: 'status' })
  assert.equal(status.kind, 'success')
  assert.match(status.text, /pending consolidation/)

  console.log('PASS smoke: layout, tools, command, stage1, stage2, injection, forget')
  console.log(`llm calls: ${llm.calls.length}`)
  console.log(`memory root: ${MEMORY_ROOT}`)
}

main().catch((error) => {
  console.error('FAIL', error)
  process.exitCode = 1
})
