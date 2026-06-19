import { useMemo } from "react";
import { itemColor, ROOM_COLOR } from "../floorplan/palette";
import { HOUSING_TYPES, TEMPLATES } from "../floorplan/templates";
import type { PlacedItem, Vec3 } from "../floorplan/types";
import { sceneApi } from "../scene/sceneApi";
import { useSceneStore } from "../scene/store";

function prettyType(t: string) {
  return t.replace(/_/g, " ");
}

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
  const plan = useSceneStore((s) => s.plan);
  const housingType = useSceneStore((s) => s.housingType);
  const selectedId = useSceneStore((s) => s.selectedId);
  const select = useSceneStore((s) => s.select);
  const generate = useSceneStore((s) => s.generate);
  const setPosition = useSceneStore((s) => s.setPosition);
  const updateItem = useSceneStore((s) => s.updateItem);

  const selected = plan.items.find((it) => it.id === selectedId) ?? null;

  // group items by room for the browser
  const itemsByRoom = useMemo(() => {
    const map = new Map<string, PlacedItem[]>();
    for (const it of plan.items) {
      if (!map.has(it.roomId)) map.set(it.roomId, []);
      map.get(it.roomId)!.push(it);
    }
    return map;
  }, [plan.items]);

  const exportBC = () => {
    const bc = sceneApi.exportBoundaryConditions();
    // eslint-disable-next-line no-console
    console.log("[airflow] boundary conditions", bc);
    navigator.clipboard?.writeText(JSON.stringify(bc, null, 2)).catch(() => {});
    alert(
      `Boundary conditions for "${bc.name}" logged to console and copied.\n` +
        `${bc.rooms.length} rooms · ${bc.walls.length} walls · ${bc.doors.length} doors · ` +
        `${bc.windows.length} windows · ${bc.solids.length} solids · ${bc.flows.length} flows`,
    );
  };

  return (
    <aside className="panel">
      <h1>Interactive Airflow</h1>
      <p className="subtitle">residential floor-plan generator</p>

      <section>
        <h2>Housing type</h2>
        <div className="types">
          {HOUSING_TYPES.map((t) => (
            <button
              key={t}
              className={t === housingType ? "type selected" : "type"}
              onClick={() => generate(t)}
            >
              {TEMPLATES[t].name}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2>
          {plan.name} · {plan.bounds.w.toFixed(1)}×{plan.bounds.d.toFixed(1)} m
        </h2>
        <div className="rooms">
          {plan.rooms.map((room) => {
            const items = itemsByRoom.get(room.id) ?? [];
            return (
              <div key={room.id} className="room-group">
                <div className="room-head">
                  <span className="dot" style={{ background: ROOM_COLOR[room.type] }} />
                  <span className="name">{room.name}</span>
                  <span className="kind">{prettyType(room.type)}</span>
                </div>
                <ul className="list">
                  {items.map((it) => (
                    <li
                      key={it.id}
                      className={it.id === selectedId ? "selected" : ""}
                      onClick={() => select(it.id)}
                    >
                      <span className="swatch" style={{ background: itemColor(it.type) }} />
                      <span className="name">{prettyType(it.type)}</span>
                      <span className="kind">{it.category === "hvac" ? "HVAC" : ""}</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </section>

      {selected && (
        <section>
          <h2>Selected: {prettyType(selected.type)}</h2>
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
          {selected.flow !== undefined && (
            <NumberField
              label="flow (m³/s)"
              value={selected.flow}
              step={0.01}
              onChange={(v) => updateItem(selected.id, { flow: v })}
            />
          )}
        </section>
      )}

      <section className="actions">
        <button className="primary" onClick={exportBC}>
          Export boundary conditions
        </button>
      </section>

      <p className="hint">
        Click an item to select, drag the gizmo to move it. Or script it:
        <code>airflow.generate("two_bedroom")</code>
        <code>airflow.translate("bed-1", [0.5, 0, 0])</code>
      </p>
    </aside>
  );
}
