export type DeviceKey = 'fan' | 'ac' | 'vent'
export type ScalarFieldKey = 'temperature' | 'humidity' | 'pm25' | 'co2' | 'noise'

export type DeviceState = Record<
  DeviceKey,
  {
    enabled: boolean
    speed: number
  }
>

export type StableFluidStatus = 'starting' | 'running'

export type StableFluidSnapshot = {
  width: number
  height: number
  layers: number
  velocities: Float32Array
  dye: Uint8ClampedArray
  scalarFields: Record<ScalarFieldKey, Uint8ClampedArray>
  flags: Uint32Array
  volumeVelocities: Float32Array
  volumeDye: Float32Array
  volumeScalars: Record<ScalarFieldKey, Float32Array>
  volumeFlags: Uint32Array
  revision: number
}

export type FlowObstacle = {
  x: number
  z: number
  w: number
  d: number
  rotation: number
  h?: number
}

export type FlowLayout = {
  fan: {
    x: number
    z: number
    rotation: number
  }
  ac: {
    x: number
    y: number
    z: number
    directionX: number
    directionZ: number
  }
  vent: {
    x: number
    y: number
    z: number
  }
  obstacles: FlowObstacle[]
  scalarSources?: ScalarSource[]
}

export type ScalarSource = {
  field: ScalarFieldKey
  x: number
  y: number
  z: number
  radius: number
  rate: number
  target: number
}

const roomWidth = 9.8
const roomDepth = 7.2
const roomHeight = 2.8
const solveIterations = 8
const scalarKeys: ScalarFieldKey[] = ['temperature', 'humidity', 'pm25', 'co2', 'noise']
const scalarAmbient: Record<ScalarFieldKey, number> = {
  temperature: 0.54,
  humidity: 0.48,
  pm25: 0.18,
  co2: 0.28,
  noise: 0.12,
}
const scalarDecay: Record<ScalarFieldKey, number> = {
  temperature: 0.999,
  humidity: 0.9985,
  pm25: 0.995,
  co2: 0.997,
  noise: 0.982,
}

export function createInitialSnapshot(width: number, height: number, layers = 14): StableFluidSnapshot {
  const cellCount = width * height * layers
  const volumeFlags = buildFlags(width, height, layers)
  const volumeScalars = createScalarVolumes(cellCount)

  return {
    width,
    height,
    layers,
    velocities: new Float32Array(width * height * 4),
    dye: new Uint8ClampedArray(width * height * 4),
    scalarFields: buildScalarTextures(width, height, layers, volumeScalars),
    flags: buildProjectionFlags(volumeFlags, width, height, layers),
    volumeVelocities: new Float32Array(cellCount * 4),
    volumeDye: new Float32Array(cellCount),
    volumeScalars,
    volumeFlags,
    revision: 0,
  }
}

export function createSampler(snapshot: StableFluidSnapshot) {
  return (x: number, y: number, z: number) => {
    const gx = Math.min(snapshot.width - 1.001, Math.max(0, ((x + roomWidth / 2) / roomWidth) * snapshot.width))
    const gy = Math.min(snapshot.layers - 1.001, Math.max(0, (y / roomHeight) * snapshot.layers))
    const gz = Math.min(snapshot.height - 1.001, Math.max(0, ((z + roomDepth / 2) / roomDepth) * snapshot.height))
    const x0 = Math.floor(gx)
    const y0 = Math.floor(gy)
    const z0 = Math.floor(gz)
    const x1 = Math.min(snapshot.width - 1, x0 + 1)
    const y1 = Math.min(snapshot.layers - 1, y0 + 1)
    const z1 = Math.min(snapshot.height - 1, z0 + 1)
    const sx = gx - x0
    const sy = gy - y0
    const sz = gz - z0

    const sampleVelocity = (offset: number) =>
      trilinear(snapshot.volumeVelocities, snapshot.width, snapshot.height, x0, x1, y0, y1, z0, z1, sx, sy, sz, offset, 4)
    const solid = snapshot.volumeFlags[index3(x0, y0, z0, snapshot.width, snapshot.height)] === 1

    return {
      x: sampleVelocity(0),
      y: sampleVelocity(1),
      z: sampleVelocity(2),
      speed: sampleVelocity(3),
      dye: trilinear(snapshot.volumeDye, snapshot.width, snapshot.height, x0, x1, y0, y1, z0, z1, sx, sy, sz),
      temperature: trilinear(snapshot.volumeScalars.temperature, snapshot.width, snapshot.height, x0, x1, y0, y1, z0, z1, sx, sy, sz),
      humidity: trilinear(snapshot.volumeScalars.humidity, snapshot.width, snapshot.height, x0, x1, y0, y1, z0, z1, sx, sy, sz),
      pm25: trilinear(snapshot.volumeScalars.pm25, snapshot.width, snapshot.height, x0, x1, y0, y1, z0, z1, sx, sy, sz),
      co2: trilinear(snapshot.volumeScalars.co2, snapshot.width, snapshot.height, x0, x1, y0, y1, z0, z1, sx, sy, sz),
      noise: trilinear(snapshot.volumeScalars.noise, snapshot.width, snapshot.height, x0, x1, y0, y1, z0, z1, sx, sy, sz),
      solid,
    }
  }
}

