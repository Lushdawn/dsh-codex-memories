/**
 * Session transcript rendering for stage-1 extraction.
 *
 * Codex renders a rollout `.jsonl` into a filtered conversation before extraction. DSH
 * stores the same information as typed session events, so this module renders those events
 * with two goals: keep the evidence a human/agent actually steered by (user messages, tool
 * failures, verification output), and stay inside a hard character budget.
 *
 * @module dsh-codex-memories/render
 */

const DEFAULT_BUDGET = 48_000
const TOOL_ARGS_CLIP = 400
const TOOL_RESULT_CLIP = 700
const BLOCK_CLIP = 6_000

/** Extract plain text from one content block array. */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'reasoning' && typeof block.text === 'string') parts.push(`[reasoning] ${block.text}`)
    else if (block.type === 'image') parts.push('[image]')
    else if (block.type === 'file') parts.push(`[file ${block.attachment?.name ?? ''}]`)
    else if (block.type === 'tool-call') {
      parts.push(`[tool-call ${block.name ?? '?'} ${clip(String(block.arguments ?? ''), TOOL_ARGS_CLIP)}]`)
    } else if (block.type === 'tool-addition') parts.push(`[tool-add ${block.toolName ?? '?'}]`)
    else if (block.type === 'tool-removal') parts.push(`[tool-remove ${block.toolName ?? '?'}]`)
  }
  return parts.join('\n')
}

function clip(text, limit) {
  const value = String(text ?? '')
  if (value.length <= limit) return value
  const head = Math.ceil(limit * 0.7)
  const tail = Math.floor(limit * 0.3)
  return `${value.slice(0, head)}\n…[clipped ${value.length - limit} chars]…\n${value.slice(-tail)}`
}

function oneLine(text, limit) {
  return clip(String(text ?? '').replace(/\s+/g, ' ').trim(), limit)
}

/**
 * Read events off a live Session defensively. Session shape differs slightly across
 * versions, so every accessor is optional and a failure downgrades to an empty transcript
 * rather than breaking the caller.
 */
export function sessionEvents(session) {
  try {
    if (typeof session?.snapshotEvents === 'function') return session.snapshotEvents()
    if (Array.isArray(session?.events)) return session.events
    if (typeof session?.ownEvents === 'function') return session.ownEvents()
  } catch {
    // fall through: an unreadable session is rendered as empty
  }
  return []
}

/**
 * Render one session into a compact transcript.
 *
 * @param {object} session live DSH Session (or a duck-typed equivalent)
 * @param {{ budget?: number }} [options]
 * @returns {{ text: string, events: number, messages: number, turns: number, truncated: boolean }}
 */
export function renderSession(session, options = {}) {
  return renderEvents(sessionEvents(session), options)
}

/**
 * Render an already-loaded event array — the path used for stored sessions read back
 * through `sessionPersistence`, which have no live `Session` object.
 *
 * @param {readonly object[]} events session events
 * @param {{ budget?: number }} [options]
 * @returns {{ text: string, events: number, messages: number, turns: number, truncated: boolean }}
 */
export function renderEvents(events, options = {}) {
  const budget = options.budget ?? DEFAULT_BUDGET
  const parts = []
  let messages = 0
  let turns = 0
  let lastTurn = -1

  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    const data = event.data ?? {}
    switch (event.type) {
      case 'turn/start':
        turns += 1
        lastTurn = data.turn ?? turns
        parts.push(`\n--- turn ${lastTurn} ---`)
        break
      case 'user/message': {
        const text = textOf(data.content ?? data.message?.content)
        if (!text.trim()) break
        messages += 1
        parts.push(`\n## User\n${clip(text, BLOCK_CLIP)}`)
        break
      }
      case 'assistant/message': {
        const text = textOf(data.message?.content)
        if (!text.trim()) break
        messages += 1
        parts.push(`\n## Assistant\n${clip(text, BLOCK_CLIP)}`)
        break
      }
      case 'tool/call': {
        parts.push(`\n> tool ${data.name ?? '?'}(${oneLine(data.arguments, TOOL_ARGS_CLIP)})`)
        break
      }
      case 'tool/result': {
        const failed = data.error ? ` ERROR:${data.error.code ?? data.error.name ?? 'error'}` : ''
        const body = textOf(data.message?.content)
        parts.push(`< result${failed}: ${oneLine(body, TOOL_RESULT_CLIP)}`)
        break
      }
      case 'developer/message':
      case 'system/message':
      case 'step/start':
      case 'step/end':
      case 'turn/end':
      case 'request/header':
      case 'request/context':
        // Deliberately excluded: context plumbing carries no user intent and would dominate
        // the transcript budget.
        break
      default:
        break
    }
  }

  let text = parts.join('\n').trim()
  let truncated = false
  if (text.length > budget) {
    truncated = true
    const head = Math.floor(budget * 0.55)
    const tail = Math.floor(budget * 0.35)
    text = `${text.slice(0, head)}\n\n…[transcript clipped: ${text.length - head - tail} chars omitted]…\n\n${text.slice(-tail)}`
  }

  return { text, events: events.length, messages, turns, truncated }
}

/** Best-effort cwd for a session header. */
export function sessionCwd(session) {
  try {
    const cwd = session?.header?.cwd
    return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
  } catch {
    return undefined
  }
}

/** Best-effort creation time for a session. */
export function sessionCreatedAt(session) {
  try {
    const createdAt = session?.header?.createdAt
    return typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : Date.now()
  } catch {
    return Date.now()
  }
}
