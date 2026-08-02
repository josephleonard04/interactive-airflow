import { useMemo, useState } from "react";
import { CATALOG, PALETTE } from "../floorplan/catalog";
import { SCENARIOS, canMove } from "../floorplan/scenarios";
import { itemColor, ROOM_COLOR } from "../floorplan/palette";
import type { Opening, PlacedItem, RoomDef } from "../floorplan/types";
import { sceneApi } from "../scene/sceneApi";
import { useSceneStore } from "../scene/store";
import { RotationDial } from "./RotationDial";
import { GoalLogger } from "./GoalLogger";
import { SubmitTask } from "./SubmitTask";

/** One-per-home appliances in a study task — the Add button caps at this. */
const ADD_MAX: Record<string, number> = { heater: 1, fan: 1, ac: 1 };

/** Item type → what a person would call it. "Return vent" is HVAC jargon and,
 *  worse, ambiguous about which way the air goes — the whole task turns on it
 *  pulling air OUT, so the name says so. */
const PRETTY: Record<string, string> = {
  return: "extract vent",
  supply: "fresh-air inlet",
  damp: "steam",
  smell: "smell source",
  kitchen_sink: "kitchen sink",
  ac: "air conditioner",
};

function pretty(t: string) {
  return PRETTY[t] ?? t.replace(/_/g, " ");
}

function roomName(id: string | "outside", rooms: RoomDef[]) {
  if (id === "outside") return "Outside";
  return rooms.find((r) => r.id === id)?.name ?? id;
}

/** Which wall of its room an opening sits on, in the words someone looking at
 *  the screen would use. Two windows in ONE room both came out as
 *  "Window · Studio", which is unusable in a task where choosing between them
 *  IS the task — the list has to say which is which. Screen-down is +z. */
function openingSide(o: Opening, rooms: RoomDef[]): string {
  const room = rooms.find((r) => r.id === o.rooms[0]);
  if (!room) return "";
  const { x, z, w, d } = room.rect;
  const vertical = Math.abs(o.a[0] - o.b[0]) < 1e-3; // runs along z → on a left/right wall
  if (vertical) return Math.abs(o.a[0] - x) < Math.abs(o.a[0] - (x + w)) ? "left wall" : "right wall";
  return Math.abs(o.a[1] - z) < Math.abs(o.a[1] - (z + d)) ? "top wall" : "bottom wall";
}

function openingLabel(o: Opening, rooms: RoomDef[]) {
  const kind = o.kind === "door" ? "Door" : "Window";
  if (o.rooms[1] === "outside") {
    const room = roomName(o.rooms[0], rooms);
    return o.kind === "door" ? `Entrance · ${room}` : `Window · ${room}`;
  }
  return `${kind} · ${roomName(o.rooms[0], rooms)} ↔ ${roomName(o.rooms[1], rooms)}`;
}