export function createStableFluidSolver({
  devices,
  height,
  layers = 14,
  layout,
  onSnapshot,
  width,
}: {
  devices: DeviceState
  height: number
  layers?: number
  layout: FlowLayout
  onSnapshot: (snapshot: StableFluidSnapshot) => void
  width: number
}) {
  const core = createStableFluidStepper({ devices, height, layers, layout, width })
  let frameHandle = 0
  let destroyed = false
  let lastTime = performance.now()

  const step = (time: number) => {
    if (destroyed) {
      return
    }

    const dt = Math.min(0.03, Math.max(0.01, (time - lastTime) / 1000))
    lastTime = time

    core.step(dt)

    if (core.revision % 2 === 0) {
      onSnapshot(core.getSnapshot())
    }

    frameHandle = requestAnimationFrame(step)
  }

  onSnapshot(core.getSnapshot())
  frameHandle = requestAnimationFrame(step)

  return {
    destroy: () => {
      destroyed = true
      cancelAnimationFrame(frameHandle)
    },
    updateDevices: (nextDevices: DeviceState) => {
      core.updateDevices(nextDevices)
    },
    updateLayout: (nextLayout: FlowLayout) => {
      core.updateLayout(nextLayout)
      onSnapshot(core.getSnapshot())
    },
  }
}

export function createStableFluidStepper({
  devices,
  height,
  layers = 14,
  layout,
  width,
}: {
  devices: DeviceState
  height: number
  layers?: number
  layout: FlowLayout
  width: number
}) {
  let activeDevices = devices
  let activeLayout = layout
  let revision = 0

  const cellCount = width * height * layers
  const flags = buildFlags(width, height, layers, layout.obstacles)
  const u = new Float32Array(cellCount)
  const v = new Float32Array(cellCount)
  const w = new Float32Array(cellCount)
  const u0 = new Float32Array(cellCount)
  const v0 = new Float32Array(cellCount)
  const w0 = new Float32Array(cellCount)
  const dye = new Float32Array(cellCount)
  const dye0 = new Float32Array(cellCount)
  const scalarFields = createScalarVolumes(cellCount)
  const scalarScratch = createScalarVolumes(cellCount)
  const pressure = new Float32Array(cellCount)
  const divergence = new Float32Array(cellCount)
  const curlX = new Float32Array(cellCount)
  const curlY = new Float32Array(cellCount)
  const curlZ = new Float32Array(cellCount)
  const curlMagnitude = new Float32Array(cellCount)
  const volumeVelocities = new Float32Array(cellCount * 4)

  const getSnapshot = () => {
    for (let index = 0; index < cellCount; index += 1) {
      const base = index * 4
      volumeVelocities[base] = u[index]
      volumeVelocities[base + 1] = v[index]
      volumeVelocities[base + 2] = w[index]
      volumeVelocities[base + 3] = Math.hypot(u[index], v[index], w[index])
    }

    return buildSnapshotFromVolume(width, height, layers, volumeVelocities, dye, scalarFields, flags, revision)
  }

  return {
    get revision() {
      return revision
    },
    getSnapshot,
    step: (dt = 0.016) => {
      addFanSource(width, height, layers, activeDevices, activeLayout, flags, u, v, w, dye, dt)
      addAirConditionerSource(width, height, layers, activeDevices, activeLayout, flags, u, v, w, dye, dt)
      addVentSource(width, height, layers, activeDevices, activeLayout, flags, u, v, w, dye, dt)
      applyScalarSources(width, height, layers, activeDevices, activeLayout, flags, scalarFields, dt)
      applyForces(width, height, layers, flags, u, v, w, dye, scalarFields.temperature, curlX, curlY, curlZ, curlMagnitude, dt)
      applyObstacleBoundary(width, height, layers, flags, u, v, w, dye)
      project(width, height, layers, flags, u, v, w, pressure, divergence)

      u0.set(u)
      v0.set(v)
      w0.set(w)
      advect(width, height, layers, flags, u, u0, u0, v0, w0, dt, 0.994)
      advect(width, height, layers, flags, v, v0, u0, v0, w0, dt, 0.994)
      advect(width, height, layers, flags, w, w0, u0, v0, w0, dt, 0.994)
      project(width, height, layers, flags, u, v, w, pressure, divergence)

      dye0.set(dye)
      advect(width, height, layers, flags, dye, dye0, u, v, w, dt, 0.989)
      scalarKeys.forEach((key) => {
        scalarScratch[key].set(scalarFields[key])
        advect(width, height, layers, flags, scalarFields[key], scalarScratch[key], u, v, w, dt, scalarDecay[key])
        relaxScalarField(flags, scalarFields[key], scalarAmbient[key], dt)
      })
      applyObstacleBoundary(width, height, layers, flags, u, v, w, dye)
      clearSolids(flags, u, v, w, dye, scalarFields)

      revision += 1
    },
    updateDevices: (nextDevices: DeviceState) => {
      activeDevices = nextDevices
    },
    updateLayout: (nextLayout: FlowLayout) => {
      activeLayout = nextLayout
      flags.set(buildFlags(width, height, layers, nextLayout.obstacles))
      clearSolids(flags, u, v, w, dye, scalarFields)
    },
  }
}

