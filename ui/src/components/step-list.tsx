import { Fragment } from 'react'
import { StatusIcon } from '@/components/status-icon'
import type { PlannedStep, TestResult } from '@/lib/api'
import { cleanError, formatDuration } from '@/lib/format'
import { humanize } from '../../../src/humanize'
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


const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

function UserChip({ name }: { name: string }) {
  return <span className="mr-1.5 rounded-md bg-violet-100 px-1.5 py-px text-xs font-semibold text-violet-800 dark:bg-violet-950 dark:text-violet-300">{name}</span>
}

export function StepList({ steps, result, live }: { steps: PlannedStep[]; result?: TestResult; live?: LiveState }) {
  const marks = stepMarks(steps, result, live)
  // A story line ("the dentist adds …") is shown once, as a heading over the steps it stands for.
  const storyKey = (st: PlannedStep) => (st.story ? `${st.story}|${st.line}` : null)
  const startsStory = steps.map((st, i) => storyKey(st) !== null && (i === 0 || storyKey(steps[i - 1]) !== storyKey(st)))
  // Only name the user when the test has more than one.
  const multiUser = new Set(steps.map((st) => st.user)).size > 1

  return (
    <ol className="overflow-hidden rounded-xl border bg-card">
      {steps.map((st, i) => {
        const story = storyKey(st)
        const heading = startsStory[i]
        const m = marks[i]
        const h = humanize(st.text)
        return (
          <Fragment key={i}>
            {heading && (
              <li className="border-t bg-muted/50 px-4 pt-2.5 pb-1.5 text-sm font-semibold first:border-t-0" title={`Line ${st.line} of the test`}>
                {multiUser && <UserChip name={st.user} />}
                {capitalize(st.story ?? '')}
              </li>
            )}
            <li
              title={`Line ${st.line} of the test: ${st.text}`}
              className={cn(
                'grid grid-cols-[18px_1fr_auto] items-start gap-2.5 border-t px-4 py-2 text-sm first:border-t-0',
                heading && 'border-t-0',
                story && 'pl-8',
                m.state === 'running' && 'bg-violet-50 dark:bg-violet-950/40',
                m.state === 'failed' && 'bg-red-50 dark:bg-red-950/40',
                m.state === 'notrun' && 'opacity-55',
              )}
            >
              <StatusIcon status={m.state} className="mt-0.5" />
              <span className="min-w-0">
                <span className="break-words">
                  {multiUser && !story && <UserChip name={st.user} />}
                  {h.text}
                </span>
                {h.where && <span className="block text-xs text-muted-foreground">in {h.where}</span>}
              </span>
              <span className="pt-0.5 text-xs text-muted-foreground tabular-nums">{formatDuration(m.duration)}</span>
              {m.error && (
                <pre className="col-start-2 col-end-4 rounded-md bg-red-100/60 px-2 py-1.5 font-mono text-xs whitespace-pre-wrap text-red-700 dark:bg-red-950/60 dark:text-red-400">{cleanError(m.error)}</pre>
              )}
            </li>
          </Fragment>
        )
      })}
    </ol>
  )
}
