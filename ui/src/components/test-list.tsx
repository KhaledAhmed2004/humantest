import { useState } from 'react'
import { FileTextIcon, GitCompareArrowsIcon, PencilLineIcon, PlayIcon, SearchIcon, TriangleAlertIcon, VideoIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { StatusIcon } from '@/components/status-icon'
import { isFailure, statusLabel } from '@/lib/status'
import { formatDuration, friendlyFile, friendlyProblem } from '@/lib/format'
import type { HumanTest } from '@/lib/use-humantest'
import { cn } from '@/lib/utils'
import { TEST_TYPES, testType, typeInfo, type TestType } from '@/lib/test-type'

function TypeLabel({ type, selected }: { type: TestType; selected: boolean }) {
  const { label, icon: Icon } = typeInfo(type)
  return (
    <span className={cn('mt-0.5 flex items-center gap-1 text-xs text-muted-foreground', selected && 'text-foreground/75')}>
      <Icon className="size-3" aria-hidden="true" /> {label}
    </span>
  )
}

export function TestList({ ht, selected, onSelect, demo }: {
  ht: HumanTest
  selected: string | null
  onSelect: (key: string) => void
  demo: boolean
}) {
  const [filter, setFilter] = useState('')
  const [type, setType] = useState<TestType | null>(null)
  const q = filter.trim().toLowerCase()
  const typeCount = (id: TestType) => ht.tests.filter((t) => testType(t.steps) === id).length

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
        {/* What kind of test: worked out from the steps (lib/test-type.ts). */}
        <div role="group" aria-label="Show tests of one kind" className="mt-2 flex flex-wrap gap-1.5">
          {[{ id: null, plural: 'All', hint: 'Every test', icon: null }, ...TEST_TYPES].map((k) => {
            const count = k.id ? typeCount(k.id) : ht.tests.length
            if (k.id && !count) return null
            const on = type === k.id
            const Icon = k.icon
            return (
              <Tooltip key={k.id ?? 'all'}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-pressed={on}
                    onClick={() => setType(on && k.id ? null : k.id)}
                    className={cn(
                      'flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs transition-colors',
                      on ? 'border-foreground bg-foreground text-background' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                  >
                    {Icon && <Icon className="size-3" aria-hidden="true" />}
                    {k.plural} <span className={on ? 'opacity-70' : 'opacity-60'}>{count}</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent>{k.hint}</TooltipContent>
              </Tooltip>
            )
          })}
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
          <div className="mb-1 flex items-center gap-1.5 font-semibold"><TriangleAlertIcon className="size-3.5" /> Some shared steps need fixing</div>
          {ht.problems.map((d, i) => <div key={i}>{friendlyProblem(d, true)}</div>)}
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1">
        <div className="pb-4">
          {ht.files.map((f) => {
            const tests = f.tests.filter((t) => (!q || t.name.toLowerCase().includes(q)) && (!type || testType(t.steps) === type))
            if (!tests.length && (q || type)) return null
            return (
              <section key={f.file} aria-label={friendlyFile(f.file)}>
                <div className="flex items-center justify-between gap-2 px-4 pt-3 pb-1">
                  <div className={cn('flex min-w-0 items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase', f.diagnostics.length && 'text-red-700 dark:text-red-400')}>
                    <FileTextIcon className="size-3.5 shrink-0" />
                    <span className="truncate" title={f.file}>{friendlyFile(f.file)}</span>
                    {f.diagnostics.length > 0 && <span className="shrink-0">· needs fixing</span>}
                  </div>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost" size="icon" className="size-7"
                        aria-label={`Run every test in ${friendlyFile(f.file)}`}
                        disabled={ht.running || f.diagnostics.length > 0}
                        onClick={() => ht.run({ file: f.file }, demo)}
                      >
                        {demo ? <VideoIcon className="size-3.5" /> : <PlayIcon className="size-3.5" />}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{demo ? 'Run every test in this file, with video' : 'Run every test in this file'}</TooltipContent>
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
                      <span className="break-words">
                        {t.name}
                        <TypeLabel type={testType(t.steps)} selected={t.key === selected} />
                        {t.draft && (
                          <span className="mt-1 flex w-fit items-center gap-1 rounded-md bg-muted px-1.5 py-px text-xs font-medium text-muted-foreground">
                            <PencilLineIcon className="size-3" aria-hidden="true" /> Draft, not run
                          </span>
                        )}
                        {ht.changes[t.key]?.status === 'changed' && (
                          <span className="mt-1 flex w-fit items-center gap-1 rounded-md bg-amber-100 px-1.5 py-px text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                            <GitCompareArrowsIcon className="size-3" aria-hidden="true" /> Logic changed
                          </span>
                        )}
                      </span>
                      {/* On the tinted selected row, muted grey is too faint (WCAG contrast), so it gets darker there. */}
                      <span className={cn('text-right text-xs text-muted-foreground', t.key === selected && 'text-foreground/75')}>
                        <span className="block whitespace-nowrap">
                          {status === 'running' ? 'running…' : status === 'queued' ? 'waiting' : last ? formatDuration(last.duration) : ''}
                        </span>
                        <span className="mt-1 flex justify-end gap-0.5" aria-label="Last runs">
                          {ht.history.runs.slice(-8).map((r, i) => r.results[t.key] && (
                            <span
                              key={i}
                              title={statusLabel(r.results[t.key])}
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
