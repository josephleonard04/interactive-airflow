import { RoundedBox } from "@react-three/drei";
import { itemColor } from "../floorplan/palette";
import type { Vec3 } from "../floorplan/types";

// Composite furniture models built from primitives so items read as real
// furniture rather than plain boxes. Each model is authored in a local frame
// centred at the origin, spanning `size` = [width, height, depth], facing +z
// (its back is at −z, so it sits flush when placed against a wall). The parent
// <group> applies the world position and rotation.

type V = Vec3;

function Box({
  size,
  position = [0, 0, 0],
  color,
  roughness = 0.65,
  metalness = 0,
  emissive,
}: {
  size: V;
  position?: V;
  color: string;
  roughness?: number;
  metalness?: number;
  emissive?: string;
}) {
  const r = Math.min(0.03, Math.min(size[0], size[1], size[2]) * 0.45);
  return (
    <RoundedBox args={size} radius={r} smoothness={2} position={position} castShadow>
      <meshStandardMaterial
        color={color}
        roughness={roughness}
        metalness={metalness}
        emissive={emissive ?? "#000000"}
        emissiveIntensity={emissive ? 0.5 : 0}
      />
    </RoundedBox>
  );
}

function Cyl({ r, h, position = [0, 0, 0], color, metalness = 0.6 }: { r: number; h: number; position?: V; color: string; metalness?: number }) {
  return (
    <mesh position={position} castShadow>
      <cylinderGeometry args={[r, r, h, 12]} />
      <meshStandardMaterial color={color} roughness={0.4} metalness={metalness} />
    </mesh>
  );
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

const DARK = "#5b4a36";
const METAL = "#9aa3ad";

function Bed([w, h, d]: V) {
  const c = itemColor("bed");
  return (
    <group>
      <Box size={[w, h * 0.55, d]} position={[0, -h * 0.2, 0]} color={DARK} />
      <Box size={[w * 0.94, h * 0.5, d * 0.9]} position={[0, h * 0.06, d * 0.03]} color="#ece6da" roughness={0.9} />
      <Box size={[w, h * 1.3, d * 0.09]} position={[0, h * 0.25, -d / 2 + d * 0.045]} color={c} />
      <Box size={[w * 0.36, h * 0.18, d * 0.16]} position={[-w * 0.22, h * 0.3, -d / 2 + d * 0.17]} color="#ffffff" roughness={1} />
      <Box size={[w * 0.36, h * 0.18, d * 0.16]} position={[w * 0.22, h * 0.3, -d / 2 + d * 0.17]} color="#ffffff" roughness={1} />
    </group>
  );
}

function LegTable([w, h, d]: V, topFrac: number) {
  const c = itemColor("desk");
  const legH = h * (1 - topFrac);
  const lx = w / 2 - 0.06;
  const lz = d / 2 - 0.06;
  return (
    <group>
      <Box size={[w, h * topFrac, d]} position={[0, h / 2 - (h * topFrac) / 2, 0]} color={c} />
      {([[lx, lz], [-lx, lz], [lx, -lz], [-lx, -lz]] as Array<[number, number]>).map(([x, z], i) => (
        <Box key={i} size={[0.06, legH, 0.06]} position={[x, -h / 2 + legH / 2, z]} color={DARK} />
      ))}
    </group>
  );
}

function Closet([w, h, d]: V) {
  const c = itemColor("closet");
  return (
    <group>
      <Box size={[w, h, d]} position={[0, 0, 0]} color={c} />
      <Box size={[0.02, h * 0.86, 0.02]} position={[0, 0, d / 2]} color={DARK} />
      <Box size={[0.035, 0.14, 0.04]} position={[-0.07, 0, d / 2 + 0.01]} color={METAL} metalness={0.6} />
      <Box size={[0.035, 0.14, 0.04]} position={[0.07, 0, d / 2 + 0.01]} color={METAL} metalness={0.6} />
    </group>
  );
}

function Couch([w, h, d]: V) {
  const c = itemColor("couch");
  const arm = w * 0.12;
  return (
    <group>
      <Box size={[w, h * 0.4, d]} position={[0, -h * 0.1, 0]} color={c} />
      <Box size={[w, h * 0.6, d * 0.26]} position={[0, h * 0.16, -d / 2 + d * 0.13]} color={c} />
      <Box size={[arm, h * 0.55, d]} position={[-w / 2 + arm / 2, h * 0.02, 0]} color={c} />
      <Box size={[arm, h * 0.55, d]} position={[w / 2 - arm / 2, h * 0.02, 0]} color={c} />
      <Box size={[(w - arm * 2) * 0.48, h * 0.16, d * 0.7]} position={[-(w - arm * 2) * 0.25, h * 0.12, d * 0.06]} color="#9aa6ba" roughness={0.9} />
      <Box size={[(w - arm * 2) * 0.48, h * 0.16, d * 0.7]} position={[(w - arm * 2) * 0.25, h * 0.12, d * 0.06]} color="#9aa6ba" roughness={0.9} />
    </group>
  );
}

function Tv([w, h, d]: V) {
  return (
    <group>
      <Box size={[w, h, Math.max(d, 0.05)]} position={[0, 0, 0]} color="#11161e" />
      <Box size={[w * 0.92, h * 0.86, 0.012]} position={[0, 0, Math.max(d, 0.05) / 2 + 0.007]} color="#2b6cb0" emissive="#1e3a8a" roughness={0.3} />
    </group>
  );
}

function Fridge([w, h, d]: V) {
  return (
    <group>
      <Box size={[w, h, d]} position={[0, 0, 0]} color={itemColor("fridge")} roughness={0.4} metalness={0.2} />
      <Box size={[w, 0.02, 0.02]} position={[0, h * 0.12, d / 2]} color="#b7c0c8" />
      <Box size={[0.04, h * 0.28, 0.04]} position={[w / 2 - 0.09, h * 0.28, d / 2]} color={METAL} metalness={0.6} />
      <Box size={[0.04, h * 0.22, 0.04]} position={[w / 2 - 0.09, -h * 0.08, d / 2]} color={METAL} metalness={0.6} />
    </group>
  );
}

function Sink([w, h, d]: V) {
  return (
    <group>
      <Box size={[w, h * 0.78, d]} position={[0, -h * 0.11, 0]} color={itemColor("sink")} />
      <Box size={[w, h * 0.1, d]} position={[0, h * 0.39, 0]} color="#eef2f5" roughness={0.4} />
      <Box size={[w * 0.5, h * 0.12, d * 0.55]} position={[0, h * 0.36, 0]} color="#c3ccd2" metalness={0.3} />
      <Cyl r={0.018} h={0.18} position={[0, h * 0.52, -d * 0.26]} color={METAL} />
      <Cyl r={0.016} h={0.14} position={[0, h * 0.6, -d * 0.2]} color={METAL} />
    </group>
  );
}

function Toilet([w, h, d]: V) {
  return (
    <group>
      {/* tank against the back (−z) */}
      <Box size={[w * 0.85, h * 0.6, d * 0.28]} position={[0, h * 0.1, -d / 2 + d * 0.14]} color="#eef3f6" />
      {/* bowl */}
      <mesh position={[0, -h * 0.05, d * 0.08]} castShadow>
        <cylinderGeometry args={[w * 0.42, w * 0.34, h * 0.5, 18]} />
        <meshStandardMaterial color="#f3f7fa" roughness={0.4} />
      </mesh>
      {/* seat / lid */}
      <Box size={[w * 0.8, h * 0.07, d * 0.55]} position={[0, h * 0.22, d * 0.08]} color="#fbfdff" />
    </group>
  );
}

function Bathtub([w, h, d]: V) {
  return (
    <group>
      <Box size={[w, h, d]} position={[0, 0, 0]} color={itemColor("bathtub")} roughness={0.35} />
      {/* recessed basin */}
      <Box size={[w * 0.86, h * 0.7, d * 0.78]} position={[0, h * 0.22, 0]} color="#cfdde6" roughness={0.25} />
      {/* faucet */}
      <Cyl r={0.02} h={0.16} position={[-w / 2 + 0.12, h * 0.55, -d / 2 + 0.12]} color={METAL} />
    </group>
  );
}

/** Wall-mounted split unit. `tilt` swings the LOUVRE, not the casing — the box
 *  is screwed to the wall and only the blade across its mouth moves, which is
 *  what you are setting when you aim one of these.
 *
 *  It moves at all because it did not: the vertical-aim slider changed the
 *  physics and nothing on screen, so a participant could set it, watch the
 *  picture change, and have no idea which control had done it — or drag the
 *  slider to the end and reasonably conclude it was broken. */
function Ac([w, h, d]: V, tilt = 0, yaw = 0) {
  // The blade reads the tilt back at roughly life size: a real louvre swings
  // about 60 degrees end to end, which is the slider's own range.
  const blade = clamp(-tilt, -Math.PI / 3, Math.PI / 3);
  // …and the SIDEWAYS aim is the vertical vanes behind it, not the box. `yaw`
  // arrives as the offset from the wall the casing is fixed to (see mountYaw),
  // so it is 0 for a unit blowing straight out and the vanes stand square.
  const vane = clamp(yaw, -Math.PI / 3, Math.PI / 3);
  const vanes = 5;
  return (
    <group>
      <Box size={[w, h, d]} position={[0, 0, 0]} color="#eef1f4" roughness={0.5} />
      {/* vertical vanes across the mouth, turned to the sideways aim */}
      {Array.from({ length: vanes }, (_, i) => (
        <mesh
          key={i}
          position={[(-w * 0.35) + (i * w * 0.7) / (vanes - 1), -h * 0.12, d / 2 - 0.012]}
          rotation={[0, vane, 0]}
        >
          <boxGeometry args={[0.012, h * 0.34, d * 0.42]} />
          <meshStandardMaterial color="#aeb7c0" roughness={0.55} />
        </mesh>
      ))}
      {/* the louvre, hinged along the bottom lip of the mouth */}
      <group position={[0, -h * 0.28, d / 2]} rotation={[blade, 0, 0]}>
        <Box size={[w * 0.82, 0.03, d * 0.55]} position={[0, 0, d * 0.26]} color="#c2cad2" />
      </group>
      <Box size={[0.06, 0.03, 0.02]} position={[w * 0.3, h * 0.2, d / 2]} color="#34d399" emissive="#10b981" />
    </group>
  );
}

function Heater([w, h, d]: V) {
  const c = itemColor("heater");
  const fins = 7;
  return (
    <group>
      <Box size={[w, h, d * 0.45]} position={[0, 0, -d * 0.22]} color={c} />
      {Array.from({ length: fins }, (_, i) => {
        const x = -w / 2 + (w / (fins - 1)) * i;
        return <Box key={i} size={[w * 0.07, h * 0.9, d]} position={[x, 0, 0]} color={c} roughness={0.5} metalness={0.3} />;
      })}
    </group>
  );
}

// Simple standing floor fan, facing +z (rotationY aims it). Just blades on a
// hub — no cage ring.
// Pedestal fan: wide overlapping paddle blades on a motor housing, on a
// pole + weighted base. Faces +z; no cage ring.
function Fan([w, h, d]: V, tilt = 0) {
  const r = w * 0.6;
  const blades = 5;
  // The HEAD tips on its neck; the pole and base stay upright, which is how a
  // pedestal fan actually works and makes the vertical-aim slider visible.
  const head = clamp(-tilt, -Math.PI / 3, Math.PI / 3);
  return (
    <group>
      {/* weighted base (disc + slight dome) + pole + neck */}
      <Cyl r={w * 0.44} h={0.05} position={[0, -h / 2 + 0.025, 0]} color="#5c6671" metalness={0.5} />
      <mesh position={[0, -h / 2 + 0.07, 0]}>
        <sphereGeometry args={[w * 0.22, 18, 12, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshStandardMaterial color="#6b7480" metalness={0.45} roughness={0.45} />
      </mesh>
      <Cyl r={0.024} h={h * 0.66} position={[0, -h * 0.08, 0]} color="#c2c8cf" metalness={0.55} />
      {/* head */}
      <group position={[0, h * 0.32, 0]} rotation={[head, 0, 0]}>
        {/* motor housing behind the blades */}
        <mesh position={[0, 0, -d * 0.1]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[w * 0.17, w * 0.21, d * 0.26, 22]} />
          <meshStandardMaterial color="#7a828c" metalness={0.55} roughness={0.4} />
        </mesh>
        {/* overlapping paddle blades */}
        {Array.from({ length: blades }, (_, i) => (
          <group key={i} rotation={[0, 0, (i * Math.PI * 2) / blades]}>
            <mesh position={[0, r * 0.5, d * 0.02]} rotation={[0.42, 0, 0]}>
              <boxGeometry args={[r * 0.62, r * 0.98, 0.012]} />
              <meshStandardMaterial color="#eef3f8" roughness={0.4} metalness={0.05} side={2} />
            </mesh>
          </group>
        ))}
        {/* hub cap */}
        <mesh position={[0, 0, d * 0.05]}>
          <sphereGeometry args={[w * 0.12, 16, 16]} />
          <meshStandardMaterial color="#5c6671" metalness={0.6} roughness={0.35} />
        </mesh>
      </group>
    </group>
  );
}

/** A grille with a RUNNING LIGHT.
 *
 *  A vent gives nothing away by looking at it: the slats look identical whether
 *  air is pouring through them or nothing is happening at all. In the studio
 *  task the extract is the one part of the room the participant cannot switch,
 *  and the brief has to say so in words — "runs all night and cannot be switched
 *  off" — because the object itself was mute. A small indicator lamp is how
 *  every real extract fan says it: green while it runs, red when it does not. */
function Vent([w, h, d]: V, on = true) {
  const slats = 4;
  // Sized off the grille, not as a fraction of it: at 7.5% of the short side the
  // lamp came out about a centimetre across on a wall vent seen from across the
  // room, which is present but not visible.
  // A small rectangular indicator, the shape these actually are on an extract
  // fan. The round bead read as a bulb stuck on the grille; a lozenge reads as
  // part of it. Sized in the grille's own proportions so it stays a detail —
  // roughly a fifth of the face across and a sliver deep.
  const lw = Math.max(0.03, w * 0.2);
  const ld = Math.max(0.012, d * 0.13);
  const lit = on ? "#00e05a" : "#ff2d2d";
  return (
    <group>
      <Box size={[w, h * 0.5, d]} position={[0, 0, 0]} color="#c7d0d8" metalness={0.3} />
      {Array.from({ length: slats }, (_, i) => {
        const z = -d / 2 + (d / (slats + 1)) * (i + 1);
        return <Box key={i} size={[w * 0.86, 0.012, 0.03]} position={[0, h * 0.2, z]} color="#8b95a1" />;
      })}
      {/* The lamp, lying flat on the face beside the slats: a lit lozenge with
          one faint bloom around it. The bloom is what makes it findable from
          across the room — an emissive material does not actually cast light in
          this renderer, so the lozenge alone only reads close up. No dark
          surround; at this size a black ring read as a hole in the vent rather
          than a lamp mounted on it. */}
      <group position={[w * 0.28, h * 0.26, 0]}>
        <mesh>
          <boxGeometry args={[lw, 0.008, ld]} />
          <meshStandardMaterial color={lit} emissive={lit} emissiveIntensity={4} roughness={0.15} toneMapped={false} />
        </mesh>
        <mesh position={[0, -0.002, 0]}>
          <boxGeometry args={[lw * 1.5, 0.006, ld * 2.2]} />
          <meshBasicMaterial color={lit} transparent opacity={0.2} depthWrite={false} toneMapped={false} />
        </mesh>
      </group>
    </group>
  );
}

// Kitchen unit: a counter combining a sink (left) and a stove cooktop with four
// burners + an oven (right). Clearly distinct from the small bathroom sink.
function KitchenSink([w, h, d]: V) {
  const burner = (x: number, z: number) => (
    <mesh position={[x, h * 0.46, z]} rotation={[Math.PI / 2, 0, 0]}>
      <cylinderGeometry args={[w * 0.08, w * 0.08, 0.02, 20]} />
      <meshStandardMaterial color="#3a3f47" metalness={0.3} roughness={0.6} />
    </mesh>
  );
  return (
    <group>
      {/* cabinet base + counter top */}
      <Box size={[w, h * 0.8, d]} position={[0, -h * 0.1, 0]} color="#d8c6a6" />
      <Box size={[w, h * 0.1, d]} position={[0, h * 0.4, 0]} color="#eef1f4" roughness={0.4} />
      {/* oven door on the stove (right) front */}
      <Box size={[w * 0.44, h * 0.5, 0.03]} position={[w * 0.24, -h * 0.08, d / 2]} color="#7d8893" metalness={0.4} roughness={0.4} />
      <Box size={[w * 0.34, 0.035, 0.04]} position={[w * 0.24, h * 0.12, d / 2 + 0.01]} color="#aab4bd" metalness={0.6} />
      {/* sink basin (left) */}
      <Box size={[w * 0.38, h * 0.16, d * 0.6]} position={[-w * 0.26, h * 0.36, 0]} color="#aab4bd" metalness={0.6} roughness={0.3} />
      <Cyl r={0.02} h={0.2} position={[-w * 0.26, h * 0.55, -d * 0.28]} color="#9aa3ad" />
      <Cyl r={0.016} h={0.14} position={[-w * 0.26, h * 0.63, -d * 0.22]} color="#9aa3ad" />
      {/* stove cooktop (right) with four burners */}
      <Box size={[w * 0.46, 0.04, d * 0.86]} position={[w * 0.24, h * 0.47, 0]} color="#2b2f36" roughness={0.5} />
      {burner(w * 0.13, -d * 0.2)}
      {burner(w * 0.35, -d * 0.2)}
      {burner(w * 0.13, d * 0.2)}
      {burner(w * 0.35, d * 0.2)}
    </group>
  );
}

/** A placed CONTAMINANT SOURCE: a glowing orb on a small stem with a wisp ring
 *  over it, so it reads as something being given off rather than an object.
 *
 *  ONE SHAPE, TWO HUES. Smell and moisture are the same thing to the solver —
 *  a scalar the airflow has to carry out — and they are the same question to
 *  the participant: this is where it comes from, now go and design around it.
 *  Drawing them as two different objects made that look like two different
 *  kinds of problem, and the moisture one went through three shapes of its own
 *  (a puddle, a stack of rings, a plume of puffs) chasing a likeness to steam
 *  that was never what the marker is for. So the shape is shared and only the
 *  colour changes, which is exactly the relationship the two field ramps have.
 *
 *  Each palette is its own ramp's business end: violet is where the smell ramp
 *  goes when the air is foul, blue is where the damp ramp goes when the wall is
 *  wet. A source therefore matches the worst reading around it instead of
 *  competing with the field for the same pixels. */
interface SourcePalette {
  /** The stem — the darkest of the three, so it reads against a pale floor. */
  stem: string;
  /** The orb, and its glow. */
  orb: string;
  orbGlow: string;
  /** The wisp ring above it — the palest, so it reads as vapour. */
  wisp: string;
}

function SourceOrb(size: V, c: SourcePalette): JSX.Element {
  const r = Math.min(size[0], size[2]) * 0.42;
  return (
    <group>
      <Box size={[0.05, size[1] * 0.5, 0.05]} position={[0, size[1] * 0.25, 0]} color={c.stem} />
      <mesh position={[0, size[1] * 0.6, 0]} castShadow>
        <sphereGeometry args={[r, 18, 18]} />
        <meshStandardMaterial color={c.orb} emissive={c.orbGlow} emissiveIntensity={0.7} toneMapped={false} />
      </mesh>
      <mesh position={[0, size[1] * 0.9, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[r * 0.7, 0.012, 8, 20]} />
        <meshStandardMaterial color={c.wisp} emissive={c.orb} emissiveIntensity={0.5} toneMapped={false} transparent opacity={0.7} />
      </mesh>
    </group>
  );
}

/** Odour. Violet, the foul end of the smell ramp. */
function Smell(size: V): JSX.Element {
  return SourceOrb(size, { stem: "#7c3aed", orb: "#a855f7", orbGlow: "#7c3aed", wisp: "#c084fc" });
}

/** Moisture. The same orb as the smell source, in the wet end of the DAMP ramp:
 *  a deep blue stem, a bright water-blue orb and a pale cyan wisp.
 *
 *  Four shapes were tried here before giving up and reusing the smell one. A
 *  puddle with wisps read as spilled water — something that has already
 *  happened and is lying there — when what it represents is vapour being
 *  produced now and going up. A stack of widening rings said "rising" from the
 *  side, but the top view is the one people plan in, and from directly above a
 *  stack of horizontal rings is a wifi icon on the floor. A plume of puffs
 *  survived both angles but competed with the humidity field for the same
 *  pixels. A flat magenta disc beat the field but then matched nothing: an
 *  off-ramp colour on an off-ramp shape, the only object in the app drawn that
 *  way, which is its own kind of confusing.
 *
 *  None of that was ever the problem to solve. The marker's job is "the wet
 *  comes from HERE", which is the same job the smell source already does well,
 *  and the app is more legible when the same job looks the same. The colour
 *  carries the difference, because the colour is the thing that already means
 *  moisture everywhere else on screen. */
function Damp(size: V): JSX.Element {
  // DRAWN AT THE SMELL SOURCE'S SIZE, not at its own footprint. The damp item is
  // 0.5 m square where the smell one is 0.34, so sharing the geometry made the
  // orb half again as wide — a blue balloon in a small bathroom. The footprint
  // is what seeds the wet cells and is not a drawing decision, so the drawing
  // ignores it and matches the object it is a sibling of.
  const SMELL_FOOTPRINT = 0.34;
  const draw: V = [SMELL_FOOTPRINT, size[1], SMELL_FOOTPRINT];
  return SourceOrb(draw, { stem: "#0b5e94", orb: "#1c9fd6", orbGlow: "#0e7fb8", wisp: "#7fd4ef" });
}

/** Shower: a riser and a head on the wall over a shallow tray. NO GLASS.
 *
 *  The cubicle used to be two translucent panels, which read as a box from
 *  above and — worse — was a real flow obstacle a metre and a half tall sitting
 *  in the corner the steam comes off. An open wet area is both what most of
 *  these rooms actually have and a far more honest picture of where the air can
 *  go: the head is the thing to point at, and nothing blocks the corner. */
function Shower([w, h, d]: V): JSX.Element {
  return (
    <group>
      {/* shallow tray, just enough to read as the wet patch of floor */}
      <Box size={[w, 0.04, d]} position={[0, -h / 2 + 0.02, 0]} color="#e4ebee" roughness={0.45} />
      {/* riser up the back wall */}
      <Box size={[0.045, h * 0.62, 0.045]} position={[0, h * 0.06, -d / 2 + 0.06]} color="#b9c2c7" metalness={0.6} roughness={0.3} />
      {/* the gooseneck arm out from the riser */}
      <Box size={[0.04, 0.04, 0.22]} position={[0, h * 0.37, -d / 2 + 0.17]} color="#b9c2c7" metalness={0.6} roughness={0.3} />
      {/* the head itself, tilted down into the room */}
      <mesh position={[0, h * 0.34, -d / 2 + 0.29]} rotation={[Math.PI / 2.3, 0, 0]} castShadow>
        <cylinderGeometry args={[0.11, 0.11, 0.035, 20]} />
        <meshStandardMaterial color="#c8d0d4" metalness={0.7} roughness={0.22} />
      </mesh>
      {/* the mixer valve, so it reads as plumbing rather than a lamp */}
      <mesh position={[0, -h * 0.06, -d / 2 + 0.07]} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <cylinderGeometry args={[0.05, 0.05, 0.05, 14]} />
        <meshStandardMaterial color="#b9c2c7" metalness={0.6} roughness={0.3} />
      </mesh>
    </group>
  );
}

/** Kitchen bin: a tapered body with a lid, standing slightly open. The lid is
 *  the point — a closed bin is not a smell you have to design around, and the
 *  participant has to be able to see at a glance where the smell is coming
 *  from without reading a label. */
function Bin(size: V): JSX.Element {
  const r = Math.min(size[0], size[2]) * 0.5;
  const h = size[1];
  return (
    <group>
      <mesh position={[0, h * 0.45, 0]} castShadow>
        <cylinderGeometry args={[r, r * 0.82, h * 0.9, 20]} />
        <meshStandardMaterial color="#8d949b" roughness={0.55} metalness={0.25} />
      </mesh>
      {/* lid, tipped back so the bin reads as open */}
      <mesh position={[0, h * 0.95, -r * 0.25]} rotation={[-0.45, 0, 0]} castShadow>
        <cylinderGeometry args={[r * 1.06, r * 1.06, h * 0.07, 20]} />
        <meshStandardMaterial color="#6f767d" roughness={0.5} metalness={0.3} />
      </mesh>
      {/* the bag inside, just visible over the rim */}
      <mesh position={[0, h * 0.9, 0]}>
        <cylinderGeometry args={[r * 0.9, r * 0.9, h * 0.06, 16]} />
        <meshStandardMaterial color="#4b5563" roughness={0.9} />
      </mesh>
    </group>
  );
}

export function Model({ type, size, on = true, tilt = 0, yaw = 0 }: { type: string; size: V; on?: boolean; tilt?: number; yaw?: number }) {
  switch (type) {
    case "bed":
      return Bed(size);
    case "kitchen_sink":
      return KitchenSink(size);
    case "desk":
      return LegTable(size, 0.08);
    case "table":
      return LegTable(size, 0.14);
    case "closet":
      return Closet(size);
    case "couch":
      return Couch(size);
    case "tv":
      return Tv(size);
    case "fridge":
      return Fridge(size);
    case "sink":
      return Sink(size);
    case "toilet":
      return Toilet(size);
    case "bathtub":
      return Bathtub(size);
    case "ac":
      return Ac(size, tilt, yaw);
    case "heater":
      return Heater(size);
    case "fan":
      return Fan(size, tilt);
    case "supply":
      return Vent(size, on);
    case "return":
      return Vent(size, on);
    case "shower":
      return Shower(size);
    case "damp":
      return Damp(size);
    case "bin":
      return Bin(size);
    case "smell":
      return Smell(size);
    default:
      return <Box size={size} color={itemColor(type)} />;
  }
}
