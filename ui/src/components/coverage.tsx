import { useState } from 'react'
import { CheckIcon, ChevronRightIcon, CircleIcon, CodeIcon, FilePlus2Icon, LoaderCircleIcon, XIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { saveDraft, type GapArea, type GapLine, type GapRequest } from '@/lib/api'
import { formatWhen, friendlyProblem } from '@/lib/format'
import type { HumanTest } from '@/lib/use-humantest'
import { cn } from '@/lib/utils'

/** One request's rules about single fields are counted, not listed: they would drown the rest. */
const isFieldRule = (l: GapLine) => l.group === 'What the request must contain' && !l.ids.some((id) => id.startsWith('check:'))

/**
 * What the tests don't cover: per part of the app, how much the tests reach and check; then each
 * rule no test checks, with a draft test where one can be made. Read from the last run and the code.
 */
export function Coverage({ ht }: { ht: HumanTest }) {
  const [area, setArea] = useState<string | null>(null)
  const c = ht.coverage

  if (!c || (!c.report && c.computing)) {
    return (
      <p className="m-6 flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
        <LoaderCircleIcon className="size-4 animate-spin" /> Reading the app's code and the last run…
      </p>
    )
  }
  if (!c.report) {
    return (
      <Empty className="min-h-[60vh]">
        <EmptyHeader>
          <EmptyTitle>No coverage yet</EmptyTitle>
          <EmptyDescription>{c.error ?? 'This project has no app code set up ("source" in humantest.config.json), or nothing has run yet.'}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  const r = c.report
  const shown = (x: { area: string }) => !area || x.area === area
  const open = r.reached.filter(shown).map((q) => ({ q, open: q.lines.filter((l) => !l.checked) })).filter((x) => x.open.length)
  const unreached = r.unreached.filter(shown)

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">What the tests cover</h1>
          <p className="text-sm text-muted-foreground">
            Which requests the tests reach, and which of their rules a test checks. Read from the last run and the app's code.
          </p>
        </div>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
          {c.computing ? <><LoaderCircleIcon className="size-3.5 animate-spin" /> Updating…</> : c.at ? `Updated ${formatWhen(c.at)}` : ''}
        </span>
      </div>

      <AreaTable areas={r.areas} selected={area} onSelect={(a) => {
        setArea(a === area ? null : a)
        // The list is under the table: take the reader there.
        if (a !== area) requestAnimationFrame(() => document.getElementById('open-title')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
      }} />

      {area && (
        <p className="flex items-center gap-2 text-sm">
          Showing <span className="font-semibold">{area}</span> only.
          <Button variant="ghost" size="sm" onClick={() => setArea(null)}><XIcon /> Show everything</Button>
        </p>
      )}

      <section aria-labelledby="open-title" className="space-y-2">
        <h2 id="open-title" className="text-sm font-semibold">Not checked by any test, in what the tests reach</h2>
        <p className="text-xs text-muted-foreground">What stops the user and what a request changes first. A draft test does what a test that gets there does, up to that request; change its steps so the rule happens.</p>
        {open.length ? (
          <div className="overflow-hidden rounded-xl border bg-card">
            {open.map(({ q, open }) => <OpenRequest key={q.request} ht={ht} q={q} open={open} />)}
          </div>
        ) : (
          <p className="rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">Every rule in what the tests reach is checked.</p>
        )}
      </section>

      {unreached.length > 0 && (
        <section aria-labelledby="unreached-title" className="space-y-2">
          <h2 id="unreached-title" className="text-sm font-semibold">Not reached by any test ({unreached.length})</h2>
          <Collapsible>
            <CollapsibleTrigger className="group flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
              <ChevronRightIcon className="size-4 transition-transform group-data-[state=open]:rotate-90" /> Show the requests
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ul className="mt-2 grid gap-x-6 gap-y-1 rounded-xl border bg-card p-3 text-sm sm:grid-cols-2">
                {unreached.map((u) => (
                  <li key={u.request} className="flex min-w-0 justify-between gap-2">
                    <span className="truncate font-mono text-xs" title={u.request}>{u.request}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{u.rules} rule{u.rules === 1 ? '' : 's'}</span>
                  </li>
                ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        </section>
      )}
    </div>
  )
}

function Bar({ value, of, label }: { value: number; of: number; label: string }) {
  const pct = of ? Math.round((value / of) * 100) : 0
  return (
    <div className="flex min-w-0 items-center gap-2">
      <div className="h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-muted" role="img" aria-label={`${label}: ${value} of ${of}`}>
        <div className="h-full rounded-full bg-emerald-600 dark:bg-emerald-400" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs whitespace-nowrap tabular-nums">{value} of {of}</span>
    </div>
  )
}

function AreaTable({ areas, selected, onSelect }: { areas: GapArea[]; selected: string | null; onSelect: (a: string) => void }) {
  return (
    <div className="overflow-x-auto rounded-xl border bg-card">
      <table className="w-full text-sm">
        <caption className="sr-only">Coverage per part of the app</caption>
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th scope="col" className="px-4 py-2 font-medium">Part of the app</th>
            <th scope="col" className="px-4 py-2 font-medium">Requests a test reaches</th>
            <th scope="col" className="px-4 py-2 font-medium">Rules a test checks (in what is reached)</th>
          </tr>
        </thead>
        <tbody>
          {areas.map((a) => (
            <tr key={a.name} className={cn('border-b last:border-b-0', selected === a.name && 'bg-violet-50 dark:bg-violet-950/40')}>
              <th scope="row" className="px-4 py-1.5 text-left font-normal">
                <button type="button" onClick={() => onSelect(a.name)} aria-pressed={selected === a.name}
                  className="rounded font-medium hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                  {a.name === 'page' ? 'on the page' : a.name}
                </button>
              </th>
              <td className="px-4 py-1.5"><Bar value={a.reached} of={a.requests} label="Requests reached" /></td>
              <td className="px-4 py-1.5">
                {a.reached ? <Bar value={a.checked} of={a.reachedRules} label="Rules checked" /> : <span className="text-xs text-muted-foreground">nothing reached</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function OpenRequest({ ht, q, open }: { ht: HumanTest; q: GapRequest; open: GapLine[] }) {
  const fields = open.filter(isFieldRule)
  const listed = open.filter((l) => !isFieldRule(l))
  const by = q.reachedBy.slice(0, 2).map((b) => `"${b.test}"`).join(', ') + (q.reachedBy.length > 2 ? ` and ${q.reachedBy.length - 2} more` : '')
  return (
    <div className="border-t px-4 py-3 first:border-t-0">
      <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="font-mono font-semibold">{q.request}</span>
        <span className="text-xs text-muted-foreground">{q.lines.length - open.length} of {q.lines.length} checked · reached by {by}</span>
      </p>
      <ul className="mt-2 space-y-2">
        {listed.map((l, i) => <OpenLine key={i} ht={ht} line={l} root={q.root} />)}
      </ul>
      {fields.length > 0 && <p className="mt-2 pl-6 text-xs text-muted-foreground">and {fields.length} rule{fields.length === 1 ? '' : 's'} about single fields of the request</p>}
    </div>
  )
}

function OpenLine({ ht, line, root }: { ht: HumanTest; line: GapLine; root: string }) {
  const [state, setState] = useState<{ busy?: boolean; file?: string }>({})
  const make = async () => {
    if (!ht.project || !line.draft) return
    setState({ busy: true })
    let r: Awaited<ReturnType<typeof saveDraft>>
    try { r = await saveDraft(ht.project, line.draft) } catch (e) { r = { error: String(e) } }
    if (r.error || !r.file) {
      setState({})
      toast.error('Could not save the draft.', { description: r.error })
      return
    }
    setState({ file: r.file })
    const problems = r.diagnostics ?? []
    toast.success(`Saved as ${r.file}`, {
      description: problems.length
        ? `It needs fixing before it can run: ${friendlyProblem(problems[0])}`
        : 'It is listed with your tests but not run while it says "Draft:". Change its steps, then change "Draft:" to "Test:".',
      ...(r.path ? { action: { label: 'Open in VS Code', onClick: () => { window.location.href = `vscode://file/${r.path!.replace(/\\/g, '/')}` } } } : {}),
    })
  }
  return (
    <li className="grid grid-cols-[16px_1fr] gap-2 text-sm">
      <CircleIcon className="mt-0.5 size-4 text-amber-600 dark:text-amber-400" aria-label="Not checked by any test" />
      <div className="min-w-0">
        <p className="break-words">{line.text}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <span>{line.group}</span>
          <span className="font-mono">{root}/{line.source.file}:{line.source.line}</span>
          {!line.translated && <span className="inline-flex items-center gap-1"><CodeIcon className="size-3" />condition shown as code</span>}
        </p>
        {line.draft && (
          state.file ? (
            <p className="mt-1.5 flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400"><CheckIcon className="size-3.5" /> Draft saved as <span className="font-mono">{state.file}</span></p>
          ) : (
            <Button size="sm" variant="outline" className="mt-1.5" disabled={state.busy} onClick={make}>
              {state.busy ? <LoaderCircleIcon className="animate-spin" /> : <FilePlus2Icon />} Make a draft test
            </Button>
          )
        )}
      </div>
    </li>
  )
}
