import { Children, isValidElement, useState, type ReactNode } from 'react'
import { BoxIcon, CheckIcon, ChevronRightIcon, CircleDashedIcon, LayersIcon, MailIcon, RotateCwIcon, UsersIcon, type LucideIcon } from 'lucide-react'
import type { TestRow } from '@/lib/use-humantest'
import { actors, CHECKS, checks, mainRequest, partLabel, parts, startState, type Check } from '@/lib/happy'
import { testType, typeInfo } from '@/lib/test-type'
import { storage } from '@/lib/format'
import { isFailure } from '@/lib/status'
import { cn } from '@/lib/utils'

type RenderTest = (row: TestRow, chips: ReactNode) => ReactNode
type RenderRun = (label: string, keys: string[]) => ReactNode

const chip = 'flex w-fit items-center gap-1 rounded-md border px-1.5 py-px text-[11px] leading-4'

/** What a test checks beyond the usual page and server answer, so a side effect is seen even inside a journey. */
export function TestFacets({ row, journey, also }: { row: TestRow; journey?: boolean; also?: string }) {
  const who = actors(row.steps)
  const c = checks(row.steps)
  const p = parts(row.steps)
  if (!(who.length > 1 || c.has('email') || c.has('reload') || journey || also)) return null
  // Quiet, on the file's line: a tree row should read as one item, not a row of boxes.
  const item = 'flex items-center gap-1'
  return (
    <>
      {also && <span className={item} title="The group this test is in">in {also}</span>}
      {journey && p.length > 0 && (
        <span className={item} title={p.map(partLabel).join(' → ')}><LayersIcon className="size-3" aria-hidden="true" />{p.length} parts</span>
      )}
      {who.length > 1 && (
        <span className={item} title={who.join(', ')}><UsersIcon className="size-3" aria-hidden="true" />{who.length} roles</span>
      )}
      {c.has('email') && <span className={item} title="Checks an email is sent"><MailIcon className="size-3" aria-hidden="true" />Email</span>}
      {c.has('reload') && <span className={item} title="Checks the data is still there after a reload"><RotateCwIcon className="size-3" aria-hidden="true" />Reload</span>}
    </>
  )
}

function Have({ on, label, hint }: { on: boolean; label: string; hint: string }) {
  return (
    <span
      title={on ? hint : `Not checked yet. ${hint}`}
      className={cn(chip, on ? 'border-emerald-300 text-emerald-800 dark:border-emerald-800 dark:text-emerald-300' : 'border-dashed text-muted-foreground')}
    >
      {on ? <CheckIcon className="size-3" aria-hidden="true" /> : <CircleDashedIcon className="size-3" aria-hidden="true" />}
      {label}
      {!on && <span className="sr-only">: not checked yet</span>}
    </span>
  )
}

/** For one part of the app: who does it, what is checked, with how many sets of data, from what start. */
function PartSummary({ tests }: { tests: TestRow[] }) {
  const who = [...new Set(tests.flatMap((t) => actors(t.steps)))]
  const done = new Set<Check>(tests.flatMap((t) => [...checks(t.steps)]))
  const perRequest = new Map<string, number>()
  for (const t of tests) {
    const r = mainRequest(t.steps)
    if (r) perRequest.set(r, (perRequest.get(r) ?? 0) + 1)
  }
  const sets = Math.max(0, ...perRequest.values())
  const states = [...new Set(tests.map(startState))]
  const row = 'grid grid-cols-[52px_1fr] items-start gap-1.5'
  const name = 'pt-px text-[11px] text-muted-foreground'
  return (
    <div className="space-y-1 rounded-lg border bg-muted/40 px-2 py-1.5">
      <div className={row}>
        <span className={name}>Who</span>
        <span className="flex flex-wrap gap-1">{who.map((w) => <Have key={w} on label={w} hint={`${w} does this`} />)}</span>
      </div>
      <div className={row}>
        <span className={name}>Checks</span>
        <span className="flex flex-wrap gap-1">
          {CHECKS.map((c) => <Have key={c.id} on={done.has(c.id)} label={c.label} hint={`${c.hint}. Write: ${c.example}`} />)}
        </span>
      </div>
      <div className={row}>
        <span className={name}>Data</span>
        <Have
          on={sets > 1}
          label={sets === 0 ? 'Nothing sent yet' : sets === 1 ? 'One set of data' : `${sets} sets of data`}
          hint="The same flow again with other valid data: more seats, a long or Bangla name, the smallest and largest value"
        />
      </div>
      <div className={row}>
        <span className={name}>Start</span>
        <span className="flex flex-wrap gap-1">
          {states.map((s) => <span key={s} className={cn(chip, 'text-muted-foreground')} title="What is there when the test starts">{s}</span>)}
        </span>
      </div>
    </div>
  )
}


