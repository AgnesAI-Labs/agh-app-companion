import { Kind, str, toolResult } from './publish.mjs'

/**
 * The `ask_owner` tool: how a worker session hands the owner a question. The worker is told to call
 * it and end its turn; the companion records the question on the task and, when the turn ends, tells
 * the owner and waits (reconcile.mjs). The owner's reply to the chat reaches the same session as its
 * next message. A worker session cannot show the owner a platform question card: the owner only
 * sees the chat.
 */

export const ASK_OWNER_TOOL_NAME = 'ask_owner'

const QUESTION_MAX = 2000
const OPTION_MIN_COUNT = 2
const OPTION_MAX_COUNT = 6
const OPTION_MAX = 200
// biome-ignore lint/suspicious/noControlCharactersInRegex: an option is one line; control characters and line breaks are what it refuses.
const LINE_BREAK = /[\u0000-\u001f\u007f\u2028\u2029]/

export const ASK_OWNER_PARAMETERS = {
  [Kind]: 'Object',
  type: 'object',
  additionalProperties: false,
  required: ['question'],
  properties: {
    question: str({ minLength: 1, maxLength: QUESTION_MAX, description: 'What you need the owner to decide.' }),
    options: {
      [Kind]: 'Array',
      type: 'array',
      minItems: OPTION_MIN_COUNT,
      maxItems: OPTION_MAX_COUNT,
      items: str({ minLength: 1, maxLength: OPTION_MAX, description: 'One choice, on one line.' }),
      description: 'The choices, 2 to 6. The owner sees them numbered and can answer with a number.',
    },
  },
}

export const ASK_OWNER_META = Object.freeze({
  isReadOnly: false,
  isDestructive: false,
  isConcurrencySafe: false,
  isOpenWorld: false,
  replay: /** @type {const} */ ('idempotent'),
  requiresApproval: /** @type {const} */ ('never'),
})

/** @param {unknown} args @returns {{ ok: true, question: { text: string, options: string[] } } | { ok: false, detail: string }} */
function parseQuestion(args) {
  const bad = (/** @type {string} */ detail) => ({ ok: /** @type {const} */ (false), detail })
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return bad('arguments must be an object')
  const given = /** @type {Record<string, unknown>} */ (args)
  const extra = Object.keys(given).filter((key) => key !== 'question' && key !== 'options')
  if (extra.length) return bad(`ask_owner does not take ${extra.join(', ')}`)
  const { question, options = [] } = given
  if (typeof question !== 'string' || !question.trim() || [...question].length > QUESTION_MAX)
    return bad(`question must be 1 to ${QUESTION_MAX} characters`)
  if (!Array.isArray(options)) return bad('options must be a list of strings')
  if (options.length && (options.length < OPTION_MIN_COUNT || options.length > OPTION_MAX_COUNT))
    return bad(`options must hold ${OPTION_MIN_COUNT} to ${OPTION_MAX_COUNT} items, or be left out`)
  const fault = options.some(
    (option) => typeof option !== 'string' || !option.trim() || [...option].length > OPTION_MAX || LINE_BREAK.test(option),
  )
  if (fault) return bad(`each option must be 1 to ${OPTION_MAX} characters on one line`)
  return { ok: true, question: { text: question.trim(), options: options.map((option) => option.trim()) } }
}

const refused = (/** @type {string} */ reason, /** @type {string} */ detail) => ({ status: 'refused', reason, detail })

/**
 * @param {() => Promise<{ askOwner(sessionKey: string, question: { text: string, options: string[] }): { ok: boolean } }>} resource
 *   the companion service, which fails while it is not running
 * @returns {import('@agnes/extension-api').ToolDef}
 */
export function askOwnerTool(resource) {
  return {
    name: ASK_OWNER_TOOL_NAME,
    description:
      'Ask the owner to decide something. Give the question and, when there are clear choices, 2 to 6 options. The owner only sees the chat and answers there. After calling it, end your turn at once: the owner’s answer arrives as your next message.',
    parameters: /** @type {never} */ (ASK_OWNER_PARAMETERS),
    meta: ASK_OWNER_META,
    async execute(args, ctx) {
      const parsed = parseQuestion(args)
      if (!parsed.ok) return toolResult(ctx, ASK_OWNER_TOOL_NAME, refused('invalid-input', parsed.detail))
      let service
      try {
        service = await resource()
      } catch {
        return toolResult(ctx, ASK_OWNER_TOOL_NAME, refused('not-running', 'the companion is not running'))
      }
      const recorded = service.askOwner(ctx.session.key, parsed.question)
      return toolResult(
        ctx,
        ASK_OWNER_TOOL_NAME,
        recorded.ok
          ? { status: 'asked', detail: '问题已交给伴侣。现在结束本轮回复，不要再做别的；主人的回答会作为下一条消息送来。' }
          : refused('not-a-task-session', 'ask_owner works only in a running companion task session'),
      )
    },
  }
}