function buildSnapshotFromVolume(
  width: number,
  height: number,
  layers: number,
  volumeVelocities: Float32Array,
  volumeDye: Float32Array,
  volumeScalars: Record<ScalarFieldKey, Float32Array>,
  flags: Uint32Array,
  revision: number,
): StableFluidSnapshot {
  const projectionVelocities = new Float32Array(width * height * 4)
  const projectionDye = new Uint8ClampedArray(width * height * 4)
  const projectionFlags = buildProjectionFlags(flags, width, height, layers)

  for (let z = 0; z < height; z += 1) {
    for (let x = 0; x < width; x += 1) {
      let maxDye = 0
      let weightedU = 0
      let weightedW = 0
      let totalWeight = 0

      for (let y = 2; y < layers - 2; y += 1) {
        const index = index3(x, y, z, width, height)
        const velocityBase = index * 4
        const dyeValue = volumeDye[index]
        const weight = Math.max(0.02, dyeValue * 1.4)

        maxDye = Math.max(maxDye, dyeValue)
        weightedU += volumeVelocities[velocityBase] * weight
        weightedW += volumeVelocities[velocityBase + 2] * weight
        totalWeight += weight
      }

      const projectionIndex = z * width + x
      const projectionBase = projectionIndex * 4
      const avgU = totalWeight > 0 ? weightedU / totalWeight : 0
      const avgW = totalWeight > 0 ? weightedW / totalWeight : 0

      projectionVelocities[projectionBase] = avgU
      projectionVelocities[projectionBase + 1] = avgW
      projectionVelocities[projectionBase + 2] = Math.hypot(avgU, avgW)
      projectionVelocities[projectionBase + 3] = maxDye

      projectionDye[projectionBase] = 38
      projectionDye[projectionBase + 1] = 163
      projectionDye[projectionBase + 2] = 151
      projectionDye[projectionBase + 3] = Math.max(0, Math.min(230, maxDye * 255))
    }
  }

  return {
    width,
    height,
    layers,
    velocities: projectionVelocities,
    dye: projectionDye,
    scalarFields: buildScalarTextures(width, height, layers, volumeScalars),
    flags: projectionFlags,
    volumeVelocities: new Float32Array(volumeVelocities),
    volumeDye: new Float32Array(volumeDye),
    volumeScalars: cloneScalarVolumes(volumeScalars),
    volumeFlags: new Uint32Array(flags),
    revision,
  }
}

function createScalarVolumes(cellCount: number): Record<ScalarFieldKey, Float32Array> {
  return {
    temperature: new Float32Array(cellCount).fill(scalarAmbient.temperature),
    humidity: new Float32Array(cellCount).fill(scalarAmbient.humidity),
    pm25: new Float32Array(cellCount).fill(scalarAmbient.pm25),
    co2: new Float32Array(cellCount).fill(scalarAmbient.co2),
    noise: new Float32Array(cellCount).fill(scalarAmbient.noise),
  }
}

function cloneScalarVolumes(scalars: Record<ScalarFieldKey, Float32Array>): Record<ScalarFieldKey, Float32Array> {
  return {
    temperature: new Float32Array(scalars.temperature),
    humidity: new Float32Array(scalars.humidity),
    pm25: new Float32Array(scalars.pm25),
    co2: new Float32Array(scalars.co2),
    noise: new Float32Array(scalars.noise),
  }
}

function buildScalarTextures(
  width: number,
  height: number,
  layers: number,
  volumeScalars: Record<ScalarFieldKey, Float32Array>,
): Record<ScalarFieldKey, Uint8ClampedArray> {
  return {
    temperature: buildScalarTexture(width, height, layers, volumeScalars.temperature, 'temperature'),
    humidity: buildScalarTexture(width, height, layers, volumeScalars.humidity, 'humidity'),
    pm25: buildScalarTexture(width, height, layers, volumeScalars.pm25, 'pm25'),
    co2: buildScalarTexture(width, height, layers, volumeScalars.co2, 'co2'),
    noise: buildScalarTexture(width, height, layers, volumeScalars.noise, 'noise'),
  }
}

function buildScalarTexture(
  width: number,
  height: number,
  layers: number,
  field: Float32Array,
  key: ScalarFieldKey,
) {
  const texture = new Uint8ClampedArray(width * height * 4)

  for (let z = 0; z < height; z += 1) {
    for (let x = 0; x < width; x += 1) {
      let total = 0
      let count = 0

      for (let y = 2; y < layers - 2; y += 1) {
        total += field[index3(x, y, z, width, height)]
        count += 1
      }

      const value = count > 0 ? total / count : scalarAmbient[key]
      const [red, green, blue] = scalarColor(key, value)
      const base = (z * width + x) * 4
      texture[base] = red
      texture[base + 1] = green
      texture[base + 2] = blue
      texture[base + 3] = Math.max(80, Math.min(215, 95 + Math.abs(value - scalarAmbient[key]) * 410))
    }
  }

  return texture
}

function scalarColor(key: ScalarFieldKey, value: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, value))

  if (key === 'temperature') {
    return interpolateColor(
      t < 0.52 ? [55, 126, 184] : [249, 211, 92],
      t < 0.52 ? [249, 211, 92] : [220, 82, 65],
      t < 0.52 ? t / 0.52 : (t - 0.52) / 0.48,
    )
  }

  if (key === 'humidity') {
    return interpolateColor([215, 229, 219], [40, 132, 189], t)
  }

  if (key === 'pm25') {
    return interpolateColor([226, 232, 240], [127, 58, 131], t)
  }

  if (key === 'noise') {
    return interpolateColor(
      t < 0.5 ? [209, 250, 229] : [252, 211, 77],
      t < 0.5 ? [252, 211, 77] : [220, 38, 38],
      t < 0.5 ? t / 0.5 : (t - 0.5) / 0.5,
    )
  }

  return interpolateColor(
    t < 0.55 ? [101, 163, 13] : [246, 192, 67],
    t < 0.55 ? [246, 192, 67] : [204, 65, 53],
    t < 0.55 ? t / 0.55 : (t - 0.55) / 0.45,
  )
}

