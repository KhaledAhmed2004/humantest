import { useState } from 'react'
import { CheckCircle2Icon, CodeIcon, LoaderCircleIcon, MousePointerClickIcon } from 'lucide-react'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import type { GapLine, GapReport, GapRequest } from '@/lib/api'
import { storage } from '@/lib/format'
import type { HumanTest } from '@/lib/use-humantest'
import { cn } from '@/lib/utils'

/** The order people read a request's rules in (as src/discovery/rules/present.mts groups them). */
const READING_ORDER = ['On the page, before anything is sent', 'Who can do it', 'What the request must contain', 'When the server says no', 'What it changes', 'The answer when all is well']
const rank = (g: string) => { const i = READING_ORDER.indexOf(g); return i < 0 ? READING_ORDER.length : i }
const VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

interface FeatureRequest { request: string; title?: string; root: string; reachedBy: GapRequest['reachedBy']; lines: GapLine[]; reached: boolean }

/** One part of the app as a whole (like featureOf in src/discovery/gaps.mts). */
function featureOf(r: GapReport, name: string): { requests: FeatureRequest[]; page: GapRequest[] } {
  const sorted = (lines: GapLine[]) => [...lines].sort((a, b) => rank(a.group) - rank(b.group))
  const requests: FeatureRequest[] = [
    ...r.reached.filter((q) => q.area === name).map((q) => ({ ...q, lines: sorted(q.lines), reached: true })),
    ...r.unreached.filter((u) => u.area === name).map((u) => ({ request: u.request, title: u.title, root: u.root, reachedBy: [], lines: sorted(u.lines), reached: false })),
  ]
  const parts = (x: string) => { const [m, p] = x.split(' '); return { m: VERBS.indexOf(m), p } }
  requests.sort((a, b) => { const x = parts(a.request), y = parts(b.request); return x.p.localeCompare(y.p) || x.m - y.m })
  return { requests, page: r.reached.filter((q) => q.area === 'page' && q.request.includes(`/${name}/`)) }
}

/**
 * What the app does, one part at a time, for people who don't read the code: every request (tested
 * or not) with who may, what it needs, when it says no, what it changes. Read from the code.
 */
