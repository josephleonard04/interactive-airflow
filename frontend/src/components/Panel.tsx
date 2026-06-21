import { useMemo } from "react";
import { CATALOG, PALETTE } from "../floorplan/catalog";
import { itemColor, ROOM_COLOR } from "../floorplan/palette";
import type { Opening, PlacedItem, RoomDef } from "../floorplan/types";
import { sceneApi } from "../scene/sceneApi";
import { useSceneStore } from "../scene/store";

function pretty(t: string) {
  return t.replace(/_/g, " ");
}

function roomName(id: string | "outside", rooms: RoomDef[]) {
  if (id === "outside") return "Outside";
  return rooms.find((r) => r.id === id)?.name ?? id;
}

function openingLabel(o: Opening, rooms: RoomDef[]) {
  const kind = o.kind === "door" ? "Door" : "Window";
  if (o.rooms[1] === "outside") {
    return o.kind === "door"
      ? `Entrance · ${roomName(o.rooms[0], rooms)}`
      : `Window · ${roomName(o.rooms[0], rooms)}`;
  }
  return `${kind} · ${roomName(o.rooms[0], rooms)} ↔ ${roomName(o.rooms[1], rooms)}`;
}

export function Panel() {
  const plan = useSceneStore((s) => s.plan);
  const mode = useSceneStore((s) => s.mode);
  const selectedId = useSceneStore((s) => s.selectedId);
  const selectedWallId = useSceneStore((s) => s.selectedWallId);
  const selectedOpeningId = useSceneStore((s) => s.selectedOpeningId);
  const openSetup = useSceneStore((s) => s.openSetup);
  const setMode = useSceneStore((s) => s.setMode);
  const undo = useSceneStore((s) => s.undo);
  const redo = useSceneStore((s) => s.redo);
  const canUndo = useSceneStore((s) => s.past.length > 0);
  const canRedo = useSceneStore((s) => s.future.length > 0);
  const selectItem = useSceneStore((s) => s.selectItem);
  const selectOpening = useSceneStore((s) => s.selectOpening);
  const removeItem = useSceneStore((s) => s.removeItem);
  const removeSelected = useSceneStore((s) => s.removeSelected);
  const updateItem = useSceneStore((s) => s.updateItem);
  const rotateItem = useSceneStore((s) => s.rotateItem);
  const addItem = useSceneStore((s) => s.addItem);
  const addOpening = useSceneStore((s) => s.addOpening);
  const removeOpening = useSceneStore((s) => s.removeOpening);
  const toggleOpening = useSceneStore((s) => s.toggleOpening);

  const selected = plan.items.find((it) => it.id === selectedId) ?? null;
  const openings = useMemo(() => [...plan.doors, ...plan.windows], [plan.doors, plan.windows]);
  const selectedOpening = openings.find((o) => o.id === selectedOpeningId) ?? null;

  const itemsByRoom = useMemo(() => {
    const map = new Map<string, PlacedItem[]>();
    for (const it of plan.items) {
      if (!map.has(it.roomId)) map.set(it.roomId, []);
      map.get(it.roomId)!.push(it);
    }
    return map;
  }, [plan.items]);

  const addToWall = (kind: "door" | "window") => {
    if (!selectedWallId) return;
    const id = addOpening(selectedWallId, kind);
    if (!id) alert("Not enough free space on this wall — try a longer wall.");
  };

  const exportBC = () => {
    const bc = sceneApi.exportBoundaryConditions();
    // eslint-disable-next-line no-console
    console.log("[airflow] boundary conditions", bc);
    navigator.clipboard?.writeText(JSON.stringify(bc, null, 2)).catch(() => {});
    alert(
      `Saved your home’s airflow setup.\n` +
        `${bc.rooms.length} rooms · ${bc.doors.length} doors · ${bc.windows.length} windows · ` +
        `${bc.solids.length} furniture · ${bc.flows.length} vents`,
    );
  };

  const { length, width, height } = plan.size;

  return (
    <aside className="panel">
      <h1>Interactive Airflow</h1>
      <p className="subtitle">design your home’s airflow — no expertise needed</p>

      <section>
        <h2>Your home</h2>
        <div className="home-size">
          <span>
            {length.toFixed(1)} × {width.toFixed(1)} × {height.toFixed(1)} m
          </span>
          <button className="ghost" onClick={openSetup}>
            Change size
          </button>
        </div>
      </section>

      <section>
        <h2>Edit the space</h2>
        <div className="tools">
          <button className={mode === "select" ? "tool active" : "tool"} onClick={() => setMode("select")}>
            ✋ Move / select
          </button>
          <button
            className={mode === "draw-wall" ? "tool active" : "tool"}
            onClick={() => setMode(mode === "draw-wall" ? "select" : "draw-wall")}
          >
            ➕ Add wall
          </button>
        </div>
        <div className="tools" style={{ marginTop: 6 }}>
          <button className="tool" onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)">
            ↶ Undo
          </button>
          <button className="tool" onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)">
            ↷ Redo
          </button>
        </div>
        {mode === "draw-wall" ? (
          <p className="banner">Click two points on the floor to add a wall. Esc to stop.</p>
        ) : (
          <p className="muted-line">
            Click an item and drag to move it. Press <b>R</b> to rotate it 90°. Click a wall to add a
            door/window, or a door/window to open or remove it.
          </p>
        )}
      </section>

      {/* contextual inspector */}
      {selected && (
        <section className="selected-box">
          <h2>Selected · {pretty(selected.type)}</h2>
          <p className="muted-line">
            in {roomName(selected.roomId, plan.rooms)} · drag in the view to move
          </p>
          {selected.flow !== undefined && selected.type !== "fan" && selected.type !== "heater" && (
            <label className="field">
              <span>airflow (m³/s)</span>
              <input
                type="number"
                step={0.01}
                value={Number(selected.flow.toFixed(2))}
                onChange={(e) => updateItem(selected.id, { flow: parseFloat(e.target.value) || 0 })}
              />
            </label>
          )}
          <div className="btn-row">
            <button onClick={() => rotateItem(selected.id, Math.PI / 2)}>↻ Rotate 90°</button>
            <button className="danger" onClick={() => removeItem(selected.id)}>
              🗑 Remove
            </button>
          </div>
        </section>
      )}

      {selectedWallId && !selected && (
        <section className="selected-box">
          <h2>Selected · wall</h2>
          <p className="muted-line">Add a door or window to this wall, or remove it.</p>
          <div className="btn-row">
            <button onClick={() => addToWall("door")}>🚪 Add door</button>
            <button onClick={() => addToWall("window")}>🪟 Add window</button>
          </div>
          <button className="danger" onClick={removeSelected}>
            🗑 Remove this wall
          </button>
        </section>
      )}

      {selectedOpening && (
        <section className="selected-box">
          <h2>Selected · {selectedOpening.kind}</h2>
          <p className="muted-line">{openingLabel(selectedOpening, plan.rooms)}</p>
          <div className="btn-row">
            <button
              className={selectedOpening.open ? "toggle on" : "toggle"}
              onClick={() => toggleOpening(selectedOpening.id)}
            >
              {selectedOpening.open ? "Open ✓" : "Closed"}
            </button>
            <button className="danger" onClick={() => removeOpening(selectedOpening.id)}>
              🗑 Remove
            </button>
          </div>
        </section>
      )}

      <section>
        <h2>Add furniture &amp; air</h2>
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
        <h2>Doors &amp; windows</h2>
        <ul className="list">
          {openings.map((o) => (
            <li
              key={o.id}
              className={o.id === selectedOpeningId ? "selected" : ""}
              onClick={() => selectOpening(o.id)}
            >
              <span className="op-ico">{o.kind === "door" ? "🚪" : "🪟"}</span>
              <span className="name">{openingLabel(o, plan.rooms)}</span>
              <button
                className={o.open ? "toggle on" : "toggle"}
                title={o.open ? "Open — click to close" : "Closed — click to open"}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleOpening(o.id);
                }}
              >
                {o.open ? "Open" : "Closed"}
              </button>
              <button
                className="x"
                title="Remove"
                onClick={(e) => {
                  e.stopPropagation();
                  removeOpening(o.id);
                }}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
        <p className="muted-line">To add one: click a wall in the view, then “Add door / window”.</p>
      </section>

      <section>
        <h2>Rooms &amp; objects</h2>
        <div className="rooms">
          {plan.rooms.map((room) => {
            const items = itemsByRoom.get(room.id) ?? [];
            return (
              <div key={room.id} className="room-group">
                <div className="room-head">
                  <span className="dot" style={{ background: ROOM_COLOR[room.type] }} />
                  <span className="name">{room.name}</span>
                </div>
                <ul className="list">
                  {items.map((it) => (
                    <li
                      key={it.id}
                      className={it.id === selectedId ? "selected" : ""}
                      onClick={() => selectItem(it.id)}
                    >
                      <span className="swatch" style={{ background: itemColor(it.type) }} />
                      <span className="name">{pretty(it.type === "supply" ? "vent" : it.type)}</span>
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