function interpolateColor(from: number[], to: number[], t: number): [number, number, number] {
  const clamped = Math.max(0, Math.min(1, t))

  return [
    Math.round(from[0] + (to[0] - from[0]) * clamped),
    Math.round(from[1] + (to[1] - from[1]) * clamped),
    Math.round(from[2] + (to[2] - from[2]) * clamped),
  ]
}

function applyScalarSources(
  width: number,
  height: number,
  layers: number,
  devices: DeviceState,
  layout: FlowLayout,
  flags: Uint32Array,
  scalars: Record<ScalarFieldKey, Float32Array>,
  dt: number,
) {
  layout.scalarSources?.forEach((source) => {
    applyScalarSource(width, height, layers, flags, scalars[source.field], source, dt)
  })

  if (devices.fan.enabled) {
    const directionX = -Math.cos(layout.fan.rotation)
    const directionZ = Math.sin(layout.fan.rotation)
    const speed = devices.fan.speed / 100
    const fanSourceBase = {
      x: layout.fan.x + directionX * 0.48,
      y: 1.62,
      z: layout.fan.z + directionZ * 0.48,
      radius: 0.85 + speed * 0.35,
      rate: 1.9 + speed,
    }

    applyScalarSource(width, height, layers, flags, scalars.temperature, {
      ...fanSourceBase,
      field: 'temperature',
      target: 0.36,
    }, dt)
    applyScalarSource(width, height, layers, flags, scalars.humidity, {
      ...fanSourceBase,
      field: 'humidity',
      target: 0.42,
    }, dt)
    applyScalarSource(width, height, layers, flags, scalars.pm25, {
      ...fanSourceBase,
      field: 'pm25',
      target: 0.06,
    }, dt)
    applyScalarSource(width, height, layers, flags, scalars.co2, {
      ...fanSourceBase,
      field: 'co2',
      target: 0.12,
    }, dt)
    applyScalarSource(width, height, layers, flags, scalars.noise, {
      ...fanSourceBase,
      field: 'noise',
      radius: 1.05 + speed * 1.25,
      rate: 1.4 + speed * 2.3,
      target: Math.min(0.92, 0.24 + speed * 0.68),
    }, dt)
  }

  if (devices.ac.enabled) {
    const acSpeed = devices.ac.speed / 100
    const acSourceBase = {
      x: layout.ac.x + layout.ac.directionX * 0.42,
      y: layout.ac.y - 0.08,
      z: layout.ac.z + layout.ac.directionZ * 0.42,
      radius: 1.05 + acSpeed * 0.45,
      rate: 1.35 + acSpeed * 0.75,
    }

    applyScalarSource(width, height, layers, flags, scalars.temperature, {
      ...acSourceBase,
      field: 'temperature',
      target: 0.26,
    }, dt)
    applyScalarSource(width, height, layers, flags, scalars.humidity, {
      ...acSourceBase,
      field: 'humidity',
      target: 0.36,
    }, dt)
    applyScalarSource(width, height, layers, flags, scalars.noise, {
      ...acSourceBase,
      field: 'noise',
      radius: 0.9 + acSpeed * 0.8,
      rate: 0.9 + acSpeed * 1.2,
      target: Math.min(0.72, 0.2 + acSpeed * 0.42),
    }, dt)
  }

  if (devices.vent.enabled) {
    const ventSpeed = devices.vent.speed / 100
    const ventSourceBase = {
      x: layout.vent.x,
      y: layout.vent.y,
      z: layout.vent.z,
      radius: 1.2 + ventSpeed * 0.55,
      rate: 1.6 + ventSpeed * 1.1,
    }

    applyScalarSource(width, height, layers, flags, scalars.pm25, {
      ...ventSourceBase,
      field: 'pm25',
      target: 0.04,
    }, dt)
    applyScalarSource(width, height, layers, flags, scalars.co2, {
      ...ventSourceBase,
      field: 'co2',
      target: 0.08,
    }, dt)
    applyScalarSource(width, height, layers, flags, scalars.noise, {
      ...ventSourceBase,
      field: 'noise',
      radius: 0.85 + ventSpeed * 0.75,
      rate: 1.1 + ventSpeed * 1.4,
      target: Math.min(0.82, 0.22 + ventSpeed * 0.5),
    }, dt)
  }
}

function applyScalarSource(
  width: number,
  height: number,
  layers: number,
  flags: Uint32Array,
  field: Float32Array,
  source: ScalarSource,
  dt: number,
) {
  const centerX = worldToGridX(source.x, width)
  const centerY = worldToGridY(source.y, layers)
  const centerZ = worldToGridZ(source.z, height)
  const radiusX = Math.max(1, Math.ceil((source.radius / roomWidth) * width))
  const radiusY = Math.max(1, Math.ceil((source.radius / roomHeight) * layers))
  const radiusZ = Math.max(1, Math.ceil((source.radius / roomDepth) * height))

  for (let y = centerY - radiusY; y <= centerY + radiusY; y += 1) {
    for (let z = centerZ - radiusZ; z <= centerZ + radiusZ; z += 1) {
      for (let x = centerX - radiusX; x <= centerX + radiusX; x += 1) {
        if (!isInterior(x, y, z, width, height, layers)) {
          continue
        }

        const index = index3(x, y, z, width, height)
        if (flags[index]) {
          continue
        }

        const dx = (x - centerX) / radiusX
        const dy = (y - centerY) / radiusY
        const dz = (z - centerZ) / radiusZ
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)

        if (distance > 1) {
          continue
        }

        const profile = Math.exp(-distance * distance * 3.2)
        const blend = Math.min(1, profile * source.rate * dt)
        field[index] += (source.target - field[index]) * blend
      }
    }
  }
}

