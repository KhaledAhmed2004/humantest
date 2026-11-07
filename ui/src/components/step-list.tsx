import { Fragment } from 'react'
import { StatusIcon } from '@/components/status-icon'
import type { PlannedStep, StepCall, TestResult } from '@/lib/api'
import { cleanError, formatDuration } from '@/lib/format'
import { humanize } from '../../../src/humanize'
import type { LiveState } from '@/lib/use-humantest'
import { cn } from '@/lib/utils'

interface Mark { state: string; duration?: number; error?: string; calls?: StepCall[] }

const STATUS_WORDS: Record<number, string> = {
  200: 'OK', 201: 'Created', 204: 'No Content', 400: 'Bad Request', 401: 'Not Logged In', 403: 'Forbidden',
  404: 'Not Found', 409: 'Conflict', 422: 'Invalid', 500: 'Server Error', 503: 'Unavailable',
}

/** The server calls a step made, one per line: "POST /api/v1/routes → 201 Created". Repeats are counted. */
function StepCalls({ calls }: { calls: StepCall[] }) {
  const rows: { call: StepCall; count: number }[] = []
  for (const c of calls) {
    const same = rows.find((r) => r.call.method === c.method && r.call.path === c.path && r.call.status === c.status && !!r.call.simulated === !!c.simulated)
    if (same) same.count++
    else rows.push({ call: c, count: 1 })
  }
  return (
    <ul className="col-start-2 col-end-4 space-y-0.5 font-mono text-xs text-muted-foreground" aria-label="Server calls in this step">
      {rows.map(({ call: c, count }, i) => {
        const failed = c.status === undefined || c.status >= 400
        const fields = [...c.query.map((q) => `?${q}`), ...c.bodyKeys].join(' ')
        return (
          <li key={i} className="flex flex-wrap items-baseline gap-x-1.5" title={fields ? `Fields sent: ${fields}` : undefined}>
            <span className="font-semibold text-foreground/80">{c.method}</span>
            <span className="break-all">{c.path}</span>
            <span aria-hidden="true">→</span>
            <span className={cn(failed ? 'text-red-700 dark:text-red-400' : 'text-emerald-700 dark:text-emerald-400')}>
              {c.status === undefined ? 'no reply' : `${c.status}${STATUS_WORDS[c.status] ? ` ${STATUS_WORDS[c.status]}` : ''}`}
            </span>
            {c.simulated && <span>(simulated)</span>}
            {count > 1 && <span>×{count}</span>}
          </li>
        )
      })}
    </ul>
  )
}

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
    return { state: r.status, duration: r.duration, error: r.error, calls: r.calls }
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
              {m.calls && m.calls.length > 0 && <StepCalls calls={m.calls} />}
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
