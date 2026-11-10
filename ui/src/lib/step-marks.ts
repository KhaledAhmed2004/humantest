import type { PlannedStep, StepCall, TestResult } from '@/lib/api'
import type { LiveState } from '@/lib/use-humantest'

export interface Mark { state: string; duration?: number; error?: string; calls?: StepCall[] }

/** For each planned step, what happened to it. Steps are matched to results by their title, in order. */
export function stepMarks(steps: PlannedStep[], result?: TestResult, live?: LiveState): Mark[] {
  if (live) {
    // Steps that have started are done, except the latest one, which is still running.
    const pool = [...live.steps]
    let latest = -1
    const marks = steps.map((st, i): Mark => {
      const j = pool.indexOf(st.title)
      if (j < 0) return { state: 'notrun' }
      pool.splice(j, 1)
      latest = i
      return { state: 'passed' }
    })
    if (latest >= 0 && live.state === 'running') marks[latest] = { state: 'running' }
    return marks
  }
  if (!result) return steps.map(() => ({ state: 'notrun' }))
  const pool = [...result.steps]
  return steps.map((st): Mark => {
    const i = pool.findIndex((r) => r.title === st.title)
    if (i < 0) return { state: 'notrun' }
    const r = pool.splice(i, 1)[0]
    return { state: r.status, duration: r.duration, error: r.error, calls: r.calls }
  })
}