function relaxScalarField(flags: Uint32Array, field: Float32Array, ambient: number, dt: number) {
  const relaxation = Math.min(0.014, dt * 0.18)

  for (let index = 0; index < field.length; index += 1) {
    if (flags[index]) {
      field[index] = ambient
      continue
    }

    field[index] = Math.max(0, Math.min(1, field[index] + (ambient - field[index]) * relaxation))
  }
}

function addFanSource(
  width: number,
  height: number,
  layers: number,
  devices: DeviceState,
  layout: FlowLayout,
  flags: Uint32Array,
  u: Float32Array,
  v: Float32Array,
  w: Float32Array,
  dye: Float32Array,
  dt: number,
) {
  if (!devices.fan.enabled) {
    return
  }

  const directionX = -Math.cos(layout.fan.rotation)
  const directionZ = Math.sin(layout.fan.rotation)
  const centerX = worldToGridX(layout.fan.x + directionX * 0.38, width)
  const centerY = worldToGridY(1.62, layers)
  const centerZ = worldToGridZ(layout.fan.z + directionZ * 0.38, height)
  const radiusX = 4
  const radiusY = 4
  const radiusZ = 4
  const speed = devices.fan.speed / 100
  const jetX = directionX * 2.2 * speed
  const jetZ = directionZ * 2.2 * speed

  for (let y = centerY - radiusY; y <= centerY + radiusY; y += 1) {
    for (let z = centerZ - radiusZ; z <= centerZ + radiusZ; z += 1) {
      for (let x = centerX - radiusX; x <= centerX + radiusX; x += 1) {
        if (!isInterior(x, y, z, width, height, layers)) {
          continue
        }

        const index = index3(x, y, z, width, height)
        if (flags[index]) {
          continue
        }

        const dx = (x - centerX) / radiusX
        const dy = (y - centerY) / radiusY
        const dz = (z - centerZ) / radiusZ
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)

        if (distance > 1) {
          continue
        }

        const profile = Math.exp(-distance * distance * 3.8)
        u[index] += jetX * profile * dt * 11
        v[index] += Math.sin((x + z) * 0.37) * profile * speed * dt * 0.9
        w[index] += jetZ * profile * dt * 11
        dye[index] = Math.min(1, dye[index] + profile * dt * 5.8)
      }
    }
  }

  const intakeX = worldToGridX(layout.fan.x - directionX * 0.24, width)
  const intakeY = worldToGridY(1.62, layers)
  const intakeZ = worldToGridZ(layout.fan.z - directionZ * 0.24, height)
  const intakeRadius = 4

  for (let y = intakeY - intakeRadius; y <= intakeY + intakeRadius; y += 1) {
    for (let z = intakeZ - intakeRadius; z <= intakeZ + intakeRadius; z += 1) {
      for (let x = intakeX - intakeRadius; x <= intakeX + intakeRadius; x += 1) {
        if (!isInterior(x, y, z, width, height, layers)) {
          continue
        }

        const index = index3(x, y, z, width, height)
        if (flags[index]) {
          continue
        }

        const dx = intakeX - x
        const dy = intakeY - y
        const dz = intakeZ - z
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)

        if (distance > intakeRadius || distance < 0.001) {
          continue
        }

        const pull = (1 - distance / intakeRadius) * speed * dt * 3.2
        u[index] += (dx / distance) * pull
        v[index] += (dy / distance) * pull
        w[index] += (dz / distance) * pull
      }
    }
  }
}

function addAirConditionerSource(
  width: number,
  height: number,
  layers: number,
  devices: DeviceState,
  layout: FlowLayout,
  flags: Uint32Array,
  u: Float32Array,
  v: Float32Array,
  w: Float32Array,
  dye: Float32Array,
  dt: number,
) {
  if (!devices.ac.enabled) {
    return
  }

  const centerX = worldToGridX(layout.ac.x + layout.ac.directionX * 0.34, width)
  const centerY = worldToGridY(layout.ac.y, layers)
  const centerZ = worldToGridZ(layout.ac.z + layout.ac.directionZ * 0.34, height)
  const radiusX = 5
  const radiusY = 3
  const radiusZ = 4
  const speed = devices.ac.speed / 100
  const jetX = layout.ac.directionX * 1.55 * speed
  const jetZ = layout.ac.directionZ * 1.55 * speed

  for (let y = centerY - radiusY; y <= centerY + radiusY; y += 1) {
    for (let z = centerZ - radiusZ; z <= centerZ + radiusZ; z += 1) {
      for (let x = centerX - radiusX; x <= centerX + radiusX; x += 1) {
        if (!isInterior(x, y, z, width, height, layers)) {
          continue
        }

        const index = index3(x, y, z, width, height)
        if (flags[index]) {
          continue
        }

        const dx = (x - centerX) / radiusX
        const dy = (y - centerY) / radiusY
        const dz = (z - centerZ) / radiusZ
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)

        if (distance > 1) {
          continue
        }

        const profile = Math.exp(-distance * distance * 3.1)
        u[index] += jetX * profile * dt * 7.5
        v[index] += (-0.18 - Math.max(0, dy) * 0.08) * profile * speed * dt
        w[index] += jetZ * profile * dt * 7.5
        dye[index] = Math.min(1, dye[index] + profile * dt * 2.8)
      }
    }
  }
}

