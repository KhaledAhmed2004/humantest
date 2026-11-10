import { problemWhere, type ProblemPart } from '@/lib/format'
import { cn } from '@/lib/utils'

const STYLE: Record<ProblemPart, { box: string; pill: string }> = {
  frontend: {
    box: 'border-sky-200 bg-sky-50/70 dark:border-sky-900/70 dark:bg-sky-950/40',
    pill: 'bg-sky-100 text-sky-800 dark:bg-sky-900/60 dark:text-sky-200',
  },
  backend: {
    box: 'border-amber-200 bg-amber-50/70 dark:border-amber-900/70 dark:bg-amber-950/40',
    pill: 'bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-200',
  },
  setup: {
    box: 'border-slate-200 bg-slate-50/70 dark:border-slate-800 dark:bg-slate-900/50',
    pill: 'bg-slate-200 text-slate-800 dark:bg-slate-800 dark:text-slate-200',
  },
  test: {
    box: 'border-violet-200 bg-violet-50/70 dark:border-violet-900/70 dark:bg-violet-950/40',
    pill: 'bg-violet-100 text-violet-800 dark:bg-violet-900/60 dark:text-violet-200',
  },
}

/** Which side a failure is on (the page, the server, the test setup or the test), with the reason. */
export function ProblemWhere({ error, className }: { error: string; className?: string }) {
  const w = problemWhere(error)
  if (!w) return null
  const s = STYLE[w.part]
  return (
    <div className={cn('rounded-lg border px-3 py-2.5', s.box, className)}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Problem in</span>
        <span className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold', s.pill)}>{w.label}</span>
      </div>
      {w.why && <p className="mt-1.5 text-sm leading-relaxed text-foreground/85">{w.why}</p>}
    </div>
  )
}
