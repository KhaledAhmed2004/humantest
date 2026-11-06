import { useEffect, useState } from 'react'
import { CheckCircle2Icon, CheckIcon, ChevronRightIcon, CircleIcon, CodeIcon, GitCompareArrowsIcon, LoaderCircleIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { getDiscovery, type DiscoveredCall, type DiscoveryResponse, type RuleLine, type TestChange } from '@/lib/api'
import { humanize } from '../../../src/humanize'
import { cn } from '@/lib/utils'

/**
 * The business rules behind each step: what the app's code does for the API calls the step made.
 * Read from the code (src/discovery), never guessed; each rule says where it is.
 */
export function BusinessLogic({ project, testKey, version, running, change, onAccept }: {
  project: string; testKey: string; version: number; running: boolean
  change?: TestChange; onAccept: () => Promise<void>
}) {
  const [data, setData] = useState<DiscoveryResponse | null>(null)

  useEffect(() => {
    let current = true
    getDiscovery(project, testKey).then((d) => { if (current) setData(d) }).catch(() => { if (current) setData(null) })
    return () => { current = false }
  }, [project, testKey, version])

  if (!data || !data.configured) return null

  const steps = data.result?.steps.filter((s) => s.calls.length) ?? []
  const lines = steps.flatMap((s) => s.calls.flatMap((c) => ('groups' in c ? c.groups.flatMap((g) => g.lines) : [])))
  const checked = lines.filter((l) => l.checked).length

  return (
    <section className="space-y-2" aria-labelledby="business-logic-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="business-logic-title" className="text-sm font-semibold">Business logic</h2>
        {lines.length > 0 && (
          <span className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1"><CheckCircle2Icon className="size-3.5 text-emerald-600 dark:text-emerald-400" />{checked} checked by this test</span>
            <span className="inline-flex items-center gap-1"><CircleIcon className="size-3.5 text-amber-600 dark:text-amber-400" />{lines.length - checked} not checked</span>
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">What the app's code does behind these steps, read from the code itself. Each rule shows where it is.</p>

      {change?.status === 'changed' && <ChangeBox change={change} onAccept={onAccept} codeRoot={data.result?.codeRoot} />}

      {running || data.running ? (
        <p className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
          <LoaderCircleIcon className="size-4 animate-spin" /> Reading the app's code…
        </p>
      ) : !data.result ? (
        <p className="rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">Run this test to see the business logic behind its steps.</p>
      ) : !steps.length ? (
        <p className="rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">None of the steps called the server, so there is no backend logic to show.</p>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          {steps.map((s, i) => (
            <div key={i} className="border-t first:border-t-0">
              <div className="px-4 pt-2.5 pb-1 text-sm font-medium" title={`Line ${s.line} of the test: ${s.text}`}>{humanize(s.text).text}</div>
              <div className="space-y-1 px-2 pb-2">
                {s.calls.map((c, j) => <CallRules key={j} call={c} codeRoot={data.result?.codeRoot} />)}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

/** What changed in the logic since it was accepted, rule by rule, with a way to accept it. */
function ChangeBox({ change, onAccept, codeRoot }: { change: TestChange; onAccept: () => Promise<void>; codeRoot?: string }) {
  const [busy, setBusy] = useState(false)
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
            <span className="ml-2">{r.change === 'removed' ? 'no longer reached' : r.change === 'added' ? 'new call' : 'changed'}</span>
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
                <p className="mt-0.5 font-mono text-xs opacity-75">{codeRoot ? `${codeRoot}/` : ''}{x.source.file}:{x.source.line}</p>
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

function CallRules({ call, codeRoot }: { call: DiscoveredCall; codeRoot?: string }) {
  if ('problem' in call) {
    return <p className="px-2 py-1 text-xs text-amber-700 dark:text-amber-400"><span className="font-mono">{call.request}</span>: {call.problem}</p>
  }
  const count = call.groups.reduce((n, g) => n + g.lines.length, 0)
  const [method, ...rest] = call.request.split(' ')
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
        <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
        <span className="font-mono font-semibold">{method}</span>
        <span className="min-w-0 truncate font-mono text-muted-foreground">{rest.join(' ')}</span>
        <span className="ml-auto shrink-0 text-muted-foreground">{count} rule{count === 1 ? '' : 's'}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2.5 px-2 pt-1 pb-2 pl-7">
        {call.groups.map((g) => (
          <div key={g.title}>
            <h3 className="mb-1 text-xs font-semibold text-muted-foreground">{g.title}</h3>
            <ul className="space-y-1">
              {g.lines.map((l, k) => <RuleItem key={k} line={l} codeRoot={codeRoot} />)}
            </ul>
          </div>
        ))}
      </CollapsibleContent>
    </Collapsible>
  )
}

function RuleItem({ line, codeRoot }: { line: RuleLine; codeRoot?: string }) {
  return (
    <li className="grid grid-cols-[16px_1fr] gap-2 text-sm">
      {line.checked
        ? <CheckCircle2Icon className="mt-0.5 size-4 text-emerald-600 dark:text-emerald-400" aria-label="Checked by this test" />
        : <CircleIcon className="mt-0.5 size-4 text-amber-600 dark:text-amber-400" aria-label="Not checked by this test" />}
      <span className="min-w-0">
        <span className={cn('break-words', !line.translated && 'text-foreground/90')}>{line.text}</span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <span className="font-mono">{codeRoot ? `${codeRoot}/` : ''}{line.source.file}:{line.source.line}</span>
          {!line.translated && <span className="inline-flex items-center gap-1"><CodeIcon className="size-3" />condition shown as code</span>}
        </span>
      </span>
    </li>
  )
}