function addVentSource(
  width: number,
  height: number,
  layers: number,
  devices: DeviceState,
  layout: FlowLayout,
  flags: Uint32Array,
  u: Float32Array,
  v: Float32Array,
  w: Float32Array,
  dye: Float32Array,
  dt: number,
) {
  if (!devices.vent.enabled) {
    return
  }

  const centerX = worldToGridX(layout.vent.x, width)
  const centerY = worldToGridY(layout.vent.y, layers)
  const centerZ = worldToGridZ(layout.vent.z, height)
  const radius = 6
  const speed = devices.vent.speed / 100

  for (let y = centerY - radius; y <= centerY + radius; y += 1) {
    for (let z = centerZ - radius; z <= centerZ + radius; z += 1) {
      for (let x = centerX - radius; x <= centerX + radius; x += 1) {
        if (!isInterior(x, y, z, width, height, layers)) {
          continue
        }

        const index = index3(x, y, z, width, height)
        if (flags[index]) {
          continue
        }

        const dx = centerX - x
        const dy = centerY - y
        const dz = centerZ - z
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)

        if (distance > radius || distance < 0.001) {
          continue
        }

        const profile = Math.exp(-((distance / radius) ** 2) * 2.2)
        const pull = profile * speed * dt * 5.8
        u[index] += (dx / distance) * pull
        v[index] += (dy / distance) * pull
        w[index] += (dz / distance) * pull
        dye[index] *= Math.max(0, 1 - profile * speed * dt * 1.8)
      }
    }
  }
}

function applyForces(
  width: number,
  height: number,
  layers: number,
  flags: Uint32Array,
  u: Float32Array,
  v: Float32Array,
  w: Float32Array,
  dye: Float32Array,
  temperature: Float32Array,
  curlX: Float32Array,
  curlY: Float32Array,
  curlZ: Float32Array,
  curlMagnitude: Float32Array,
  dt: number,
) {
  curlX.fill(0)
  curlY.fill(0)
  curlZ.fill(0)
  curlMagnitude.fill(0)

  for (let y = 1; y < layers - 1; y += 1) {
    for (let z = 1; z < height - 1; z += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const index = index3(x, y, z, width, height)

        if (flags[index]) {
          continue
        }

        const localCurlX =
          0.5 *
          (w[index3(x, y + 1, z, width, height)] -
            w[index3(x, y - 1, z, width, height)] -
            v[index3(x, y, z + 1, width, height)] +
            v[index3(x, y, z - 1, width, height)])
        const localCurlY =
          0.5 *
          (u[index3(x, y, z + 1, width, height)] -
            u[index3(x, y, z - 1, width, height)] -
            w[index3(x + 1, y, z, width, height)] +
            w[index3(x - 1, y, z, width, height)])
        const localCurlZ =
          0.5 *
          (v[index3(x + 1, y, z, width, height)] -
            v[index3(x - 1, y, z, width, height)] -
            u[index3(x, y + 1, z, width, height)] +
            u[index3(x, y - 1, z, width, height)])

        curlX[index] = localCurlX
        curlY[index] = localCurlY
        curlZ[index] = localCurlZ
        curlMagnitude[index] = Math.hypot(localCurlX, localCurlY, localCurlZ)
      }
    }
  }

  const confinement = 0.34
  const buoyancy = 0.48
  const thermalLift = 0.64

  for (let y = 2; y < layers - 2; y += 1) {
    for (let z = 2; z < height - 2; z += 1) {
      for (let x = 2; x < width - 2; x += 1) {
        const index = index3(x, y, z, width, height)

        if (flags[index]) {
          continue
        }

        const gradX =
          curlMagnitude[index3(x + 1, y, z, width, height)] -
          curlMagnitude[index3(x - 1, y, z, width, height)]
        const gradY =
          curlMagnitude[index3(x, y + 1, z, width, height)] -
          curlMagnitude[index3(x, y - 1, z, width, height)]
        const gradZ =
          curlMagnitude[index3(x, y, z + 1, width, height)] -
          curlMagnitude[index3(x, y, z - 1, width, height)]
        const gradLength = Math.hypot(gradX, gradY, gradZ)

        if (gradLength > 0.00001) {
          const nx = gradX / gradLength
          const ny = gradY / gradLength
          const nz = gradZ / gradLength
          const cx = curlX[index]
          const cy = curlY[index]
          const cz = curlZ[index]

          u[index] += (ny * cz - nz * cy) * confinement * dt
          v[index] += (nz * cx - nx * cz) * confinement * dt
          w[index] += (nx * cy - ny * cx) * confinement * dt
        }

        v[index] += (dye[index] * buoyancy + (temperature[index] - scalarAmbient.temperature) * thermalLift) * dt
      }
    }
  }
}

