import { useMemo, useState } from "react";
import { CATALOG, PALETTE } from "../floorplan/catalog";
import { itemColor, ROOM_COLOR } from "../floorplan/palette";
import type { Opening, PlacedItem, RoomDef } from "../floorplan/types";
import { sceneApi } from "../scene/sceneApi";
import { useSceneStore } from "../scene/store";
import { RotationDial } from "./RotationDial";

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
  const renameRoom = useSceneStore((s) => s.renameRoom);
  const [editingRoomId, setEditingRoomId] = useState<string | null>(null);
  const rotateItem = useSceneStore((s) => s.rotateItem);
  const setPosition = useSceneStore((s) => s.setPosition);
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
    const scene = sceneApi.exportLfm();
    // eslint-disable-next-line no-console
    console.log("[airflow] LFM scene", scene);
    navigator.clipboard?.writeText(JSON.stringify(scene, null, 2)).catch(() => {});
    const { domain, inlets, outlets, solids, balance } = scene;
    const grid = `${domain.gridDim[0]}×${domain.gridDim[1]}×${domain.gridDim[2]}`;
    const summary =
      `Saved your home’s airflow setup (copied as LFM scene JSON).\n` +
      `Grid ${grid} cells @ ${domain.dx.toFixed(3)} m · ` +
      `${solids.length} solids · ${inlets.length} inlets · ${outlets.length} outlets`;
    const flow = balance.balanced
      ? `\n\nAir balance OK: ${balance.inflow.toFixed(3)} m³/s in = ${balance.outflow.toFixed(3)} m³/s out.`
      : `\n\n⚠ ${balance.note}`;
    alert(summary + (balance.note && balance.balanced ? `\n\n${balance.note}` : flow));
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
        <div className="legend">
          {plan.rooms.map((r) => (
            <span key={r.id} className="leg">
              <span className="dot" style={{ background: ROOM_COLOR[r.type] }} />
              {r.name}
            </span>
          ))}
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
          {["ac", "fan", "heater", "supply", "return"].includes(selected.type) && (
            <>
              <div className="field">
                <span>power</span>
                <button
                  className={selected.on !== false ? "toggle on" : "toggle"}
                  onClick={() => updateItem(selected.id, { on: selected.on === false })}
                >
                  {selected.on !== false ? "On" : "Off"}
                </button>
              </div>
              {selected.on !== false && (
                <div className="tools" style={{ marginTop: 4 }}>
                  {[1, 2, 3].map((lvl) => (
                    <button
                      key={lvl}
                      className={(selected.power ?? 2) === lvl ? "tool active" : "tool"}
                      onClick={() => updateItem(selected.id, { power: lvl })}
                    >
                      {lvl === 1 ? "Low" : lvl === 2 ? "Med" : "High"}
                    </button>
                  ))}
                </div>
              )}
              {selected.type === "fan" && selected.on !== false && (
                <div className="field" style={{ marginTop: 6 }}>
                  <span>sweep left–right</span>
                  <button
                    className={selected.oscillate ? "toggle on" : "toggle"}
                    onClick={() => updateItem(selected.id, { oscillate: !selected.oscillate })}
                    title="Oscillate like a real stand fan — spreads air over a wide arc"
                  >
                    {selected.oscillate ? "Sweeping" : "Fixed"}
                  </button>
                </div>
              )}
            </>
          )}
          <RotationDial
            valueRad={selected.rotationY}
            onChange={(rad) => setPosition(selected.id, selected.position, rad)}
          />
          <div className="btn-row">
            <button onClick={() => rotateItem(selected.id, Math.PI / 2)}>↻ 90°</button>
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
                  {editingRoomId === room.id ? (
                    <input
                      autoFocus
                      defaultValue={room.name}
                      style={{ flex: 1, minWidth: 0, background: "#fff", border: "1px solid var(--accent)", borderRadius: 6, padding: "2px 6px", font: "inherit", fontSize: 12 }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { renameRoom(room.id, (e.target as HTMLInputElement).value); setEditingRoomId(null); }
                        if (e.key === "Escape") setEditingRoomId(null);
                      }}
                      onBlur={(e) => { renameRoom(room.id, e.target.value); setEditingRoomId(null); }}
                    />
                  ) : (
                    <span className="name" style={{ flex: 1 }}>{room.name}</span>
                  )}
                  <button
                    className="x"
                    title="Rename this room (goals like 'keep the bedroom cool' match by name)"
                    onClick={() => setEditingRoomId(editingRoomId === room.id ? null : room.id)}
                  >
                    ✏️
                  </button>
                </div>
                <ul className="list">
                  {items.map((it) => (
                    <li
                      key={it.id}
                      className={it.id === selectedId ? "selected" : ""}
                      onClick={() => selectItem(it.id)}
                    >
                      <span className="swatch" style={{ background: itemColor(it.type) }} />
                      <span className="name">{pretty(it.type === "supply" ? "supply vent" : it.type === "return" ? "return vent" : it.type)}</span>
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