export function Features({ ht }: { ht: HumanTest }) {
  const c = ht.coverage
  const [chosen, setChosen] = useState<string | null>(storage.get('ht.feature'))

  if (!c || (!c.report && c.computing)) {
    return (
      <p className="m-6 flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
        <LoaderCircleIcon className="size-4 animate-spin" /> Reading the app's code…
      </p>
    )
  }
  if (!c.report) {
    return (
      <Empty className="min-h-[60vh]">
        <EmptyHeader>
          <EmptyTitle>Nothing to show yet</EmptyTitle>
          <EmptyDescription>{c.error ?? 'This project has no app code set up ("source" in humantest.config.json).'}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  const areas = c.report.areas.filter((a) => a.name !== 'page')
  const name = areas.some((a) => a.name === chosen) ? chosen! : areas[0]?.name
  const choose = (n: string) => { setChosen(n); storage.set('ht.feature', n) }
  const f = name ? featureOf(c.report, name) : undefined

  return (
    <div className="flex min-h-full flex-col md:flex-row">
      <nav aria-label="Parts of the app" className="border-b bg-background md:w-56 md:shrink-0 md:border-r md:border-b-0">
        <ul className="flex gap-1 overflow-x-auto p-2 md:flex-col md:overflow-visible">
          {areas.map((a) => (
            <li key={a.name} className="shrink-0">
              <button type="button" onClick={() => choose(a.name)} aria-current={a.name === name ? 'true' : undefined}
                className={cn('flex w-full items-baseline justify-between gap-3 rounded-md px-3 py-1.5 text-left text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                  a.name === name && 'bg-violet-50 font-semibold dark:bg-violet-950/40')}>
                <span>{a.name}</span>
                {/* On the tinted chosen item, muted grey is too faint (WCAG contrast). */}
                <span className={cn('text-xs whitespace-nowrap text-muted-foreground tabular-nums', a.name === name && 'text-foreground/75')}>{a.reached}/{a.requests} tested</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>

      {f && (
        <div className="min-w-0 flex-1 space-y-4 p-4 sm:p-6">
          <div>
            <h1 className="text-lg font-semibold capitalize">{name}</h1>
            <p className="text-sm text-muted-foreground">
              What this part of the app does, request by request, read from its code.{' '}
              {f.requests.filter((r) => r.reached).length} of {f.requests.length} are reached by a test;
              <CheckCircle2Icon className="mx-1 inline size-3.5 align-[-2px] text-emerald-600 dark:text-emerald-400" aria-hidden="true" />marks what a test checks.
            </p>
          </div>
          {f.requests.map((r) => <RequestCard key={r.request} r={r} />)}
          {f.page.length > 0 && (
            <section aria-labelledby="page-rules" className="space-y-2">
              <h2 id="page-rules" className="flex items-center gap-1.5 text-sm font-semibold"><MousePointerClickIcon className="size-4" aria-hidden="true" /> On its pages (what the tests clicked)</h2>
              {f.page.map((p) => (
                <div key={p.request} className="rounded-xl border bg-card p-4">
                  <p className="mb-2 font-mono text-xs text-muted-foreground">{p.request}</p>
                  <Rules lines={p.lines} root={p.root} />
                </div>
              ))}
            </section>
          )}
        </div>
      )}
    </div>
  )
}

function RequestCard({ r }: { r: FeatureRequest }) {
  const [method, ...path] = r.request.split(' ')
  const tests = [...new Set(r.reachedBy.map((b) => b.test))]
  return (
    <article className="rounded-xl border bg-card p-4" aria-labelledby={`req-${r.request}`}>
      <header className="mb-3 space-y-1">
        <h2 id={`req-${r.request}`} className="text-base font-semibold">{r.title ?? r.request}</h2>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="font-mono"><span className="font-semibold text-foreground">{method}</span> {path.join(' ')}</span>
          {r.reached
            ? <span>Tested by {tests.slice(0, 3).map((t) => `"${t}"`).join(', ')}{tests.length > 3 ? ` and ${tests.length - 3} more` : ''}</span>
            : <span className="rounded bg-amber-100 px-1.5 py-px font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-200">No test reaches this</span>}
        </p>
      </header>
      {r.lines.length ? <Rules lines={r.lines} root={r.root} /> : <p className="text-sm text-muted-foreground">No rules found in its code.</p>}
    </article>
  )
}

function Rules({ lines, root }: { lines: GapLine[]; root: string }) {
  const groups: { title: string; lines: GapLine[] }[] = []
  for (const l of lines) {
    if (groups.at(-1)?.title !== l.group) groups.push({ title: l.group, lines: [] })
    groups.at(-1)!.lines.push(l)
  }
  return (
    <div className="space-y-3">
      {groups.map((g) => (
        <div key={g.title}>
          <h3 className="mb-1 text-xs font-semibold text-muted-foreground">{g.title}</h3>
          <ul className="space-y-1">
            {g.lines.map((l, i) => (
              <li key={i} className="grid grid-cols-[16px_1fr] gap-2 text-sm">
                {l.checked
                  ? <CheckCircle2Icon className="mt-0.5 size-4 text-emerald-600 dark:text-emerald-400" aria-label="Checked by a test" />
                  : <span className="mt-2 ml-1.5 size-1.5 rounded-full bg-muted-foreground/50" aria-hidden="true" />}
                <span className="min-w-0">
                  <span className="break-words">{l.text}</span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    <span className="font-mono break-all">{root}/{l.source.file}:{l.source.line}</span>
                    {!l.translated && <span className="inline-flex items-center gap-1"><CodeIcon className="size-3" />condition shown as code</span>}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}