const runnable = (list: TestRow[]) => list.filter((t) => !t.draft && !t.fileHasProblems).map((t) => t.key)

const Label = ({ children }: { children: ReactNode }) => (
  <div className="pb-1 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">{children}</div>
)

function Example({ text }: { text: string }) {
  return (
    <div className="px-2 py-1.5 text-xs text-muted-foreground">
      <span className="italic">None yet.</span> Try: <code className="rounded bg-muted px-1 py-px font-mono text-[11px] text-foreground [overflow-wrap:anywhere]">{text}</code>
    </div>
  )
}

/** Closed groups, kept between visits. */
function useClosed() {
  const [closed, setClosed] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(storage.get('ht.happyClosed') ?? '[]') as string[]) } catch { return new Set() }
  })
  const toggle = (id: string) => setClosed((was) => {
    const next = new Set(was)
    if (!next.delete(id)) next.add(id)
    storage.set('ht.happyClosed', JSON.stringify([...next]))
    return next
  })
  return { isOpen: (id: string) => !closed.has(id), toggle }
}

/**
 * Children hung on a line with a rounded elbow (└) into each one. The line stops at the last child.
 * `at` is how far down a child its first line sits, so the elbow meets it in the middle.
 */
function Tree({ at = 18, className, children }: { at?: number; className?: string; children: ReactNode }) {
  const items = Children.toArray(children)
  return (
    <div className={className}>
      {items.map((child, i) => (
        <div key={isValidElement(child) && child.key != null ? child.key : i} className="relative pl-4">
          {i < items.length - 1 && <span aria-hidden="true" className="absolute inset-y-0 left-0 border-l" />}
          <span aria-hidden="true" className="absolute top-0 left-0 w-3 rounded-bl-lg border-b border-l" style={{ height: at }} />
          {child}
        </div>
      ))}
    </div>
  )
}

const TONES = {
  violet: 'text-violet-600 dark:text-violet-400',
  sky: 'text-sky-600 dark:text-sky-400',
  amber: 'text-amber-600 dark:text-amber-400',
}

/** Leads the row, as in a file tree, so it sits far from the run button at the other end. */
const Chevron = ({ open }: { open: boolean }) => (
  <ChevronRightIcon className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} aria-hidden="true" />
)

/** Level 1: a soft row that turns grey while open, and stays on top while its tests scroll by. */
function Section({ id, icon: Icon, tone, label, tests, hint, run, open, onToggle, statusOf, children }: {
  id: string; icon: LucideIcon; tone: keyof typeof TONES; label: string; tests: TestRow[]; hint: string; run: ReactNode
  open: boolean; onToggle: () => void; statusOf: (t: TestRow) => string; children: ReactNode
}) {
  const failed = tests.filter((t) => isFailure(statusOf(t))).length
  return (
    <section aria-labelledby={`happy-${id}`}>
      <div className="sticky top-0 z-10 flex items-center gap-1 bg-background px-2 py-1">
        <button
          type="button" id={`happy-${id}`} aria-expanded={open} onClick={onToggle}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
            open && 'bg-muted',
          )}
        >
          <Chevron open={open} />
          <Icon className={cn('size-5 shrink-0', TONES[tone])} aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block text-base font-semibold">{label}</span>
            <span className="block truncate text-sm text-muted-foreground" title={hint}>{hint}</span>
          </span>
          <span className="flex shrink-0 flex-col items-end text-sm leading-5">
            <span className="text-muted-foreground tabular-nums">{tests.length} {tests.length === 1 ? 'test' : 'tests'}</span>
            {failed > 0 && <span className="font-medium text-red-700 tabular-nums dark:text-red-400">{failed} failed</span>}
          </span>
        </button>
        {run}
      </div>
      {/* The line drops from the middle of the chevron above (8px + 8px + half of 16px). */}
      {open && <Tree className="mr-2 mb-2 ml-6 pt-0.5">{children}</Tree>}
    </section>
  )
}

