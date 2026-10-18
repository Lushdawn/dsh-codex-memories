/**
 * Model calls for the memory pipeline.
 *
 * Stage 1 needs a strict JSON object; phase 2 needs two large Markdown bodies. Both go
 * through `ctx.llm.stream`, collecting text deltas only — reasoning deltas are intentionally
 * dropped so a long think does not leak into a parsed artifact.
 *
 * @module dsh-codex-memories/llm
 */

/** Parse `provider/model` or fall back to a provided selection. */
export function resolveModel(spec, fallback) {
  if (typeof spec === 'string' && spec.includes('/')) {
    const index = spec.indexOf('/')
    const provider = spec.slice(0, index).trim()
    const model = spec.slice(index + 1).trim()
    if (provider && model) return { provider, model }
  }
  if (spec && typeof spec === 'object' && typeof spec.provider === 'string' && typeof spec.model === 'string') {
    return { provider: spec.provider, model: spec.model }
  }
  return fallback
}

/**
 * Stream one completion and join its text deltas.
 *
 * @param {object} ctx plugin context carrying `llm`
 * @param {{
 *   provider: string,
 *   model: string,
 *   system?: string,
 *   prompt: string,
 *   maxTokens?: number,
 *   signal?: AbortSignal,
 * }} request
 * @returns {Promise<{ text: string, usage?: object, finish?: object }>}
 */
export async function complete(ctx, request) {
  const llm = ctx.get('llm')
  if (!llm) throw new Error('the llm service is unavailable; cannot run memory extraction')

  const messages = [
    {
      role: 'user',
      content: [{ type: 'text', text: request.prompt }],
    },
  ]

  const stream = llm.stream({
    provider: request.provider,
    model: request.model,
    ...(request.system ? { system: request.system } : {}),
    messages,
    ...(request.maxTokens ? { maxTokens: request.maxTokens } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
  })

  let text = ''
  let usage
  let finish

  for await (const chunk of stream) {
    if (!chunk || typeof chunk !== 'object') continue
    switch (chunk.type) {
      case 'text-delta':
        text += chunk.text ?? ''
        break
      case 'usage':
        usage = chunk.usage
        break
      case 'finish':
        finish = chunk.reason
        break
      default:
        break
    }
  }

  if (finish && finish.kind === 'error') {
    const failure = finish.failure ?? {}
    throw new Error(`model call failed: ${failure.code ?? 'error'}${failure.message ? ` — ${failure.message}` : ''}`)
  }
  if (finish && finish.kind === 'aborted') {
    throw new Error('model call was aborted')
  }

  return { text, usage, finish }
}

/**
 * Extract the first balanced JSON object from arbitrary model output.
 *
 * Models routinely wrap JSON in fences or add a sentence before it; a tolerant scan keeps
 * one stray apostrophe from discarding an otherwise valid extraction.
 */
export function extractJson(text) {
  const raw = String(text ?? '').trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)
  const body = fenced ? fenced[1].trim() : raw
  try {
    return JSON.parse(body)
  } catch {
    // fall through to the balanced scan
  }
  const start = body.indexOf('{')
  if (start === -1) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < body.length; index += 1) {
    const char = body[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(body.slice(start, index + 1))
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

/**
 * Parse a stage-1 reply into the three required fields.
 *
 * @returns {{ rawMemory: string, sessionSummary: string, slug: string, noop: boolean }}
 */
export function parseExtraction(text) {
  const value = extractJson(text)
  if (!value || typeof value !== 'object') {
    throw new Error('stage-1 reply was not a JSON object')
  }
  const rawMemory = typeof value.raw_memory === 'string' ? value.raw_memory.trim() : ''
  const sessionSummary = typeof value.rollout_summary === 'string'
    ? value.rollout_summary.trim()
    : typeof value.session_summary === 'string' ? value.session_summary.trim() : ''
  const slug = typeof value.rollout_slug === 'string'
    ? value.rollout_slug.trim()
    : typeof value.session_slug === 'string' ? value.session_slug.trim() : ''
  return {
    rawMemory,
    sessionSummary,
    slug,
    noop: rawMemory.length === 0 && sessionSummary.length === 0,
  }
}

/**
 * Parse a phase-2 reply into `{ memory, summary }`.
 *
 * Delimiters are forgiving on purpose: a dropped underscore in a delimiter should not cost
 * a whole consolidation pass.
 */
export function parseConsolidation(text) {
  const raw = String(text ?? '')
  const memory = section(raw, ['MEMORY_MD', 'MEMORY__MD', 'MEMORYMD'])
  const summary = section(raw, ['MEMORY_SUMMARY_MD', 'MEMORY_SUMMARY__MD', 'MEMORY_SUMMARYMD'])
  return { memory, summary }
}

function section(text, names) {
  for (const name of names) {
    const start = new RegExp(`<<<\\s*${name}\\s*>>>`, 'i').exec(text)
    if (!start) continue
    const rest = text.slice(start.index + start[0].length)
    const end = new RegExp(`<<<\\s*END_${name}\\s*>>>`, 'i').exec(rest)
    const body = (end ? rest.slice(0, end.index) : rest).trim()
    if (body.length > 0) return body
  }
  return ''
}
