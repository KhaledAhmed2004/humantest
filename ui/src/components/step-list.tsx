import { Fragment } from 'react'
import { StatusIcon } from '@/components/status-icon'
import type { PlannedStep, TestResult } from '@/lib/api'
import { formatDuration } from '@/lib/format'
import type { LiveState } from '@/lib/use-humantest'
import { cn } from '@/lib/utils'

interface Mark { state: string; duration?: number; error?: string }

/** For each planned step, what happened to it. Steps are matched to results by their title, in order. */
function stepMarks(steps: PlannedStep[], result?: TestResult, live?: LiveState): Mark[] {
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
    return { state: r.status, duration: r.duration, error: r.error }
  })
}

/** The error without the parts this list already shows (line, user, file). */
const cleanError = (e: string) =>
  e.split('\n').filter((l) => l.trim() && !/^\s*(Line \d+ ·|📄|What went wrong:)/.test(l)).map((l) => l.trim()).join('\n')

export function StepList({ steps, result, live }: { steps: PlannedStep[]; result?: TestResult; live?: LiveState }) {
  const marks = stepMarks(steps, result, live)
  // A story line ("the dentist adds …") is shown once, as a heading over the steps it stands for.
  const storyKey = (st: PlannedStep) => (st.story ? `${st.story}|${st.line}` : null)
  const startsStory = steps.map((st, i) => storyKey(st) !== null && (i === 0 || storyKey(steps[i - 1]) !== storyKey(st)))

  return (
    <ol className="overflow-hidden rounded-xl border bg-card">
      {steps.map((st, i) => {
        const story = storyKey(st)
        const heading = startsStory[i]
        const m = marks[i]
        return (
          <Fragment key={i}>
            {heading && (
              <li className="border-t bg-muted/50 px-4 pt-2 pb-1 text-sm font-semibold first:border-t-0" aria-hidden="true">
                <span className="mr-2 font-mono text-xs font-normal text-muted-foreground">{st.line}</span>{st.story}
              </li>
            )}
            <li
              className={cn(
                'grid grid-cols-[18px_34px_1fr_auto] items-start gap-2 border-t px-4 py-2 text-sm first:border-t-0',
                heading && 'border-t-0',
                story && 'pl-7',
                m.state === 'running' && 'bg-violet-50 dark:bg-violet-950/40',
                m.state === 'failed' && 'bg-red-50 dark:bg-red-950/40',
                m.state === 'notrun' && 'opacity-55',
              )}
            >
              <StatusIcon status={m.state} className="mt-0.5" />
              <span className="pt-0.5 font-mono text-xs text-muted-foreground">{st.line}</span>
              <span className="min-w-0">
                <span className="block text-xs text-muted-foreground">{st.user}</span>
                <span className="break-words">{st.text}</span>
              </span>
              <span className="pt-0.5 text-xs text-muted-foreground">{formatDuration(m.duration)}</span>
              {m.error && (
                <pre className="col-span-2 col-start-3 font-mono text-xs whitespace-pre-wrap text-red-700 dark:text-red-400">{cleanError(m.error)}</pre>
              )}
            </li>
          </Fragment>
        )
      })}
    </ol>
  )
}
