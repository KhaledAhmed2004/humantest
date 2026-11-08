import { useEffect, useState, type ReactNode } from 'react'
import { CheckCircle2Icon, CheckIcon, ChevronRightIcon, CircleIcon, CodeIcon, CornerLeftUpIcon, GitCompareArrowsIcon, LoaderCircleIcon, MousePointerClickIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { DraftButton } from '@/components/draft-button'
import { editorLink } from '@/lib/editor'
import { getDiscovery, type DiscoveredCall, type DiscoveryResponse, type PageRules, type RuleGroup, type RuleLine, type TestChange } from '@/lib/api'
import { humanize } from '../../../src/humanize'
import { cn } from '@/lib/utils'

/** The same request (by its route, not the ids in its path) or the same click: its rules are the same. */
const callKey = (c: DiscoveredCall) => ('route' in c ? `${c.route.method} ${c.route.path}` : c.request)
const pageKey = (p: PageRules) => `page ${p.component} "${p.label}"`
/** Rules whose breaking lets the wrong person in, lets bad data through, or loses data. */
const IMPORTANT = new Set(['Who can do it', 'When the server says no', 'What it changes'])

/** Checked by this test, by another test only, or by none (an important gap, or a minor one). */
type RuleState = 'this' | 'other' | 'gap-important' | 'gap'
const stateOf = (l: RuleLine, group: string): RuleState =>
  l.checked ? 'this' : l.checkedElsewhere?.length ? 'other' : IMPORTANT.has(group) ? 'gap-important' : 'gap'
const isGap = (s: RuleState) => s === 'gap' || s === 'gap-important'
const statesOf = (groups: RuleGroup[]) => groups.flatMap((g) => g.lines.map((l) => stateOf(l, g.title)))

interface Tally { total: number; mine: number; other: number; gaps: number; important: number }
function tallyOf(states: RuleState[]): Tally {
  const n = (s: RuleState) => states.filter((x) => x === s).length
  return { total: states.length, mine: n('this'), other: n('other'), gaps: states.filter(isGap).length, important: n('gap-important') }
}

/** One field's rules ("name is required, must be text…"): many and minor, so they are folded. */
const isFieldLine = (l: RuleLine, group: string) => group === 'What the request must contain' && l.ids.every((id) => id.startsWith('field:'))
/** `field:query.search:required` → "search". */
const fieldName = (l: RuleLine) => l.ids[0]?.split(':')[1]?.split('.').pop() ?? '?'

/** Where a rule's code is, and the folder on this computer to open it from. */
interface Where { root?: string; dir?: string }

/**
 * The business rules behind each step: what the app's code does for the API calls the step made.
 * Read from the code (src/discovery), never guessed; each rule says where it is.
 */
export function BusinessLogic({ project, testKey, version, running, change, onAccept }: {
  project: string; testKey: string; version: number; running: boolean
  change?: TestChange; onAccept: () => Promise<void>
}) {
  const [data, setData] = useState<DiscoveryResponse | null>(null)
  const [onlyGaps, setOnlyGaps] = useState(false)

  useEffect(() => {
    let current = true
    getDiscovery(project, testKey).then((d) => { if (current) setData(d) }).catch(() => { if (current) setData(null) })
    return () => { current = false }
  }, [project, testKey, version])

  if (!data || !data.configured) return null

  // A click with no rules of its own (it only opens something) isn't worth a row.
  const hasPageRules = (s: { page?: { groups: { lines: unknown[] }[] } }) => !!s.page?.groups.some((g) => g.lines.length)
  const steps = data.result?.steps.filter((s) => s.calls.length || hasPageRules(s)) ?? []

  // The first step that makes each request: later ones point back to it instead of listing its rules again.
  const firstAt = new Map<string, number>()
  steps.forEach((s, i) => {
    if (s.page && hasPageRules(s) && !firstAt.has(pageKey(s.page))) firstAt.set(pageKey(s.page), i)
    for (const c of s.calls) if (!firstAt.has(callKey(c))) firstAt.set(callKey(c), i)
  })
  // Every rule once, however many steps reach it.
  const all = tallyOf(steps.flatMap((s, i) => [
    ...(s.page && firstAt.get(pageKey(s.page)) === i ? statesOf(s.page.groups) : []),
    ...s.calls.flatMap((c) => ('groups' in c && firstAt.get(callKey(c)) === i ? statesOf(c.groups) : [])),
  ]))
  const code: Where = { root: data.result?.codeRoot, dir: data.result?.codeDir }
  const front: Where = { root: data.result?.frontRoot, dir: data.result?.frontDir }
  const ctx = { project, onlyGaps }

  return (
    <section className="space-y-2" aria-labelledby="business-logic-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="business-logic-title" className="text-sm font-semibold">Business logic</h2>
        {all.total > 0 && (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1"><CheckCircle2Icon className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />{all.mine} checked by this test</span>
            {all.other > 0 && <span className="inline-flex items-center gap-1"><CheckCircle2Icon className="size-3.5" aria-hidden="true" />{all.other} by other tests</span>}
            <span className="inline-flex items-center gap-1">
              <CircleIcon className="size-3.5" aria-hidden="true" />{all.gaps} by no test
              {all.important > 0 && <span className="text-amber-700 dark:text-amber-400">({all.important} important)</span>}
            </span>
            {all.gaps > 0 && all.gaps < all.total && (
              <span role="group" aria-label="Which rules to show" className="inline-flex rounded-md border p-0.5">
                {([[false, 'All rules'], [true, 'Gaps only']] as const).map(([v, label]) => (
                  <button key={label} type="button" aria-pressed={onlyGaps === v} onClick={() => setOnlyGaps(v)}
                    className={cn('rounded px-2 py-0.5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                      onlyGaps === v ? 'bg-secondary font-medium text-foreground' : 'hover:text-foreground')}>
                    {label}
                  </button>
                ))}
              </span>
            )}
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">What the app's code does behind these steps, read from the code itself. Each rule shows where it is.</p>

      {change?.status === 'changed' && <ChangeBox change={change} onAccept={onAccept} codeRoot={data.result?.codeRoot} frontRoot={data.result?.frontRoot} />}

      {running || data.running ? (
        <p className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
          <LoaderCircleIcon className="size-4 animate-spin" /> Reading the app's code…
        </p>
      ) : !data.result ? (
        <p className="rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">Run this test to see the business logic behind its steps.</p>
      ) : !steps.length ? (
        <p className="rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">None of the steps called the server or clicked something with rules of its own, so there is no logic to show.</p>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          {steps.map((s, i) => {
            const title = (j: number) => humanize(steps[j].text).text
            // With "only not checked", what has nothing left open (or was shown before) is left out.
            const open = (groups: RuleGroup[]) => !onlyGaps || statesOf(groups).some(isGap)
            const rows: ReactNode[] = []
            if (s.page && hasPageRules(s)) {
              const first = firstAt.get(pageKey(s.page))!
              if (first === i) { if (open(s.page.groups)) rows.push(<PageRulesBlock key="page" page={s.page} where={front} {...ctx} />) }
              else if (!onlyGaps) rows.push(<SameAsBefore key="page" label={<><MousePointerClickIcon className="size-3.5 shrink-0" aria-hidden="true" /><span className="font-semibold">On the page</span><span className="truncate text-muted-foreground">"{s.page.label}"</span></>} step={title(first)} {...tallyOf(statesOf(s.page.groups))} />)
            }
            s.calls.forEach((c, j) => {
              const first = firstAt.get(callKey(c))!
              // The same request twice in one step: once is enough.
              if (s.calls.findIndex((x) => callKey(x) === callKey(c)) !== j) return
              if (!('groups' in c)) rows.push(<CallRules key={j} call={c} where={code} {...ctx} />)
              else if (first === i) { if (open(c.groups)) rows.push(<CallRules key={j} call={c} where={code} {...ctx} />) }
              else if (!onlyGaps) rows.push(<SameAsBefore key={j} label={<CallLabel call={c} />} step={title(first)} {...tallyOf(statesOf(c.groups))} />)
            })
            if (!rows.length) return null
            return (
              <div key={i} className="border-t first:border-t-0">
                <div className="px-4 pt-2.5 pb-1 text-sm font-medium" title={`Line ${s.line} of the test: ${s.text}`}>{humanize(s.text).text}</div>
                <div className="space-y-1 px-2 pb-2">{rows}</div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

/** What changed in the logic since it was accepted, rule by rule, with a way to accept it. */
function ChangeBox({ change, onAccept, codeRoot, frontRoot }: { change: TestChange; onAccept: () => Promise<void>; codeRoot?: string; frontRoot?: string }) {
  const [busy, setBusy] = useState(false)
  // A click's rules live in the frontend's code, an API call's in the backend's.
  const rootOf = (request: string) => (/^(CLICK|UPLOAD) "/.test(request) ? frontRoot : codeRoot)
  const accepted = change.acceptedAt ? new Date(change.acceptedAt).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : undefined
  return (
    <div role="region" aria-label="Business logic changes" className="space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-100">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 font-semibold"><GitCompareArrowsIcon className="size-4" aria-hidden="true" /> The business logic behind this test changed</p>
          <p className="mt-0.5 text-xs text-amber-900/80 dark:text-amber-200/80">
            Compared with what was accepted{accepted ? ` on ${accepted}` : ''}. If the change is intended, accept it; if not, the code has a regression.
          </p>
        </div>
        <Button size="sm" variant="outline" disabled={busy} onClick={async () => { setBusy(true); try { await onAccept() } finally { setBusy(false) } }}
          className="border-amber-400 bg-white text-amber-950 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100 dark:hover:bg-amber-900">
          {busy ? <LoaderCircleIcon className="animate-spin" /> : <CheckIcon />} Accept the change
        </Button>
      </div>
      {change.requests.filter((r) => r.change !== 'same').map((r) => (
        <div key={r.request} className="space-y-1.5">
          <p className="text-xs">
            <span className="font-mono font-semibold">{r.request}</span>
            <span className="ml-2">{r.change === 'removed' ? 'no longer reached' : r.change === 'added' ? (/^(CLICK|UPLOAD) "/.test(r.request) ? 'new on the page' : 'new call') : 'changed'}</span>
          </p>
          {r.change === 'removed' && <p className="text-xs">{r.ruleCount ?? 0} rule(s) were behind it. Run the test again to see what it reaches now.</p>}
          {r.change === 'added' && <p className="text-xs">The test now makes this call, with {r.ruleCount ?? 0} rule(s) behind it.</p>}
          <ul className="space-y-1.5">
            {r.rules.map((x, i) => (
              <li key={i} className="rounded-md bg-white/70 px-2.5 py-1.5 dark:bg-black/20">
                {x.change === 'changed' ? (
                  <>
                    <p><span className="font-semibold">Was: </span><span className="line-through decoration-amber-500/70">{x.before}</span></p>
                    <p><span className="font-semibold">Now: </span>{x.after}</p>
                  </>
                ) : (
                  <p><span className="font-semibold">{x.change === 'added' ? 'New: ' : 'Removed: '}</span>{x.change === 'added' ? x.after : x.before}</p>
                )}
                <p className="mt-0.5 font-mono text-xs opacity-75">{rootOf(r.request) ? `${rootOf(r.request)}/` : ''}{x.source.file}:{x.source.line}</p>
              </li>
            ))}
          </ul>
          {r.functions.length > 0 && (
            <p className="text-xs opacity-80">Code that changed: {r.functions.map((f) => `${f.name}${f.lastCommit ? ` (${f.lastCommit})` : ''}`).join('; ')}</p>
          )}
        </div>
      ))}
    </div>
  )
}

interface RowProps { where: Where; project: string; onlyGaps: boolean }

/**
 * How many of a request's rules this test checks (and other tests). Amber only when an important
 * rule is checked by no test; green when every rule is checked somewhere.
 */
function CheckedCount({ total, mine, other, important }: Tally) {
  const tone = important > 0 ? 'text-amber-700 dark:text-amber-400'
    : mine + other === total ? 'text-emerald-700 dark:text-emerald-400' : 'text-muted-foreground'
  const title = `${mine} of ${total} checked by this test${other ? `, ${other} more by other tests` : ''}${important ? `; ${important} important rule${important === 1 ? '' : 's'} checked by no test` : ''}`
  return (
    <span className={cn('ml-auto shrink-0 tabular-nums', tone)} title={title}>
      {mine} of {total} checked{other > 0 && <span className="text-muted-foreground"> · +{other} by other tests</span>}
    </span>
  )
}

/** "DELETE /api/v1/ports/:id": the route as the code names it, the path the test used in the tooltip. */
function CallLabel({ call }: { call: DiscoveredCall }) {
  const [method, ...rest] = call.request.split(' ')
  const shown = 'route' in call ? call.route.path : rest.join(' ')
  return (
    <>
      <span className="font-mono font-semibold">{method}</span>
      <span className="min-w-0 truncate font-mono text-muted-foreground" title={rest.join(' ')}>{shown}</span>
    </>
  )
}

/** A request an earlier step already made: its rules are listed there. */
function SameAsBefore({ label, step, ...tally }: { label: ReactNode; step: string } & Tally) {
  return (
    <div className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground">
      <CornerLeftUpIcon className="size-3.5 shrink-0" aria-hidden="true" />
      {label}
      <span className="min-w-0 truncate italic">same rules as in "{step}"</span>
      <CheckedCount {...tally} />
    </div>
  )
}

/** The page's own rules for a click: what the browser and the component check before anything is sent. */
function PageRulesBlock({ page, where, project, onlyGaps }: { page: PageRules } & RowProps) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
        <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
        <MousePointerClickIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="font-semibold">On the page</span>
        <span className="min-w-0 truncate text-muted-foreground">"{page.label}" in {page.component}</span>
        <CheckedCount {...tallyOf(statesOf(page.groups))} />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2.5 px-2 pt-1 pb-2 pl-7">
        <RuleGroups groups={page.groups} where={where} project={project} onlyGaps={onlyGaps} titles={false} />
      </CollapsibleContent>
    </Collapsible>
  )
}

function CallRules({ call, where, project, onlyGaps }: { call: DiscoveredCall } & RowProps) {
  if ('problem' in call) {
    return <p className="px-2 py-1 text-xs text-amber-700 dark:text-amber-400"><span className="font-mono">{call.request}</span>: {call.problem}</p>
  }
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
        <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
        <CallLabel call={call} />
        <CheckedCount {...tallyOf(statesOf(call.groups))} />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2.5 px-2 pt-1 pb-2 pl-7">
        <RuleGroups groups={call.groups} where={where} project={project} onlyGaps={onlyGaps} titles />
      </CollapsibleContent>
    </Collapsible>
  )
}

function RuleGroups({ groups, where, project, onlyGaps, titles }: { groups: RuleGroup[]; titles: boolean } & RowProps) {
  return groups.map((g) => {
    const shown = g.lines.map((l) => ({ l, state: stateOf(l, g.title) })).filter((x) => !onlyGaps || isGap(x.state))
    if (!shown.length) return null
    const fields = shown.filter((x) => isFieldLine(x.l, g.title))
    const rest = shown.filter((x) => !isFieldLine(x.l, g.title))
    const item = (x: { l: RuleLine; state: RuleState }, k: number) => <RuleItem key={k} line={x.l} state={x.state} where={where} project={project} />
    return (
      <div key={g.title}>
        {titles && <h3 className="mb-1 text-xs font-semibold text-muted-foreground">{g.title}</h3>}
        <ul className="space-y-1">
          {fields.length > 0 && <FieldRules items={fields} render={item} />}
          {rest.map(item)}
        </ul>
      </div>
    )
  })
}

/** A request's single-field rules, folded into one line that opens. */
function FieldRules({ items, render }: { items: { l: RuleLine; state: RuleState }[]; render: (x: { l: RuleLine; state: RuleState }, k: number) => ReactNode }) {
  const t = tallyOf(items.map((x) => x.state))
  return (
    <li>
      <Collapsible>
        <CollapsibleTrigger className="group grid w-full grid-cols-[16px_1fr] gap-2 rounded-md text-left text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          <ChevronRightIcon className="mt-0.5 size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
          <span className="min-w-0">
            {items.length} rule{items.length === 1 ? '' : 's'} about single fields
            <span className="text-muted-foreground">: {items.map((x) => fieldName(x.l)).join(', ')}</span>
            <span className="ml-2 text-xs text-muted-foreground">{t.mine + t.other} of {t.total} checked</span>
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ul className="mt-1 space-y-1">{items.map(render)}</ul>
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}

function RuleItem({ line, state, where, project }: { line: RuleLine; state: RuleState; where: Where; project: string }) {
  const place = `${where.root ? `${where.root}/` : ''}${line.source.file}:${line.source.line}`
  const how = line.checkedBy === 'status'
    ? `Checked: the test checks that the server answers ${line.status ?? 'this status'}`
    : 'Checked: the test sees this message'
  const others = line.checkedElsewhere ?? []
  const elsewhere = others.length === 1 ? `Checked by another test: "${others[0]}"` : `Checked by ${others.length} other tests`
  const icon = {
    'this': <CheckCircle2Icon className="mt-0.5 size-4 text-emerald-600 dark:text-emerald-400" aria-label="Checked by this test" />,
    'other': <CheckCircle2Icon className="mt-0.5 size-4 text-muted-foreground" aria-label="Checked by another test" />,
    'gap-important': <CircleIcon className="mt-0.5 size-4 text-amber-600 dark:text-amber-400" aria-label="Important, checked by no test" />,
    'gap': <CircleIcon className="mt-0.5 size-4 text-muted-foreground" aria-label="Checked by no test" />,
  }[state]
  return (
    <li className="grid grid-cols-[16px_1fr] gap-2 text-sm">
      {icon}
      <span className="min-w-0">
        <span className={cn('break-words', !line.translated && 'text-foreground/90')}>{line.text}</span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          {where.dir
            ? <a href={editorLink(where.dir, line.source.file, line.source.line)} className="font-mono break-all underline-offset-2 hover:text-foreground hover:underline" title="Open in VS Code">{place}</a>
            : <span className="font-mono break-all">{place}</span>}
          {!line.translated && <span className="inline-flex items-center gap-1"><CodeIcon className="size-3" />condition shown as code</span>}
          {state === 'this' && <span className="text-emerald-700 dark:text-emerald-400">{how}</span>}
          {state === 'other' && <span title={others.join('\n')}>{elsewhere}</span>}
        </span>
        {isGap(state) && line.draft && <DraftButton project={project} draft={line.draft} label="Test this" className="mt-1.5" />}
      </span>
    </li>
  )
}
