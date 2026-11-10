import { useState, type ReactNode } from 'react'
import {
  CheckIcon, CircleDashedIcon, FileTextIcon, GitCompareArrowsIcon, PencilLineIcon, PlayIcon,
  PanelLeftCloseIcon, SearchIcon, TriangleAlertIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { StatusIcon } from '@/components/status-icon'
import { isFailure, statusLabel } from '@/lib/status'
import { formatDuration, friendlyFile, friendlyProblem, storage } from '@/lib/format'
import type { HumanTest, TestRow } from '@/lib/use-humantest'
import { cn } from '@/lib/utils'
import { actors, CATEGORIES, testType, type CategoryId, type TestType } from '@/lib/test-type'
import { checks } from '@/lib/happy'
import { HappyPath } from '@/components/happy-path'

function RunButton({ label, hint, disabled, onClick }: { label: string; hint: string; disabled: boolean; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label={label} disabled={disabled} onClick={onClick}>
          <PlayIcon className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  )
}

function TestButton({ ht, row, selected, onSelect, chips, nested }: {
  ht: HumanTest
  row: TestRow
  selected: boolean
  onSelect: (key: string) => void
  /** What the test checks, shown beside its file (the happy path's roles, email, reload). */
  chips?: ReactNode
  /** Inside a tree (the happy path): a rounded row on the tree's line, not a full-width one. */
  nested?: boolean
}) {
  const status = ht.statusOf(row)
  const last = ht.history.last[row.key]
  return (
    <button
      type="button"
      onClick={() => onSelect(row.key)}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'grid w-full grid-cols-[18px_1fr_auto] items-start gap-2 py-2 text-left text-sm transition-colors hover:bg-muted/60 focus-visible:bg-muted focus-visible:outline-none',
        nested ? 'rounded-lg px-2 hover:bg-muted' : 'border-l-2 border-transparent px-4',
        selected && (nested
          ? 'bg-muted font-medium hover:bg-muted'
          : 'border-l-violet-600 bg-violet-50 hover:bg-violet-50 dark:border-l-violet-400 dark:bg-violet-950/40'),
      )}
    >
      <StatusIcon status={status} className="mt-0.5" />
      <span className="min-w-0 [overflow-wrap:anywhere]">
        {row.name}
        {/* Which file it is in, now that the list is grouped by kind of test, and what it checks. */}
        <span className={cn('mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs text-muted-foreground', selected && 'text-foreground/75')}>
          <span className="flex items-center gap-1"><FileTextIcon className="size-3" aria-hidden="true" /> {friendlyFile(row.file)}</span>
          {chips}
        </span>
        {row.draft && (
          <span className="mt-1 flex w-fit items-center gap-1 rounded-md bg-muted px-1.5 py-px text-xs font-medium text-muted-foreground">
            <PencilLineIcon className="size-3" aria-hidden="true" /> Draft, not run
          </span>
        )}
        {ht.changes[row.key]?.status === 'changed' && (
          <span className="mt-1 flex w-fit items-center gap-1 rounded-md bg-amber-100 px-1.5 py-px text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-200">
            <GitCompareArrowsIcon className="size-3" aria-hidden="true" /> Logic changed
          </span>
        )}
      </span>
      {/* On the tinted selected row, muted grey is too faint (WCAG contrast), so it gets darker there. */}
      <span className={cn('text-right text-xs text-muted-foreground', selected && 'text-foreground/75')}>
        <span className="block whitespace-nowrap">
          {status === 'running' ? 'running…' : status === 'queued' ? 'waiting' : last ? formatDuration(last.duration) : ''}
        </span>
        <span className="mt-1 flex justify-end gap-0.5" aria-label="Last runs">
          {ht.history.runs.slice(-8).map((r, i) => r.results[row.key] && (
            <span
              key={i}
              title={statusLabel(r.results[row.key])}
              className={cn('size-1.5 rounded-full', r.results[row.key] === 'passed' ? 'bg-emerald-500' : isFailure(r.results[row.key]) ? 'bg-red-500' : 'bg-muted-foreground/40')}
            />
          ))}
        </span>
      </span>
    </button>
  )
}

