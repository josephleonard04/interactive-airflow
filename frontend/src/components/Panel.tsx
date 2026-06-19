import { useSceneStore } from "../scene/store";
import { sceneApi } from "../scene/sceneApi";
import type { ObjectKind, Vec3 } from "../scene/types";

// Left-hand control panel: add objects, see/select the object list, inspect &
// nudge the selected object, and export boundary conditions. Everything here
// goes through the same store/api the mouse and the intent layer use.

const KIND_LABEL: Record<ObjectKind, string> = {
  furniture: "Furniture",
  supply: "Supply",
  return: "Return",
};

function NumberField({
  label,
  value,
  onChange,
  step = 0.1,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        step={step}
        value={Number.isFinite(value) ? Number(value.toFixed(3)) : 0}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
      />
    </label>
  );
}

export function Panel() {
  const objects = useSceneStore((s) => s.objects);
  const selectedId = useSceneStore((s) => s.selectedId);
  const select = useSceneStore((s) => s.select);
  const addObject = useSceneStore((s) => s.addObject);
  const removeObject = useSceneStore((s) => s.removeObject);
  const setPosition = useSceneStore((s) => s.setPosition);
  const updateObject = useSceneStore((s) => s.updateObject);
  const reset = useSceneStore((s) => s.reset);

  const selected = objects.find((o) => o.id === selectedId) ?? null;

  const exportBC = () => {
    const bc = sceneApi.exportBoundaryConditions();
    // eslint-disable-next-line no-console
    console.log("[airflow] boundary conditions", bc);
    navigator.clipboard?.writeText(JSON.stringify(bc, null, 2)).catch(() => {});
    alert("Boundary conditions logged to console and copied to clipboard.");
  };

  return (
    <aside className="panel">
      <h1>Interactive Airflow</h1>
      <p className="subtitle">3D room editor — intent-to-physics</p>

      <section>
        <h2>Add object</h2>
        <div className="row">
          <button onClick={() => addObject({ kind: "furniture", name: "Furniture" })}>
            + Furniture
          </button>
          <button onClick={() => addObject({ kind: "supply", name: "AC supply" })}>
            + Supply
          </button>
          <button onClick={() => addObject({ kind: "return", name: "Return" })}>
            + Return
          </button>
        </div>
      </section>

      <section>
        <h2>Objects</h2>
        <ul className="list">
          {objects.map((o) => (
            <li
              key={o.id}
              className={o.id === selectedId ? "selected" : ""}
              onClick={() => select(o.id)}
            >
              <span className={`dot ${o.kind}`} />
              <span className="name">{o.name}</span>
              <span className="kind">{KIND_LABEL[o.kind]}</span>
              <button
                className="x"
                onClick={(e) => {
                  e.stopPropagation();
                  removeObject(o.id);
                }}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      </section>

      {selected && (
        <section>
          <h2>Selected: {selected.name}</h2>
          <label className="field">
            <span>Name</span>
            <input
              type="text"
              value={selected.name}
              onChange={(e) => updateObject(selected.id, { name: e.target.value })}
            />
          </label>
          <div className="grid3">
            {(["x", "y", "z"] as const).map((axis, i) => (
              <NumberField
                key={axis}
                label={`pos ${axis}`}
                value={selected.position[i]}
                onChange={(v) => {
                  const p = [...selected.position] as Vec3;
                  p[i] = v;
                  setPosition(selected.id, p);
                }}
              />
            ))}
          </div>
          {selected.kind !== "furniture" && (
            <NumberField
              label="flow (m³/s)"
              value={selected.flow ?? 0}
              step={0.01}
              onChange={(v) => updateObject(selected.id, { flow: v })}
            />
          )}
        </section>
      )}

      <section className="actions">
        <button className="primary" onClick={exportBC}>
          Export boundary conditions
        </button>
        <button onClick={reset}>Reset scene</button>
      </section>

      <p className="hint">
        Drag the gizmo to move the selected object. Or script it:
        <code>airflow.translate(id, [0.5, 0, 0])</code> in the console.
      </p>
    </aside>
  );
}
