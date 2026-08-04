import { useState } from "react";
import { MIN_HEIGHT, MIN_LENGTH, MIN_WIDTH } from "../floorplan/home";
import type { StartMode } from "../floorplan/types";
import { useSceneStore } from "../scene/store";
import { SCENARIOS, SCENARIO_ORDER, type ScenarioId } from "../floorplan/scenarios";

/** One glyph per task, so the four cards are distinguishable at a glance rather
 *  than four blocks of similar-looking text. */
const SCENARIO_EMOJI: Record<ScenarioId, string> = {
  winter: "❄️",
  // The studio task is the BIN, not the weather — a sun promises a temperature
  // task and this one has no temperature goal in it at all.
  summer: "🗑️",
  humidity: "💧",
  // …and this slot is the draught task now (see scenarios.ts on the id).
  smell: "🌬️",
};

// First screen: the homeowner enters their home's footprint (length × width ×
// height) in metres or feet. On submit we generate the rooms, walls, windows,
// and furniture scaled to those dimensions.

type Unit = "m" | "ft";
const FT = 0.3048;

const DEFAULTS: Record<Unit, { l: number; w: number; h: number }> = {
  m: { l: 9, w: 7, h: 2.7 },
  ft: { l: 30, w: 23, h: 9 },
};

function Field({
  label,
  value,
  onChange,
  min,
  unit,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min: number;
  unit: Unit;
}) {
  return (
    <label className="setup-field">
      <span>{label}</span>
      <div className="setup-input">
        <input
          type="number"
          min={min}
          step={unit === "ft" ? 1 : 0.1}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        />
        <em>{unit}</em>
      </div>
      <small>
        min {min.toFixed(unit === "ft" ? 0 : 1)} {unit}
      </small>
    </label>
  );
}

export function SetupScreen() {
  const generate = useSceneStore((s) => s.generate);
  const startScenario = useSceneStore((s) => s.startScenario);
  const [mode, setMode] = useState<StartMode>("example");
  const [unit, setUnit] = useState<Unit>("m");
  const [l, setL] = useState(DEFAULTS.m.l);
  const [w, setW] = useState(DEFAULTS.m.w);
  const [h, setH] = useState(DEFAULTS.m.h);

  const switchUnit = (u: Unit) => {
    if (u === unit) return;
    const k = u === "ft" ? 1 / FT : FT;
    setL(Math.round(l * k * 10) / 10);
    setW(Math.round(w * k * 10) / 10);
    setH(Math.round(h * k * 10) / 10);
    setUnit(u);
  };

  const toM = (v: number) => (unit === "ft" ? v * FT : v);
  const minL = unit === "ft" ? MIN_LENGTH / FT : MIN_LENGTH;
  const minW = unit === "ft" ? MIN_WIDTH / FT : MIN_WIDTH;
  const minH = unit === "ft" ? MIN_HEIGHT / FT : MIN_HEIGHT;

  const create = () => generate({ length: toM(l), width: toM(w), height: toM(h) }, mode);

  return (
    <div className="setup">
      <div className="setup-card">
        <h1>🏠 Design your home’s airflow</h1>
        <p className="setup-sub">Pick how you’d like to start, then set your home’s size.</p>

        <div className="mode-cards">
          <button className={mode === "example" ? "mode-card on" : "mode-card"} onClick={() => setMode("example")}>
            <span className="mode-emoji">🛋️</span>
            <strong>Example layout</strong>
            <small>A furnished living room, bedroom, kitchen &amp; bathroom to tweak.</small>
          </button>
          <button className={mode === "blank" ? "mode-card on" : "mode-card"} onClick={() => setMode("blank")}>
            <span className="mode-emoji">📐</span>
            <strong>Start from scratch</strong>
            <small>Just the outer walls — add rooms &amp; furniture yourself.</small>
          </button>
        </div>

        <div className="unit-toggle">
          <button className={unit === "m" ? "on" : ""} onClick={() => switchUnit("m")}>Meters</button>
          <button className={unit === "ft" ? "on" : ""} onClick={() => switchUnit("ft")}>Feet</button>
        </div>

        <div className="setup-fields">
          <Field label="Length" value={l} onChange={setL} min={minL} unit={unit} />
          <Field label="Width" value={w} onChange={setW} min={minW} unit={unit} />
          <Field label="Height" value={h} onChange={setH} min={minH} unit={unit} />
        </div>

        <button className="setup-go" onClick={create}>
          {mode === "blank" ? "Start designing →" : "Create my home →"}
        </button>
        <p className="setup-foot">You can change the size later, or edit walls and furniture anytime.</p>

        {/* Facilitator entry point for the user study. Each scenario loads its
            own prebuilt home and shows only the controls that task is about.
            Four cards on an even 2×2 grid: the old flex row put three on one
            line and stretched the fourth across the next, and the titles wrap
            to different depths so no two cards were the same height. The title
            is "<home> · <task> · <type>", which reads badly as one run-on line —
            the home leads, the rest sits under it as the qualifier it is. */}
        <div className="setup-scenarios">
          <div className="setup-scenarios-label">Study scenarios</div>
          <div className="setup-scenario-grid">
            {SCENARIO_ORDER.map((id) => {
              const [home, ...rest] = SCENARIOS[id].title.split(" · ");
              return (
                <button
                  key={id}
                  className="setup-scenario"
                  onClick={() => startScenario(id)}
                  title={SCENARIOS[id].brief}
                >
                  <span className="setup-scenario-emoji">{SCENARIO_EMOJI[id]}</span>
                  <strong>{home}</strong>
                  <small>{rest.join(" · ")}</small>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
