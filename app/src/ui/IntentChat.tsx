import { useMemo, useRef, useState } from 'react'
import { MessageSquareText, Send, Sparkles } from 'lucide-react'

export type IntentChatMessage = {
  id: string
  role: 'user' | 'system' | 'error'
  text: string
}

export type IntentChatSubmitResult =
  | string
  | {
      text: string
    }

const starterMessages: IntentChatMessage[] = [
  {
    id: 'welcome',
    role: 'system',
    text: 'Describe the comfort you want, or sketch an area on the plan and say "keep this area out of direct draft." I will turn it into editable airflow goals.',
  },
]

const promptChips = [
  'Cool the sofa area slightly',
  'Do not blow air onto the baby',
  'After sketching: keep this area out of direct draft',
  'Purge stale air after cooking',
]

export function IntentChat({
  onSubmitIntent,
}: {
  onSubmitIntent?: (text: string) => IntentChatSubmitResult | Promise<IntentChatSubmitResult | void> | void
}) {
  const [draft, setDraft] = useState('')
  const [messages, setMessages] = useState<IntentChatMessage[]>(starterMessages)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const canSend = draft.trim().length > 0 && !isSubmitting
  const userRequestCount = useMemo(() => messages.filter((message) => message.role === 'user').length, [messages])
  const messageCountLabel = `${userRequestCount} request${userRequestCount === 1 ? '' : 's'}`

  const fillDraft = (text: string) => {
    setDraft(text)
    window.requestAnimationFrame(() => inputRef.current?.focus())
  }

  const submitText = async (text: string) => {
    const trimmed = text.trim()

    if (!trimmed || isSubmitting) {
      return
    }

    const timestamp = Date.now()
    setMessages((current) => [
      ...current,
      {
        id: `user-${timestamp}`,
        role: 'user',
        text: trimmed,
      },
    ])
    setDraft('')
    setIsSubmitting(true)

    try {
      const reply = await onSubmitIntent?.(trimmed)
      const replyText = typeof reply === 'string'
        ? reply
        : reply?.text ?? 'Saved as a pending intent. Parsing and device changes will be added in the next phase.'

      setMessages((current) => [
        ...current,
        {
          id: `system-${timestamp}`,
          role: 'system',
          text: replyText,
        },
      ])
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          id: `error-${timestamp}`,
          role: 'error',
          text: error instanceof Error ? error.message : 'Intent parsing failed.',
        },
      ])
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <section className="panel-section intent-chat" aria-label="Intent chat">
      <div className="section-title intent-chat-title">
        <MessageSquareText size={18} />
        Intent chat
        <span>{messageCountLabel}</span>
      </div>

      <div className="intent-message-list" aria-live="polite">
        {messages.map((message) => (
          <div className={`intent-message ${message.role}`} key={message.id}>
            <span>{message.role === 'user' ? 'You' : message.role === 'error' ? 'Parser' : 'System'}</span>
            <p>{message.text}</p>
          </div>
        ))}
      </div>

      <div className="intent-chip-row" aria-label="Example prompts">
        {promptChips.map((chip) => (
          <button
            key={chip}
            type="button"
            onPointerDown={() => fillDraft(chip)}
            onClick={() => fillDraft(chip)}
          >
            <Sparkles size={13} />
            {chip}
          </button>
        ))}
      </div>

      <form
        className="intent-chat-form"
        onSubmit={(event) => {
          event.preventDefault()
          void submitText(draft)
        }}
      >
        <label className="sr-only" htmlFor="intent-chat-input">
          Describe airflow intent
        </label>
        <textarea
          ref={inputRef}
          id="intent-chat-input"
          value={draft}
          rows={3}
          placeholder="Example: cool the sofa near the window, but avoid direct draft on the baby"
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault()
              void submitText(draft)
            }
          }}
        />
        <button type="submit" disabled={!canSend}>
          <Send size={16} />
          {isSubmitting ? 'Parsing' : 'Send'}
        </button>
      </form>
    </section>
  )
}
