import { useMemo } from "react";
import { CATALOG, PALETTE } from "../floorplan/catalog";
import { itemColor, ROOM_COLOR } from "../floorplan/palette";
import { HOUSING_TYPES, TEMPLATES } from "../floorplan/templates";
import type { PlacedItem } from "../floorplan/types";
import { sceneApi } from "../scene/sceneApi";
import { useSceneStore } from "../scene/store";

function pretty(t: string) {
  return t.replace(/_/g, " ");
}

export function Panel() {
  const plan = useSceneStore((s) => s.plan);
  const housingType = useSceneStore((s) => s.housingType);
  const mode = useSceneStore((s) => s.mode);
  const selectedId = useSceneStore((s) => s.selectedId);
  const selectedWallId = useSceneStore((s) => s.selectedWallId);
  const generate = useSceneStore((s) => s.generate);
  const setMode = useSceneStore((s) => s.setMode);
  const selectItem = useSceneStore((s) => s.selectItem);
  const removeItem = useSceneStore((s) => s.removeItem);
  const removeSelected = useSceneStore((s) => s.removeSelected);
  const updateItem = useSceneStore((s) => s.updateItem);
  const addItem = useSceneStore((s) => s.addItem);

  const selected = plan.items.find((it) => it.id === selectedId) ?? null;

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
      `Saved "${bc.name}" airflow setup.\n` +
        `${bc.rooms.length} rooms · ${bc.walls.length} walls · ${bc.doors.length} doors · ` +
        `${bc.windows.length} windows · ${bc.solids.length} furniture · ${bc.flows.length} vents`,
    );
  };

  return (
    <aside className="panel">
      <h1>Interactive Airflow</h1>
      <p className="subtitle">design your home’s airflow — no expertise needed</p>

      <section>
        <h2>1 · Choose your home</h2>
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
        <p className="muted-line">Switching homes starts a fresh layout.</p>
      </section>

      <section>
        <h2>2 · Edit the space</h2>
        <div className="tools">
          <button
            className={mode === "select" ? "tool active" : "tool"}
            onClick={() => setMode("select")}
          >
            ✋ Move / select
          </button>
          <button
            className={mode === "draw-wall" ? "tool active" : "tool"}
            onClick={() => setMode(mode === "draw-wall" ? "select" : "draw-wall")}
          >
            ➕ Add wall
          </button>
        </div>
        {mode === "draw-wall" ? (
          <p className="banner">Click two points on the floor to add a wall. Esc to stop.</p>
        ) : (
          <p className="muted-line">
            Click an item and drag to move it. Click a wall to select it, then Delete to remove it.
          </p>
        )}
      </section>

      {(selected || selectedWallId) && (
        <section className="selected-box">
          {selected ? (
            <>
              <h2>Selected · {pretty(selected.type)}</h2>
              <p className="muted-line">
                in {plan.rooms.find((r) => r.id === selected.roomId)?.name ?? "—"} · drag in the
                view to move
              </p>
              {selected.flow !== undefined && selected.type !== "fan" && (
                <label className="field">
                  <span>airflow (m³/s)</span>
                  <input
                    type="number"
                    step={0.01}
                    value={Number(selected.flow.toFixed(2))}
                    onChange={(e) =>
                      updateItem(selected.id, { flow: parseFloat(e.target.value) || 0 })
                    }
                  />
                </label>
              )}
              <button className="danger" onClick={() => removeItem(selected.id)}>
                🗑 Remove this {pretty(selected.type)}
              </button>
            </>
          ) : (
            <>
              <h2>Selected · wall</h2>
              <button className="danger" onClick={removeSelected}>
                🗑 Remove this wall
              </button>
            </>
          )}
        </section>
      )}

      <section>
        <h2>3 · Add furniture &amp; vents</h2>
        {PALETTE.map((group) => (
          <div key={group.group} className="palette-group">
            <div className="palette-label">{group.group}</div>
            <div className="chips">
              {group.types.map((t) => (
                <button key={t} className="chip" onClick={() => addItem(t)} title={`Add ${CATALOG[t].label}`}>
                  <span className="swatch" style={{ background: itemColor(t) }} />
                  {CATALOG[t].label}
                </button>
              ))}
            </div>
          </div>
        ))}
        <p className="muted-line">New items drop in the centre — drag them where you want.</p>
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
                  <span className="kind">{pretty(room.type)}</span>
                </div>
                <ul className="list">
                  {items.map((it) => (
                    <li
                      key={it.id}
                      className={it.id === selectedId ? "selected" : ""}
                      onClick={() => selectItem(it.id)}
                    >
                      <span className="swatch" style={{ background: itemColor(it.type) }} />
                      <span className="name">{pretty(it.type)}</span>
                      <span className="kind">{it.category === "hvac" ? "HVAC" : ""}</span>
                      <button
                        className="x"
                        title="Remove"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeItem(it.id);
                        }}
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </section>

      <section className="actions">
        <button className="primary" onClick={exportBC}>
          💾 Save airflow setup
        </button>
      </section>
    </aside>
  );
}
