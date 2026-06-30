import assert from 'node:assert/strict'
import { buildAirflowCase } from '../src/engine/airflowCase.ts'
import { exportOpenFoamCase } from '../src/engine/openfoam/exportCase.ts'
import { sampleGridPoints, OPENFOAM_GRID, openfoamResultToSnapshot } from '../src/engine/openfoam/result.ts'
import { buildFlowLayout } from '../src/state/flowLayout.ts'
import { initialObjectTransforms, presets } from '../src/state/appConstants.ts'

const layout = buildFlowLayout(initialObjectTransforms)
const airflowCase = buildAirflowCase(layout, presets.comfort, 'living-room')

// Devices on in the comfort preset -> AC inlet, vent outlet, fan source.
assert.equal(airflowCase.inlets.length, 1, 'AC inlet present')
assert.equal(airflowCase.outlets.length, 1, 'vent outlet present')
assert.equal(airflowCase.fans.length, 1, 'fan source present')
assert.ok(airflowCase.obstacles.length > 0, 'furniture obstacles present')
assert.ok(airflowCase.inlets[0].temperature < airflowCase.ambientTemperature, 'AC supplies cool air')

const ofCase = exportOpenFoamCase(airflowCase)
// Core OpenFOAM dictionaries must exist.
for (const path of [
  'system/controlDict',
  'system/fvSchemes',
  'system/fvSolution',
  'system/blockMeshDict',
  'system/topoSetDict',
  'system/createPatchDict',
  'system/fvOptions',
  'constant/g',
  'constant/thermophysicalProperties',
  'constant/turbulenceProperties',
  '0/U',
  '0/T',
  '0/p_rgh',
  '0/p',
  'Allrun',
]) {
  assert.ok(ofCase.files[path], `missing ${path}`)
}
assert.ok(ofCase.files['system/controlDict'].includes('buoyantSimpleFoam'), 'solver wired')
assert.ok(ofCase.files['system/blockMeshDict'].includes('hex'), 'blockMesh has a block')
assert.deepEqual(ofCase.patches.inlets, ['acInlet'])
assert.deepEqual(ofCase.patches.outlets, ['ventOutlet'])

// One STL per obstacle, each a closed solid with 12 triangles.
const stlPaths = Object.keys(ofCase.files).filter((p) => p.endsWith('.stl'))
assert.equal(stlPaths.length, airflowCase.obstacles.length, 'one STL per obstacle')
for (const p of stlPaths) {
  const facets = ofCase.files[p].match(/facet normal/g) ?? []
  assert.equal(facets.length, 12, `${p} is a box (12 triangles)`)
}

// Sample grid points line up with the snapshot volume.
const points = sampleGridPoints()
assert.equal(
  points.length,
  OPENFOAM_GRID.width * OPENFOAM_GRID.height * OPENFOAM_GRID.layers,
  'sample point count matches grid',
)

// Result adapter produces a usable snapshot.
const cellCount = OPENFOAM_GRID.width * OPENFOAM_GRID.height * OPENFOAM_GRID.layers
const velocity = new Array(cellCount * 3).fill(0)
const temperature = new Array(cellCount).fill(297.15)
velocity[0] = 1.2 // x-velocity in first cell
const snapshot = openfoamResultToSnapshot({
  status: 'ok',
  grid: { ...OPENFOAM_GRID, velocity, temperature },
})
assert.ok(snapshot, 'snapshot built')
assert.ok(Math.abs(snapshot!.volumeVelocities[0] - 1.2) < 1e-6, 'velocity copied into snapshot')
assert.ok(Math.abs(snapshot!.volumeVelocities[3] - 1.2) < 1e-6, 'speed magnitude set')

console.log('openfoam export checks passed')
