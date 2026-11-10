import { useMemo } from 'react'
import { ProblemWhere } from '@/components/problem-where'
import { parseError } from '@/lib/format'
import { cn } from '@/lib/utils'

function Label({ children }: { children: React.ReactNode }) {
  return <div className="mb-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{children}</div>
}

/**
 * A HumanTest error laid out in parts: the headline, what the page shows instead,
 * where the problem is, any other notes and the latest requests to the backend.
 */
export function ErrorDetails({ error, className, compact }: { error: string; className?: string; compact?: boolean }) {
  const e = useMemo(() => parseError(error), [error])
  return (
    <div className={cn('grid gap-3', compact && 'gap-2.5', className)}>
      {e.headline && <p className={cn('font-medium text-red-700 dark:text-red-400', compact ? 'text-sm' : 'text-[15px]')}>{e.headline}</p>}

      {e.shows.length > 0 && (
        <div>
          <Label>Instead, the page shows</Label>
          <div className="flex flex-wrap gap-1.5">
            {e.shows.map((s, i) => (
              <span key={i} className="rounded-md border bg-background px-2 py-0.5 text-xs font-medium text-foreground">{s}</span>
            ))}
          </div>
        </div>
      )}

      <ProblemWhere error={error} />

      {e.notes.map((n, i) => <p key={i} className="text-sm text-foreground/85">{n}</p>)}

      {e.requests.length > 0 && (
        <div>
          <Label>Latest backend activity</Label>
          <div className="overflow-hidden rounded-lg border bg-background">
            {e.requests.map((r, i) => (
              <div key={i} className="grid grid-cols-[3.5rem_1fr_auto] items-center gap-3 border-b px-3 py-1.5 font-mono text-xs last:border-b-0">
                <span className="font-semibold text-muted-foreground">{r.method}</span>
                <span className="truncate text-foreground" title={r.path}>{r.path}</span>
                <span className={cn('rounded-md px-1.5 py-0.5 font-semibold',
                  r.code >= 400 ? 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400'
                    : r.code ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400'
                      : 'bg-muted text-muted-foreground')}
                >{r.status}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