function project(
  width: number,
  height: number,
  layers: number,
  flags: Uint32Array,
  u: Float32Array,
  v: Float32Array,
  w: Float32Array,
  pressure: Float32Array,
  divergence: Float32Array,
) {
  pressure.fill(0)
  divergence.fill(0)

  for (let y = 1; y < layers - 1; y += 1) {
    for (let z = 1; z < height - 1; z += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const index = index3(x, y, z, width, height)
        if (flags[index]) {
          continue
        }

        divergence[index] =
          -0.5 *
          (u[index3(x + 1, y, z, width, height)] -
            u[index3(x - 1, y, z, width, height)] +
            v[index3(x, y + 1, z, width, height)] -
            v[index3(x, y - 1, z, width, height)] +
            w[index3(x, y, z + 1, width, height)] -
            w[index3(x, y, z - 1, width, height)])
      }
    }
  }

  for (let iteration = 0; iteration < solveIterations; iteration += 1) {
    for (let y = 1; y < layers - 1; y += 1) {
      for (let z = 1; z < height - 1; z += 1) {
        for (let x = 1; x < width - 1; x += 1) {
          const index = index3(x, y, z, width, height)
          if (flags[index]) {
            continue
          }

          pressure[index] =
            (divergence[index] +
              readScalar(pressure, flags, width, height, x + 1, y, z) +
              readScalar(pressure, flags, width, height, x - 1, y, z) +
              readScalar(pressure, flags, width, height, x, y + 1, z) +
              readScalar(pressure, flags, width, height, x, y - 1, z) +
              readScalar(pressure, flags, width, height, x, y, z + 1) +
              readScalar(pressure, flags, width, height, x, y, z - 1)) /
            6
        }
      }
    }
  }

  for (let y = 1; y < layers - 1; y += 1) {
    for (let z = 1; z < height - 1; z += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const index = index3(x, y, z, width, height)
        if (flags[index]) {
          u[index] = 0
          v[index] = 0
          w[index] = 0
          continue
        }

        u[index] -= 0.5 * (readScalar(pressure, flags, width, height, x + 1, y, z) - readScalar(pressure, flags, width, height, x - 1, y, z))
        v[index] -= 0.5 * (readScalar(pressure, flags, width, height, x, y + 1, z) - readScalar(pressure, flags, width, height, x, y - 1, z))
        w[index] -= 0.5 * (readScalar(pressure, flags, width, height, x, y, z + 1) - readScalar(pressure, flags, width, height, x, y, z - 1))
      }
    }
  }
}

function advect(
  width: number,
  height: number,
  layers: number,
  flags: Uint32Array,
  target: Float32Array,
  source: Float32Array,
  u: Float32Array,
  v: Float32Array,
  w: Float32Array,
  dt: number,
  decay: number,
) {
  const xScale = dt * width * 0.82
  const yScale = dt * layers * 0.82
  const zScale = dt * height * 0.82

  for (let y = 1; y < layers - 1; y += 1) {
    for (let z = 1; z < height - 1; z += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const index = index3(x, y, z, width, height)
        if (flags[index]) {
          target[index] = 0
          continue
        }

        const backX = Math.max(0.5, Math.min(width - 1.5, x - u[index] * xScale))
        const backY = Math.max(0.5, Math.min(layers - 1.5, y - v[index] * yScale))
        const backZ = Math.max(0.5, Math.min(height - 1.5, z - w[index] * zScale))
        target[index] = sampleScalar(source, width, height, backX, backY, backZ) * decay
      }
    }
  }
}

function sampleScalar(field: Float32Array, width: number, height: number, x: number, y: number, z: number) {
  const layers = Math.floor(field.length / (width * height))
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(x)))
  const y0 = Math.max(0, Math.min(layers - 1, Math.floor(y)))
  const z0 = Math.max(0, Math.min(height - 1, Math.floor(z)))
  const x1 = Math.min(width - 1, x0 + 1)
  const y1 = Math.min(layers - 1, y0 + 1)
  const z1 = Math.min(height - 1, z0 + 1)
  const sx = x - x0
  const sy = y - y0
  const sz = z - z0

  return trilinear(field, width, height, x0, x1, y0, y1, z0, z1, sx, sy, sz)
}

function readScalar(field: Float32Array, flags: Uint32Array, width: number, height: number, x: number, y: number, z: number) {
  const index = index3(x, y, z, width, height)

  return flags[index] ? 0 : field[index]
}

function applyObstacleBoundary(
  width: number,
  height: number,
  layers: number,
  flags: Uint32Array,
  u: Float32Array,
  v: Float32Array,
  w: Float32Array,
  dye: Float32Array,
) {
  for (let y = 1; y < layers - 1; y += 1) {
    for (let z = 1; z < height - 1; z += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const index = index3(x, y, z, width, height)

        if (flags[index]) {
          u[index] = 0
          v[index] = 0
          w[index] = 0
          dye[index] = 0
          continue
        }

        let nearSolid = false

        if (flags[index3(x + 1, y, z, width, height)] && u[index] > 0) {
          u[index] *= -0.08
          nearSolid = true
        }
        if (flags[index3(x - 1, y, z, width, height)] && u[index] < 0) {
          u[index] *= -0.08
          nearSolid = true
        }
        if (flags[index3(x, y + 1, z, width, height)] && v[index] > 0) {
          v[index] *= -0.05
          nearSolid = true
        }
        if (flags[index3(x, y - 1, z, width, height)] && v[index] < 0) {
          v[index] *= -0.05
          nearSolid = true
        }
        if (flags[index3(x, y, z + 1, width, height)] && w[index] > 0) {
          w[index] *= -0.08
          nearSolid = true
        }
        if (flags[index3(x, y, z - 1, width, height)] && w[index] < 0) {
          w[index] *= -0.08
          nearSolid = true
        }

        if (nearSolid) {
          u[index] *= 0.72
          v[index] *= 0.72
          w[index] *= 0.72
          dye[index] *= 0.96
        }
      }
    }
  }
}

function clearSolids(
  flags: Uint32Array,
  u: Float32Array,
  v: Float32Array,
  w: Float32Array,
  dye: Float32Array,
  scalars?: Record<ScalarFieldKey, Float32Array>,
) {
  for (let index = 0; index < flags.length; index += 1) {
    if (flags[index]) {
      u[index] = 0
      v[index] = 0
      w[index] = 0
      dye[index] = 0
      scalarKeys.forEach((key) => {
        if (scalars) {
          scalars[key][index] = scalarAmbient[key]
        }
      })
    }
  }
}