/** Level 2: one part of the app, hung on its section's line, with its coverage and tests on its own. */
function Part({ part, tests, open, onToggle, filtering, renderTest, renderRun }: {
  part: string; tests: TestRow[]; open: boolean; onToggle: () => void; filtering: boolean; renderTest: RenderTest; renderRun: RenderRun
}) {
  const name = partLabel(part)
  return (
    <div>
      <div className="flex items-center gap-1">
        <button
          type="button" aria-expanded={open} onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <Chevron open={open} />
          <BoxIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="flex-1 text-sm font-medium">{name}</span>
          <span className="text-sm text-muted-foreground tabular-nums">{tests.length}</span>
        </button>
        {renderRun(`Run every ${name} test`, runnable(tests))}
      </div>
      {open && (
        // From the middle of the chevron (8px + half of 16px).
        <Tree className="mb-1 ml-4">
          {!filtering && (
            <div key="coverage" className="py-1.5 pr-1 pl-2">
              <Label>Coverage</Label>
              <PartSummary tests={tests} />
            </div>
          )}
          {tests.map((t) => renderTest(t, <TestFacets row={t} />))}
        </Tree>
      )}
    </div>
  )
}

/**
 * The happy path, the way testers split it, as a tree:
 *   Full user journeys → tests (one story across the app)
 *   Feature flows → each part of the app → its coverage (who, checks, data, start) and its tests
 *   Side effects → tests (an email), also when they sit in another group
 */
export function HappyPath({ journeys, flows, sideEffects, filtering, statusOf, renderTest, renderRun }: {
  journeys: TestRow[]
  flows: TestRow[]
  /** Every test that checks an email, from any group. */
  sideEffects: TestRow[]
  filtering: boolean
  statusOf: (t: TestRow) => string
  renderTest: RenderTest
  renderRun: RenderRun
}) {
  const { isOpen, toggle } = useClosed()
  // While filtering, everything is open so a match is never hidden.
  const open = (id: string) => filtering || isOpen(id)
  const byPart = new Map<string, TestRow[]>()
  for (const t of flows) {
    const p = parts(t.steps)[0] ?? 'other'
    byPart.set(p, [...(byPart.get(p) ?? []), t])
  }
  const journey = typeInfo('journey')
  const flow = typeInfo('flow')

  return (
    <div className="mt-1 space-y-1 border-t pt-1">
      {(!filtering || journeys.length > 0) && (
        <Section
          id="journeys" icon={journey.icon} tone="violet" label={`${journey.label}s`} tests={journeys} hint={journey.hint} statusOf={statusOf}
          run={renderRun(`Run every ${journey.label}`, runnable(journeys))} open={open('journeys')} onToggle={() => toggle('journeys')}
        >
          {!journeys.length ? <Example text={journey.example} /> : journeys.map((t) => renderTest(t, <TestFacets row={t} journey />))}
        </Section>
      )}

      {(!filtering || flows.length > 0) && (
        <Section
          id="flows" icon={flow.icon} tone="sky" label={`${flow.label}s`} tests={flows} hint={`${flow.hint}, per part of the app`} statusOf={statusOf}
          run={renderRun(`Run every ${flow.label}`, runnable(flows))} open={open('flows')} onToggle={() => toggle('flows')}
        >
          {!flows.length && <Example text={flow.example} />}
          {[...byPart].sort(([a], [b]) => a.localeCompare(b)).map(([part, tests]) => (
            <Part
              key={part} part={part} tests={tests} filtering={filtering} renderTest={renderTest} renderRun={renderRun}
              open={open(`part:${part}`)} onToggle={() => toggle(`part:${part}`)}
            />
          ))}
        </Section>
      )}

      {(!filtering || sideEffects.length > 0) && (
        <Section
          id="side-effects" icon={MailIcon} tone="amber" label="Side effects" tests={sideEffects} statusOf={statusOf}
          hint="Something happens beyond the page, like an email. Also listed in its own group."
          run={renderRun('Run every side-effect test', runnable(sideEffects))} open={open('side-effects')} onToggle={() => toggle('side-effects')}
        >
          {!sideEffects.length
            ? <Example text={CHECKS.find((c) => c.id === 'email')!.example} />
            : sideEffects.map((t) => renderTest(t, <TestFacets row={t} also={typeInfo(testType(t)).label} />))}
        </Section>
      )}
    </div>
  )
}
