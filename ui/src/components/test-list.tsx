import { useState } from 'react'
import { FileTextIcon, PlayIcon, SearchIcon, TriangleAlertIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { StatusIcon } from '@/components/status-icon'
import { isFailure } from '@/lib/status'
import { formatDuration } from '@/lib/format'
import type { HumanTest } from '@/lib/use-humantest'
import { cn } from '@/lib/utils'

export function TestList({ ht, selected, onSelect, demo }: {
  ht: HumanTest
  selected: string | null
  onSelect: (key: string) => void
  demo: boolean
}) {
  const [filter, setFilter] = useState('')
  const q = filter.trim().toLowerCase()

  const statuses = ht.tests.map((t) => ht.statusOf(t))
  const passed = statuses.filter((s) => s === 'passed').length
  const failed = statuses.filter(isFailure).length
  const other = statuses.length - passed - failed

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="border-b p-3">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter tests…" aria-label="Filter tests" className="pl-8" />
        </div>
      </div>

      <div className="flex gap-3 border-b px-4 py-2 text-xs text-muted-foreground">
        <span>{ht.tests.length} tests</span>
        <span className="font-semibold text-emerald-700 dark:text-emerald-400">{passed} passed</span>
        <span className="font-semibold text-red-700 dark:text-red-400">{failed} failed</span>
        {other > 0 && <span>{other} not run</span>}
      </div>

      {ht.problems.length > 0 && (
        <div className="m-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <div className="mb-1 flex items-center gap-1.5 font-semibold"><TriangleAlertIcon className="size-3.5" /> Problems outside the test files</div>
          {ht.problems.map((d, i) => <div key={i}><code>{d.file}:{d.line}</code> {d.message}{d.hint && ` 💡 ${d.hint}`}</div>)}
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1">
        <div className="pb-4">
          {ht.files.map((f) => {
            const tests = f.tests.filter((t) => !q || t.name.toLowerCase().includes(q))
            if (!tests.length && q) return null
            return (
              <section key={f.file} aria-label={f.file}>
                <div className="flex items-center justify-between gap-2 px-4 pt-3 pb-1">
                  <div className={cn('flex min-w-0 items-center gap-1.5 font-mono text-xs text-muted-foreground', f.diagnostics.length && 'text-red-700 dark:text-red-400')}>
                    <FileTextIcon className="size-3.5 shrink-0" />
                    <span className="truncate">{f.file}</span>
                    {f.diagnostics.length > 0 && <span className="shrink-0">· {f.diagnostics.length} problem(s)</span>}
                  </div>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost" size="icon" className="size-7"
                        aria-label={`Run every test in ${f.file}`}
                        disabled={ht.running || f.diagnostics.length > 0}
                        onClick={() => ht.run({ file: f.file }, demo)}
                      >
                        <PlayIcon className="size-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Run this file</TooltipContent>
                  </Tooltip>
                </div>

                {tests.map((t) => {
                  const row = { ...t, file: f.file, fileHasProblems: f.diagnostics.length > 0 }
                  const status = ht.statusOf(row)
                  const last = ht.history.last[t.key]
                  return (
                    <button
                      key={t.key}
                      type="button"
                      onClick={() => onSelect(t.key)}
                      aria-current={t.key === selected ? 'true' : undefined}
                      className={cn(
                        'grid w-full grid-cols-[18px_1fr_auto] items-start gap-2 border-l-2 border-transparent px-4 py-2 text-left text-sm transition-colors hover:bg-muted/60 focus-visible:bg-muted focus-visible:outline-none',
                        t.key === selected && 'border-l-violet-600 bg-violet-50 hover:bg-violet-50 dark:border-l-violet-400 dark:bg-violet-950/40',
                      )}
                    >
                      <StatusIcon status={status} className="mt-0.5" />
                      <span className="break-words">{t.name}</span>
                      {/* On the tinted selected row, muted grey is too faint (WCAG contrast), so it gets darker there. */}
                      <span className={cn('text-right text-xs text-muted-foreground', t.key === selected && 'text-foreground/75')}>
                        <span className="block whitespace-nowrap">
                          {status === 'running' ? 'running…' : status === 'queued' ? 'waiting' : last ? formatDuration(last.duration) : ''}
                        </span>
                        <span className="mt-1 flex justify-end gap-0.5" aria-label="Last runs">
                          {ht.history.runs.slice(-8).map((r, i) => r.results[t.key] && (
                            <span
                              key={i}
                              title={r.results[t.key]}
                              className={cn('size-1.5 rounded-full', r.results[t.key] === 'passed' ? 'bg-emerald-500' : isFailure(r.results[t.key]) ? 'bg-red-500' : 'bg-muted-foreground/40')}
                            />
                          ))}
                        </span>
                      </span>
                    </button>
                  )
                })}
              </section>
            )
          })}
        </div>
      </ScrollArea>
    </div>
  )
}