/** The label plus a wall, used when one room has several exterior windows. */
function openingLabelDetailed(o: Opening, rooms: RoomDef[], disambiguate: boolean) {
  const base = openingLabel(o, rooms);
  if (!disambiguate || o.rooms[1] !== "outside" || o.kind !== "window") return base;
  return `${base} · ${openingSide(o, rooms)}`;
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

  const scenarioId = useSceneStore((s) => s.scenarioId);
  const tools = useSceneStore((s) => s.tools);
  /** Structural openings never go, and a task can freeze the set entirely. */
  const canRemoveOpening = (o: Opening) => !o.fixed && !(scenarioId && tools.editOpeningSet === false);
  const scenario = scenarioId ? SCENARIOS[scenarioId] : null;

  // Palette filtered to whatever this task is about. Outside a scenario
  // `addable` is empty, which means "no restriction" — the full palette.
  const palette = useMemo(() => {
    if (tools.addable.length === 0) return scenarioId ? [] : PALETTE;
    return [{ group: "For this task", types: tools.addable.filter((t) => CATALOG[t]) }];
  }, [tools.addable, scenarioId]);

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
      {/* Product branding, and the home's dimensions, are for the app — not for
          a task. In a study session the participant has one job, and a title, a
          tagline and a "7.0 × 8.0 × 2.7 m" they cannot change are three things
          to read past before reaching it. The room legend stays: it names the
          rooms the brief talks about. */}
      {!scenario && (
        <>
          <h1>Interactive Airflow</h1>
          <p className="subtitle">design your home’s airflow — no expertise needed</p>
        </>
      )}

      <section>
        {!scenario && (
          <>
            <h2>Your home</h2>
            <div className="home-size">
              <span>
                {length.toFixed(1)} × {width.toFixed(1)} × {height.toFixed(1)} m
              </span>
              {tools.resize && (
                <button className="ghost" onClick={openSetup}>
                  Change size
                </button>
              )}
            </div>
          </>
        )}
        <div className="legend">
          {plan.rooms.map((r) => (
            <span key={r.id} className="leg">
              <span className="dot" style={{ background: ROOM_COLOR[r.type] }} />
              {r.name}
            </span>
          ))}
        </div>
      </section>

      {/* The brief stays on screen for the whole task — participants should not
          have to remember it, and re-reading it is not a finding.
          Four labelled parts rather than one paragraph: the situation, what done
          looks like, and both halves of the boundary. They are what the tick-list
          used to imply and never said. */}
      {scenario && (
        <section className="selected-box" style={{ borderLeft: "3px solid var(--accent)" }}>
          <h2 style={{ marginBottom: 6 }}>{scenario.title}</h2>
          {scenario.situation ? (
            <>
              <BriefPart label="Situation" text={scenario.situation} />
              <BriefPart label="Your goal" text={scenario.goal ?? ""} accent />
              <BriefPart label="You can change" text={scenario.youCanChange} />
              {scenario.youCannotChange && <BriefPart label="You cannot change" text={scenario.youCannotChange} />}
            </>
          ) : (
            // Tasks not yet split into parts still show the one-paragraph brief.
            <>
              <p style={{ fontSize: 12.5, lineHeight: 1.5, margin: "0 0 6px" }}>{scenario.brief}</p>
              <p className="muted-line" style={{ margin: 0 }}>
                <b>You can change:</b> {scenario.youCanChange}
              </p>
            </>
          )}
        </section>
      )}

      {/* Scores the task's goals silently into the session log. Renders nothing:
          the participant decides when they are done, not a tick-box. */}
      <GoalLogger />

      {/* …and the way out of it. Directly under the tick-list, because "am I
          done?" and "I'm done" are the same thought. */}
      <SubmitTask />

      <section>
        <h2>Edit the space</h2>
        <div className="tools">
          <button className={mode === "select" ? "tool active" : "tool"} onClick={() => setMode("select")}>
            ✋ Move / select
          </button>
          {tools.walls && (
            <button
              className={mode === "draw-wall" ? "tool active" : "tool"}
              onClick={() => setMode(mode === "draw-wall" ? "select" : "draw-wall")}
            >
              ➕ Add wall
            </button>
          )}
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
              {/* Power is hidden when the task locks it — see ScenarioTools.lockPower. */}
              {!tools.lockPower && (
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
                </>
              )}
              {tools.lockPower && <p className="muted-line">Running on medium — the setting is fixed for this task.</p>}
              {/* Aim is NOT gated on the device being on. Which way a fan points
                  is a placement decision the participant makes while setting up,
                  and hiding the controls on an idle fan made them look missing. */}
              {selected.type === "fan" && (
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
              {(selected.type === "ac" || selected.type === "fan") && (
                <div className="field" style={{ marginTop: 6 }}>
                  <span>vertical aim (− down / + up) · {Math.round(((selected.tilt ?? 0) * 180) / Math.PI)}°</span>
                  <input
                    type="range"
                    min={-60}
                    max={60}
                    step={5}
                    value={Math.round(((selected.tilt ?? 0) * 180) / Math.PI)}
                    onChange={(e) => updateItem(selected.id, { tilt: (Number(e.target.value) * Math.PI) / 180 })}
                    title="Tilt the airflow up (+) or down (−). 0° = straight out along the facing."
                  />
                </div>
              )}
            </>
          )}
          {/* An EXTRACT has no aim. It pulls air in from every direction at
              once, so a dial captioned "way it blows" is both meaningless and
              actively misleading about which way the air is going — and this
              task turns on understanding exactly that. */}
          {selected.type !== "return" && (
            <>
              <RotationDial
                valueRad={selected.rotationY}
                onChange={(rad) => setPosition(selected.id, selected.position, rad)}
              />
              <div className="btn-row">
                <button onClick={() => rotateItem(selected.id, Math.PI / 2)}>↻ 90°</button>
              </div>
            </>
          )}
          <div className="btn-row">
            {/* Removal is offered only if the task would let you put it back.
                With an empty "add" palette a delete is unrecoverable — the
                participant loses the one heater the task depends on and has to
                restart. */}
            {canMove(tools, selected.type) && (!scenarioId || tools.addable.includes(selected.type)) && (
              <button className="danger" onClick={() => removeItem(selected.id)}>
                🗑 Remove
              </button>
            )}
          </div>
        </section>
      )}

      {/* Nothing here is offered on a task that has fixed the building: cutting
          a new window or knocking a wall out is not one of the moves, and a
          panel full of buttons that would rewrite the room is worse than no
          panel at all — it invites the participant to solve the task by
          demolishing the wall the smell is on the other side of. */}
      {selectedWallId && !selected && (tools.walls || tools.editOpeningSet !== false) && (
        <section className="selected-box">
          <h2>Selected · wall</h2>
          <p className="muted-line">
            {tools.editOpeningSet === false
              ? "Remove this wall."
              : "Add a door or window to this wall, or remove it."}
          </p>
          {tools.editOpeningSet !== false && (
            <div className="btn-row">
              <button onClick={() => addToWall("door")}>🚪 Add door</button>
              <button onClick={() => addToWall("window")}>🪟 Add window</button>
            </div>
          )}
          {tools.walls && (
            <button className="danger" onClick={removeSelected}>
              🗑 Remove this wall
            </button>
          )}
        </section>
      )}

      {selectedOpening && (
        <section className="selected-box">
          <h2>Selected · {selectedOpening.kind}</h2>
          <p className="muted-line">{openingLabel(selectedOpening, plan.rooms)}</p>
          <div className="btn-row">
            <button
              className={selectedOpening.open ? "toggle on" : "toggle"}
              disabled={selectedOpening.locked}
              title={selectedOpening.locked ? "This one stays as it is for this task" : undefined}
              onClick={() => !selectedOpening.locked && toggleOpening(selectedOpening.id)}
            >
              {selectedOpening.open ? "Open ✓" : "Closed"}
            </button>
            {canRemoveOpening(selectedOpening) && (
              <button className="danger" onClick={() => removeOpening(selectedOpening.id)}>
                🗑 Remove
              </button>
            )}
          </div>
          {selectedOpening.fixed && (
            <p className="muted-line">Fixed by the building — you can open and close it, but not move it.</p>
          )}
        </section>
      )}

      {/* In a study scenario the home is already built and furnished, so the
          palette is filtered to the few things the task is actually about —
          offering "add a bed" in a task about vent placement is noise the
          participant has to read past. Empty allowlist hides it entirely. */}
      {palette.length > 0 && (
        <section>
          <h2>{scenarioId ? "Add" : "Add furniture & air"}</h2>
          {palette.map((group) => (
            <div key={group.group} className="palette-group">
              {!scenarioId && <div className="palette-label">{group.group}</div>}
              <div className="chips">
                {group.types.map((t) => {
                  const limit = scenarioId ? ADD_MAX[t] : undefined;
                  const maxed = limit != null && plan.items.filter((it) => it.type === t).length >= limit;
                  return (
                    <button
                      key={t}
                      className="chip"
                      disabled={maxed}
                      onClick={() => !maxed && addItem(t)}
                      title={maxed ? `${CATALOG[t].label} already placed (max ${limit})` : `Add ${CATALOG[t].label}`}
                    >
                      <span className="swatch" style={{ background: itemColor(t) }} />
                      {CATALOG[t].label}
                      {maxed ? " ✓" : ""}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          <p className="muted-line">New items drop in the centre — drag them where you want.</p>
        </section>
      )}

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
              <span className="name">
                {openingLabelDetailed(
                  o,
                  plan.rooms,
                  // …only when this room has more than one window to tell apart.
                  plan.windows.filter((x) => x.rooms[0] === o.rooms[0] && x.rooms[1] === "outside").length > 1,
                )}
              </span>
              <button
                className={o.open ? "toggle on" : "toggle"}
                disabled={o.locked}
                title={
                  o.locked
                    ? "Stays as it is for this task"
                    : o.open
                      ? "Open — click to close"
                      : "Closed — click to open"
                }
                onClick={(e) => {
                  e.stopPropagation();
                  if (!o.locked) toggleOpening(o.id);
                }}
              >
                {o.open ? "Open" : "Closed"}
              </button>
              {canRemoveOpening(o) && (
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
              )}
            </li>
          ))}
        </ul>
        {tools.editOpeningSet === false ? (
          <p className="muted-line">
            The doors and windows are part of the building.{" "}
            {[...plan.doors, ...plan.windows].some((o) => !o.fixed)
              ? "You can open and close them, and drag the window this task is about onto any wall of its room."
              : "You can open and close them, but not move them."}
          </p>
        ) : (
          <p className="muted-line">To add one: click a wall in the view, then “Add door / window”.</p>
        )}
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
                  {/* The task names its rooms — "get BOTH rooms warm" — so the
                      names have to still mean that at the end of the session. */}
                  {!scenario && (
                    <button
                      className="x"
                      title="Rename this room (goals like 'keep the bedroom cool' match by name)"
                      onClick={() => setEditingRoomId(editingRoomId === room.id ? null : room.id)}
                    >
                      ✏️
                    </button>
                  )}
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
                      {/* Same rule as the selected-item panel above: you may
                          only delete what the task would let you put back.
                          Otherwise it is a one-way trap, and the two things most
                          likely to go are the heater and the fan the task is
                          about. */}
                      {(!scenarioId || tools.addable.includes(it.type)) && (
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
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </section>

      {/* Exporting the solver scene is a developer's button. In a task it sits
          one row above "Submit — I'm done" and looks like the way to hand the
          session in, which it is not. */}
      {!scenario && (
        <section className="actions">
          <button className="primary" onClick={exportBC}>
            💾 Save airflow setup
          </button>
        </section>
      )}
    </aside>
  );
}

/** One labelled part of the brief. The label carries the meaning, so it is the
 *  bold thing; the text is ordinary prose at reading size, not muted grey —
 *  "you cannot change the walls" is a rule, not a footnote. */
function BriefPart({ label, text, accent }: { label: string; text: string; accent?: boolean }) {
  return (
    <div style={{ marginBottom: 7 }}>
      <div
        style={{
          fontSize: 10,
          fontWeight: 800,
          letterSpacing: 0.6,
          textTransform: "uppercase",
          color: accent ? "var(--accent-ink-soft, #156d63)" : "var(--muted)",
          marginBottom: 1,
        }}
      >
        {label}
      </div>
      <p style={{ fontSize: 12.5, lineHeight: 1.5, margin: 0 }}>{text}</p>
    </div>
  );
}