function buildFlags(width: number, height: number, layers: number, obstacles: FlowObstacle[] = defaultObstacles) {
  const flags = new Uint32Array(width * height * layers)

  for (let y = 0; y < layers; y += 1) {
    for (let z = 0; z < height; z += 1) {
      for (let x = 0; x < width; x += 1) {
        if (x < 1 || z < 1 || y < 1 || x > width - 2 || z > height - 2 || y > layers - 2) {
          flags[index3(x, y, z, width, height)] = 1
        }
      }
    }
  }

  obstacles.forEach((obstacle) => rasterizeBox(flags, width, height, layers, obstacle))

  return flags
}

function buildProjectionFlags(flags: Uint32Array, width: number, height: number, layers: number) {
  const projectionFlags = new Uint32Array(width * height)

  for (let z = 0; z < height; z += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let y = 2; y < layers - 2; y += 1) {
        if (flags[index3(x, y, z, width, height)] === 1) {
          projectionFlags[z * width + x] = 1
          break
        }
      }
    }
  }

  return projectionFlags
}

const defaultObstacles: FlowObstacle[] = [
  { x: -2.45, z: 0.9, w: 2.9, d: 1.18, rotation: 0.05, h: 1.1 },
  { x: -1.0, z: -0.55, w: 1.7, d: 1.0, rotation: 0, h: 0.45 },
  { x: 1.95, z: -3.08, w: 2.35, d: 0.48, rotation: 0, h: 1.35 },
  { x: 4.42, z: 1.85, w: 0.7, d: 1.58, rotation: 0, h: 1.7 },
  { x: 3.8, z: -1.15, w: 0.7, d: 0.7, rotation: 0, h: 1.45 },
  { x: -4.22, z: -1.1, w: 0.55, d: 0.55, rotation: 0, h: 1.8 },
]

function rasterizeBox(flags: Uint32Array, width: number, height: number, layers: number, obstacle: FlowObstacle) {
  const halfWidth = obstacle.w / 2
  const halfDepth = obstacle.d / 2
  const cos = Math.cos(obstacle.rotation)
  const sin = Math.sin(obstacle.rotation)
  const extentX = Math.abs(cos) * halfWidth + Math.abs(sin) * halfDepth
  const extentZ = Math.abs(sin) * halfWidth + Math.abs(cos) * halfDepth
  const minX = Math.max(1, worldToGridX(obstacle.x - extentX - 0.08, width))
  const maxX = Math.min(width - 2, worldToGridX(obstacle.x + extentX + 0.08, width))
  const minZ = Math.max(1, worldToGridZ(obstacle.z - extentZ - 0.08, height))
  const maxZ = Math.min(height - 2, worldToGridZ(obstacle.z + extentZ + 0.08, height))
  const maxY = Math.max(2, Math.min(layers - 2, worldToGridY(obstacle.h ?? 1.1, layers)))

  for (let y = 1; y <= maxY; y += 1) {
    for (let z = minZ; z <= maxZ; z += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const wx = -roomWidth / 2 + ((x + 0.5) / width) * roomWidth
        const wz = -roomDepth / 2 + ((z + 0.5) / height) * roomDepth
        const dx = wx - obstacle.x
        const dz = wz - obstacle.z
        const localX = cos * dx + sin * dz
        const localZ = -sin * dx + cos * dz

        if (Math.abs(localX) <= halfWidth && Math.abs(localZ) <= halfDepth) {
          flags[index3(x, y, z, width, height)] = 1
        }
      }
    }
  }
}

function trilinear(
  field: Float32Array,
  width: number,
  height: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
  sx: number,
  sy: number,
  sz: number,
  offset = 0,
  stride = 1,
) {
  const c000 = field[index3(x0, y0, z0, width, height) * stride + offset]
  const c100 = field[index3(x1, y0, z0, width, height) * stride + offset]
  const c010 = field[index3(x0, y1, z0, width, height) * stride + offset]
  const c110 = field[index3(x1, y1, z0, width, height) * stride + offset]
  const c001 = field[index3(x0, y0, z1, width, height) * stride + offset]
  const c101 = field[index3(x1, y0, z1, width, height) * stride + offset]
  const c011 = field[index3(x0, y1, z1, width, height) * stride + offset]
  const c111 = field[index3(x1, y1, z1, width, height) * stride + offset]
  const c00 = c000 * (1 - sx) + c100 * sx
  const c10 = c010 * (1 - sx) + c110 * sx
  const c01 = c001 * (1 - sx) + c101 * sx
  const c11 = c011 * (1 - sx) + c111 * sx
  const c0 = c00 * (1 - sy) + c10 * sy
  const c1 = c01 * (1 - sy) + c11 * sy

  return c0 * (1 - sz) + c1 * sz
}

function isInterior(x: number, y: number, z: number, width: number, height: number, layers: number) {
  return x > 0 && z > 0 && y > 0 && x < width - 1 && z < height - 1 && y < layers - 1
}

function index3(x: number, y: number, z: number, width: number, height: number) {
  return (y * height + z) * width + x
}

function worldToGridX(x: number, width: number) {
  return Math.max(0, Math.min(width - 1, Math.floor(((x + roomWidth / 2) / roomWidth) * width)))
}

function worldToGridY(y: number, layers: number) {
  return Math.max(0, Math.min(layers - 1, Math.floor((y / roomHeight) * layers)))
}

function worldToGridZ(z: number, height: number) {
  return Math.max(0, Math.min(height - 1, Math.floor(((z + roomDepth / 2) / roomDepth) * height)))
}