/** Which roles have a happy-path test: a role with none is the first gap to fill. */
function RoleChecklist({ roles, covered }: { roles: string[]; covered: Set<string> }) {
  if (!roles.length) return null
  return (
    <div className="flex flex-wrap gap-1.5 px-4 pb-2" aria-label="Roles with a happy-path test">
      {roles.map((r) => {
        const has = covered.has(r)
        return (
          <span
            key={r}
            title={has ? `${r} has a happy-path test` : `No happy-path test for ${r} yet`}
            className={cn(
              'flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-sm',
              has ? 'border-emerald-300 text-emerald-800 dark:border-emerald-800 dark:text-emerald-300' : 'border-dashed text-muted-foreground',
            )}
          >
            {has ? <CheckIcon className="size-3.5" aria-hidden="true" /> : <CircleDashedIcon className="size-3.5" aria-hidden="true" />}
            {r}
            {!has && <span className="sr-only">: no test yet</span>}
          </span>
        )
      })}
    </div>
  )
}

export function TestList({ ht, selected, onSelect, onCollapse }: {
  ht: HumanTest
  selected: string | null
  onSelect: (key: string) => void
  /** Hides the list, when the screen is wide enough to show it beside the test. */
  onCollapse?: () => void
}) {
  const [filter, setFilter] = useState('')
  const q = filter.trim().toLowerCase()
  // One kind of test at a time, chosen like a filter. Happy path to start with.
  const [cat, setCatState] = useState<CategoryId>(() => {
    const saved = storage.get('ht.category')
    return CATEGORIES.find((c) => c.id === saved)?.id ?? 'happy'
  })
  const setCat = (id: CategoryId) => { setCatState(id); storage.set('ht.category', id) }

  const statuses = ht.tests.map((t) => ht.statusOf(t))
  const passed = statuses.filter((s) => s === 'passed').length
  const failed = statuses.filter(isFailure).length
  const other = statuses.length - passed - failed

  const matches = (t: TestRow) => !q || t.name.toLowerCase().includes(q)
  const byKind = new Map<TestType, TestRow[]>()
  for (const r of ht.tests) {
    const k = testType(r)
    byKind.set(k, [...(byKind.get(k) ?? []), r])
  }
  const runnable = (list: TestRow[]) => list.filter((t) => !t.draft && !t.fileHasProblems).map((t) => t.key)
  const happyRoles = new Set(CATEGORIES[0].kinds.flatMap((k) => byKind.get(k.id) ?? []).flatMap((t) => actors(t.steps)))

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="border-b p-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter tests…" aria-label="Filter tests" className="pl-8" />
          </div>
          {onCollapse && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="shrink-0 text-muted-foreground" aria-label="Hide the test list" onClick={onCollapse}>
                  <PanelLeftCloseIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Hide the list <kbd className="ml-1 opacity-70">Ctrl B</kbd></TooltipContent>
            </Tooltip>
          )}
        </div>
        <div role="group" aria-label="Show one kind of test" className="mt-2.5 flex flex-wrap gap-2">
            {CATEGORIES.map((c) => {
              const count = c.kinds.flatMap((k) => byKind.get(k.id) ?? []).filter(matches).length
              const on = cat === c.id
              const Icon = c.icon
              return (
                <Tooltip key={c.id}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-pressed={on}
                      onClick={() => setCat(c.id)}
                      className={cn(
                        'flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors',
                        on ? 'border-foreground bg-foreground text-background' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                      )}
                    >
                      <Icon className="size-3.5" aria-hidden="true" />
                      {/* Not faded when unpicked: the muted text is already as light as WCAG contrast allows. */}
                      {c.label} <span className={on ? 'opacity-80' : undefined}>{count}</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{c.hint}</TooltipContent>
                </Tooltip>
              )
            })}
          </div>
      </div>

      <div className="flex flex-wrap gap-x-3 gap-y-1 border-b px-4 py-2 text-sm text-muted-foreground">
        <span className="font-medium text-foreground">All {ht.tests.length} tests:</span>
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

      {/* ScrollArea's content is display:table, so one long word would widen it past the panel and clip
          the right edge (run buttons, times). Block keeps it to the panel's width. */}
      <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block">
        {/* Relative, so screen-reader-only text far down the list is placed inside what scrolls, not
            below the panel (where it gave the panel a second scrollbar). */}
        <div className="relative pb-4">
          {q && !ht.tests.some(matches) && (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">No test has “{filter.trim()}” in its name.</p>
          )}
          {CATEGORIES.filter((c) => c.id === cat).map((c) => {
            const all = c.kinds.flatMap((k) => byKind.get(k.id) ?? [])
            const shown = all.filter(matches)
            const keys = runnable(all)
            return (
              <section key={c.id} aria-label={c.label}>
                <div className="flex items-center justify-between gap-2 py-1 pr-2 pl-4">
                  <p className="min-w-0 text-sm text-muted-foreground">{c.hint}</p>
                  <RunButton
                    label={`Run every ${c.label} test`} hint={`Run every ${c.label} test`}
                    disabled={ht.running || !keys.length} onClick={() => ht.run({ keys })}
                  />
                </div>
                {q && !shown.length && ht.tests.some(matches) && (
                  <p className="px-4 py-6 text-center text-sm text-muted-foreground">No {c.label} test has “{filter.trim()}” in its name. The counts above show where they are.</p>
                )}
                <div className="pb-2">
                    {c.id === 'happy' && !q && <RoleChecklist roles={ht.roles} covered={happyRoles} />}
                    {c.id === 'happy' && (
                      <HappyPath
                        journeys={(byKind.get('journey') ?? []).filter(matches)}
                        flows={(byKind.get('flow') ?? []).filter(matches)}
                        sideEffects={ht.tests.filter((t) => checks(t.steps).has('email')).filter(matches)}
                        filtering={!!q}
                        statusOf={ht.statusOf}
                        renderTest={(t, chips) => <TestButton key={t.key} ht={ht} row={t} selected={t.key === selected} onSelect={onSelect} chips={chips} nested />}
                        renderRun={(label, keys) => (
                          <RunButton label={label} hint={`${label} (${keys.length} ${keys.length === 1 ? 'test' : 'tests'})`} disabled={ht.running || !keys.length} onClick={() => ht.run({ keys })} />
                        )}
                      />
                    )}
                    {c.id !== 'happy' && c.kinds.map((k) => {
                      const tests = (byKind.get(k.id) ?? []).filter(matches)
                      if (q && !tests.length) return null
                      const KIcon = k.icon
                      return (
                        <div key={k.id}>
                          {/* A category with one kind (Accessibility) needs no second heading. */}
                          {c.kinds.length > 1 && (
                            <div className="flex items-center gap-1.5 px-4 pt-1.5 pb-0.5 text-xs font-medium text-muted-foreground" title={k.hint}>
                              <KIcon className="size-3" aria-hidden="true" /> {k.label}
                              <span className="opacity-70">{tests.length}</span>
                            </div>
                          )}
                          {!tests.length && (
                            <div className="px-4 pb-1.5 text-xs text-muted-foreground">
                              <span className="italic">None yet.</span> {k.hint}. Try: <code className="rounded bg-muted px-1 py-px font-mono text-[11px] text-foreground [overflow-wrap:anywhere]">{k.example}</code>
                            </div>
                          )}
                          {tests.map((t) => (
                            <TestButton key={t.key} ht={ht} row={t} selected={t.key === selected} onSelect={onSelect} />
                          ))}
                        </div>
                      )
                    })}
                </div>
              </section>
            )
          })}

        </div>
      </ScrollArea>
    </div>
  )
}
