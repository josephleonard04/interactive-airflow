import type { FlowLayout } from '../stableFluidSolver'
import { getObstacleObjects } from '../scene/sceneGraph.ts'
import type { EditableObjectKey, ObjectTransform } from './appTypes'

export function buildFlowLayout(transforms: Record<EditableObjectKey, ObjectTransform>): FlowLayout {
  return {
    fan: {
      x: transforms.fan.position[0],
      z: transforms.fan.position[2],
      rotation: transforms.fan.rotation[1],
    },
    ac: {
      x: 2.65,
      y: 2.02,
      z: -3.38,
      directionX: 0,
      directionZ: 1,
    },
    vent: {
      x: -3.45,
      y: 2.08,
      z: -3.38,
    },
    obstacles: getObstacleObjects().map((object) => ({
      x: transforms[object.id].position[0],
      z: transforms[object.id].position[2],
      rotation: transforms[object.id].rotation[1],
      w: object.footprint?.w ?? 0.6,
      d: object.footprint?.d ?? 0.6,
      h: object.footprint?.h ?? 1,
    })),
    scalarSources: [
      {
        field: 'temperature',
        x: transforms.lamp.position[0],
        y: 1.72,
        z: transforms.lamp.position[2],
        radius: 1.15,
        rate: 0.52,
        target: 0.78,
      },
      {
        field: 'humidity',
        x: transforms.plant.position[0],
        y: 0.92,
        z: transforms.plant.position[2],
        radius: 1.25,
        rate: 0.42,
        target: 0.78,
      },
      {
        field: 'pm25',
        x: transforms.mediaConsole.position[0],
        y: 0.82,
        z: transforms.mediaConsole.position[2],
        radius: 1.45,
        rate: 0.32,
        target: 0.46,
      },
      {
        field: 'co2',
        x: transforms.seatedPerson.position[0],
        y: 1.04,
        z: transforms.seatedPerson.position[2],
        radius: 1.1,
        rate: 0.5,
        target: 0.64,
      },
      {
        field: 'co2',
        x: transforms.sleepingBaby.position[0],
        y: 0.52,
        z: transforms.sleepingBaby.position[2],
        radius: 0.82,
        rate: 0.28,
        target: 0.52,
      },
    ],
  }
}
