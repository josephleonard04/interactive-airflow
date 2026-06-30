import { useEffect, useMemo, useRef, useState } from 'react'
import {
  createInitialSnapshot,
  createSampler,
  createStableFluidSolver,
  type DeviceState,
  type FlowLayout,
  type StableFluidStatus,
} from '../stableFluidSolver'

export function useStableFluidAirflow(devices: DeviceState, layout: FlowLayout) {
  const [snapshot, setSnapshot] = useState(() => createInitialSnapshot(32, 24, 14))
  const [status, setStatus] = useState<StableFluidStatus>('starting')
  const solverRef = useRef<ReturnType<typeof createStableFluidSolver> | null>(null)

  useEffect(() => {
    solverRef.current = createStableFluidSolver({
      devices,
      height: 24,
      layers: 14,
      layout,
      onSnapshot: (nextSnapshot) => {
        setSnapshot(nextSnapshot)
        setStatus('running')
      },
      width: 32,
    })

    return () => {
      solverRef.current?.destroy()
      solverRef.current = null
    }
  }, [])

  useEffect(() => {
    solverRef.current?.updateDevices(devices)
  }, [devices])

  useEffect(() => {
    solverRef.current?.updateLayout(layout)
  }, [layout])

  const sampler = useMemo(() => createSampler(snapshot), [snapshot])

  return { sampler, snapshot, status }
}
