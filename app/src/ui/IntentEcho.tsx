import { Check, RotateCcw, SlidersHorizontal } from 'lucide-react'
import {
  describeIntentEntry,
  describeSession,
  getActiveIntentEntries,
  type IntentSessionEntry,
  type IntentSessionState,
} from '../intent/session.ts'

export function IntentEcho({
  onAccept,
  onAdjust,
  onUndo,
  session,
}: {
  onAccept: (entryId: string) => void
  onAdjust: (entryId: string) => void
  onUndo: (entryId: string) => void
  session: IntentSessionState
}) {
  const activeEntries = getActiveIntentEntries(session)

  return (
    <section className="panel-section intent-echo" aria-label="Intent echo">
      <div className="section-title intent-echo-title">
        <SlidersHorizontal size={18} />
        Intent echo
        <span>{activeEntries.length} active</span>
      </div>
      <p className="intent-echo-summary">{describeSession(session)}</p>
      {activeEntries.length > 0 ? (
        <div className="intent-echo-list">
          {activeEntries.map((entry) => (
            <IntentEchoCard
              entry={entry}
              key={entry.entryId}
              onAccept={onAccept}
              onAdjust={onAdjust}
              onUndo={onUndo}
            />
          ))}
        </div>
      ) : (
        <p className="intent-echo-empty">Accepted or pending intents will appear here with grounded highlights.</p>
      )}
    </section>
  )
}

function IntentEchoCard({
  entry,
  onAccept,
  onAdjust,
  onUndo,
}: {
  entry: IntentSessionEntry
  onAccept: (entryId: string) => void
  onAdjust: (entryId: string) => void
  onUndo: (entryId: string) => void
}) {
  const confidence = Math.round((entry.intent.confidence ?? 0.68) * 100)

  return (
    <article className={`intent-echo-card ${entry.status}`}>
      <div>
        <strong>{describeIntentEntry(entry)}</strong>
        <small>
          {entry.status} · confidence {confidence}%
        </small>
      </div>
      <div className="intent-echo-actions">
        <button onClick={() => onAccept(entry.entryId)} title="Accept intent" type="button">
          <Check size={14} />
          Accept
        </button>
        <button onClick={() => onAdjust(entry.entryId)} title="Strengthen this intent" type="button">
          <SlidersHorizontal size={14} />
          Adjust
        </button>
        <button onClick={() => onUndo(entry.entryId)} title="Undo this intent" type="button">
          <RotateCcw size={14} />
          Undo
        </button>
      </div>
    </article>
  )
}
