import { useState } from 'react'
import { Home, Ruler, Wind } from 'lucide-react'
import { ROOM } from '../stableFluidSolver'
import type { RoomDimensions } from '../state/appTypes'

type Unit = 'm' | 'ft'
const FT_PER_M = 3.28084

const presets: Array<{ label: string; detail: string; dims: RoomDimensions }> = [
  { label: 'Cozy', detail: '6.0 × 4.5 × 2.6 m', dims: { width: 6.0, depth: 4.5, height: 2.6 } },
  { label: 'Standard', detail: '9.8 × 7.2 × 2.8 m', dims: { width: ROOM.width, depth: ROOM.depth, height: ROOM.height } },
  { label: 'Large', detail: '13 × 9.5 × 3.2 m', dims: { width: 13, depth: 9.5, height: 3.2 } },
]

function round(value: number, places = 2) {
  const f = 10 ** places
  return Math.round(value * f) / f
}

export function SetupScreen({ onStart }: { onStart: (dims: RoomDimensions) => void }) {
  const [unit, setUnit] = useState<Unit>('m')
  const [dims, setDims] = useState<RoomDimensions>(presets[1].dims)

  const toDisplay = (m: number) => (unit === 'm' ? m : round(m * FT_PER_M))
  const fromDisplay = (value: number) => (unit === 'm' ? value : value / FT_PER_M)

  const setField = (key: keyof RoomDimensions, raw: string) => {
    const value = Number.parseFloat(raw)
    if (!Number.isFinite(value) || value <= 0) return
    setDims((current) => ({ ...current, [key]: round(fromDisplay(value), 3) }))
  }

  const fields: Array<{ key: keyof RoomDimensions; label: string; hint: string }> = [
    { key: 'width', label: 'Width', hint: 'left–right' },
    { key: 'depth', label: 'Depth', hint: 'front–back' },
    { key: 'height', label: 'Ceiling', hint: 'floor–ceiling' },
  ]

  const area = round(dims.width * dims.depth, 1)

  return (
    <div className="setup-overlay">
      <div className="setup-card">
        <span className="setup-eyebrow">
          <Wind size={15} />
          Indoor Airflow Studio
        </span>
        <h1 className="setup-title">Set up your room</h1>
        <p className="setup-sub">
          Choose the room size to simulate. You can refine furniture and devices inside the studio.
        </p>

        <div className="setup-presets">
          {presets.map((p) => {
            const active =
              Math.abs(p.dims.width - dims.width) < 0.01 &&
              Math.abs(p.dims.depth - dims.depth) < 0.01 &&
              Math.abs(p.dims.height - dims.height) < 0.01
            return (
              <button
                key={p.label}
                type="button"
                className={active ? 'setup-preset active' : 'setup-preset'}
                onClick={() => setDims(p.dims)}
              >
                <strong>{p.label}</strong>
                <span>{p.detail}</span>
              </button>
            )
          })}
        </div>

        <div className="setup-unit-row">
          <span className="setup-section-label">
            <Ruler size={14} /> Dimensions
          </span>
          <div className="setup-unit">
            {(['m', 'ft'] as Unit[]).map((u) => (
              <button
                key={u}
                type="button"
                className={unit === u ? 'selected' : ''}
                onClick={() => setUnit(u)}
              >
                {u}
              </button>
            ))}
          </div>
        </div>

        <div className="setup-fields">
          {fields.map((f) => (
            <label key={f.key} className="setup-field">
              <span className="setup-field-label">{f.label}</span>
              <div className="setup-input-wrap">
                <input
                  type="number"
                  min={0.5}
                  step={unit === 'm' ? 0.1 : 0.5}
                  value={toDisplay(dims[f.key])}
                  onChange={(event) => setField(f.key, event.target.value)}
                />
                <span className="setup-unit-suffix">{unit}</span>
              </div>
              <span className="setup-field-hint">{f.hint}</span>
            </label>
          ))}
        </div>

        <div className="setup-footer">
          <span className="setup-area">
            <Home size={14} /> Floor area ≈ {area} m²
          </span>
          <button type="button" className="setup-start" onClick={() => onStart(dims)}>
            Enter studio
          </button>
        </div>
      </div>
    </div>
  )
}
