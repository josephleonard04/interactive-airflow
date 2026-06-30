import { CheckCircle2, Gauge, TriangleAlert } from 'lucide-react'
import type { DeviceState } from '../stableFluidSolver.ts'
import type { IntentSessionState } from '../intent/session.ts'
import type { ZoneMetrics } from '../solver/zoneMetrics.ts'
import type { EditableObjectKey, ObjectTransform } from '../state/appTypes'
import { buildGoalFeedbackItems } from './goalFeedbackModel.ts'

export function GoalFeedback({
  devices,
  metrics,
  session,
  transforms,
}: {
  devices: DeviceState
  metrics: ZoneMetrics
  session: IntentSessionState
  transforms: Record<EditableObjectKey, ObjectTransform>
}) {
  const items = buildGoalFeedbackItems({
    devices,
    metrics,
    session,
    transforms,
  })

  return (
    <section className="panel-section goal-feedback" aria-label="Goal feedback">
      <div className="section-title goal-feedback-title">
        <Gauge size={18} />
        Goal feedback
        <span>{items.length} goal{items.length === 1 ? '' : 's'}</span>
      </div>
      {items.length > 0 ? (
        <div className="goal-feedback-list">
          {items.map((item) => (
            <article className={`goal-feedback-card ${item.status}`} key={item.id}>
              {item.status === 'ok' ? <CheckCircle2 size={18} /> : <TriangleAlert size={18} />}
              <div>
                <strong>{item.title}</strong>
                <small>{item.detail}</small>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p className="goal-feedback-empty">Choose a template or enter a request to see whether each airflow goal is being met.</p>
      )}
    </section>
  )
}
