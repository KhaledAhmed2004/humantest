import { useMemo, useState } from 'react'
import { CodeIcon, ExternalLinkIcon, FileTextIcon, ListIcon, ListXIcon, PlayIcon, TriangleAlertIcon, UserIcon, VideoIcon, VideoOffIcon, XIcon } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { StatusIcon } from '@/components/status-icon'
import { statusLabel } from '@/lib/status'
import { StepList } from '@/components/step-list'
import { stepMarks } from '@/lib/step-marks'
import { TestSource, type LineMark } from '@/components/test-source'
import { testDescription, testRange } from '@/lib/ht-source'
import { fileLink } from '@/lib/editor'
import { cn } from '@/lib/utils'
import { ErrorDetails } from '@/components/error-details'
import { BusinessLogic } from '@/components/business-logic'
import { errorHeading, formatDuration, formatWhen, friendlyFile, friendlyProblem, parseError, storage } from '@/lib/format'
import type { HumanTest, TestRow } from '@/lib/use-humantest'
import { CATEGORIES, testType, typeInfo } from '@/lib/test-type'

function TypeBadge({ test }: { test: TestRow }) {
  const { label, hint, category, icon: Icon } = typeInfo(testType(test))
  const group = CATEGORIES.find((c) => c.id === category)!
  const name = group.kinds.length > 1 ? `${group.label} · ${label}` : label
  return <Badge variant="secondary" className="gap-1" title={hint}><Icon className="size-3" />{name}</Badge>
}

export function TestDetail({ ht, test, roomy = false }: { ht: HumanTest; test: TestRow; roomy?: boolean }) {
  const file = ht.files.find((f) => f.file === test.file)
  const result = ht.history.last[test.key]
  const live = ht.live[test.key]
  const status = ht.statusOf(test)
  const done = result && !live
  const [view, setViewState] = useState<'steps' | 'source'>(() => (storage.get('ht.testView') === 'source' ? 'source' : 'steps'))
  const setView = (v: 'steps' | 'source') => { setViewState(v); storage.set('ht.testView', v) }

  const source = file?.source
  const description = useMemo(() => (source ? testDescription(source, test.line) : []), [source, test.line])
  const range = useMemo((): [number, number] | undefined => {
    if (!source || !file) return undefined
    const next = file.tests.map((t) => t.line).filter((l) => l > test.line).sort((a, b) => a - b)[0]
    return testRange(source, test.line, next)
  }, [source, file, test.line])
  // What to colour in the source: lines that need fixing, the step that failed, the step that's running.
  const lineMarks = useMemo(() => {
    const marks = new Map<number, LineMark>()
    for (const d of file?.diagnostics ?? []) marks.set(d.line, { tone: 'problem', note: d.message })
    stepMarks(test.steps, live ? undefined : result, live).forEach((m, i) => {
      const line = test.steps[i].line
      if (m.state === 'failed') marks.set(line, { tone: 'failed', note: m.error ? parseError(m.error).headline : 'This step failed' })
      else if (m.state === 'running') marks.set(line, { tone: 'running', note: 'Running now' })
    })
    return marks
  }, [file, test.steps, result, live])

  return (
    // Wider and a size larger while the test list is hidden; the width eases between the two.
    <div className={cn('mx-auto space-y-5 p-4 transition-[max-width] duration-300 ease-out sm:p-6', roomy ? 'detail-roomy max-w-[88rem]' : 'max-w-6xl')}>
      <div className="flex flex-wrap items-start gap-4">
        {/* Full width on phones, so the name isn't squeezed next to the buttons. */}
        <div className="min-w-0 basis-full sm:basis-0 sm:flex-1">
          <h1 className="text-xl leading-snug font-semibold">{test.name}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            {file?.path ? (
              <a href={fileLink(file.path, test.line)} className="inline-flex items-center gap-1 text-xs hover:text-foreground hover:underline" title={`${test.file}, line ${test.line}. Opens in VS Code`}><FileTextIcon className="size-3.5" />{friendlyFile(test.file)}</a>
            ) : (
              <span className="inline-flex items-center gap-1 text-xs" title={`${test.file}, line ${test.line}`}><FileTextIcon className="size-3.5" />{friendlyFile(test.file)}</span>
            )}
            <TypeBadge test={test} />
            {test.users.map((u) => <Badge key={u} variant="outline" className="gap-1"><UserIcon className="size-3" />{u}</Badge>)}
            {test.state && <Badge variant="secondary">Starts with {test.state}</Badge>}
          </div>
          {/* The comment written above the test, so what it's about doesn't need the file open. */}
          {description.length > 0 && (
            <div className="mt-3 max-w-3xl space-y-1.5 text-sm text-muted-foreground">
              {description.map((p, i) => <p key={i}>{p}</p>)}
            </div>
          )}
        </div>
        <Button disabled={ht.running || test.fileHasProblems} onClick={() => ht.run({ key: test.key })}>
          <PlayIcon /> Run test
        </Button>
      </div>

      {file && file.diagnostics.length > 0 && (
        <Alert className="border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <TriangleAlertIcon />
          <AlertTitle>Some lines need fixing before this test can run</AlertTitle>
          <AlertDescription className="text-amber-900 dark:text-amber-200">
            {file.diagnostics.map((d, i) => (
              <div key={i}>{friendlyProblem(d)}</div>
            ))}
          </AlertDescription>
        </Alert>
      )}

      <div className="flex items-center gap-2 font-medium" aria-live="polite">
        <StatusIcon status={status} />
        <span>{statusLabel(status)}</span>
        {done && (
          <span className="text-sm font-normal text-muted-foreground">
            {formatDuration(result.duration)} · {formatWhen(result.finishedAt)}
          </span>
        )}
      </div>

      {done && result.errors.length > 0 && (
        <section id="what-went-wrong" className="scroll-mt-4 overflow-hidden rounded-xl border border-red-200 bg-card shadow-sm dark:border-red-900/60">
          <div className="flex items-start gap-3 border-b border-red-200/70 bg-red-50/70 px-4 py-3 dark:border-red-900/50 dark:bg-red-950/30">
            <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-red-100 text-red-600 dark:bg-red-900/50 dark:text-red-400">
              <XIcon className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold text-red-700 dark:text-red-400">What went wrong</h2>
              {errorHeading(result.errors[0]) && <p className="text-sm text-muted-foreground">{errorHeading(result.errors[0])}</p>}
            </div>
            <Button size="sm" variant="ghost" className="shrink-0 text-muted-foreground"
              onClick={() => {
                if (view !== 'steps') setView('steps')
                requestAnimationFrame(() => document.getElementById('failed-step')?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
              }}
            >Show step ↓</Button>
          </div>
          <ErrorDetails error={result.errors[0]} className="px-4 py-4" />
        </section>
      )}

      {done && result.watchdog.length > 0 && (
        <Alert className="border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <TriangleAlertIcon />
          <AlertTitle>Other problems noticed during this test</AlertTitle>
          <AlertDescription className="text-amber-900 dark:text-amber-200">
            <ul className="list-disc pl-4">{result.watchdog.map((w, i) => <li key={i}>{w}</li>)}</ul>
          </AlertDescription>
        </Alert>
      )}

      {done && result.replay ? (
        <section className="space-y-2">
          <div className="flex items-baseline justify-between">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold"><VideoIcon className="size-4" /> Video</h2>
            <div className="flex gap-3 text-sm">
              {result.sideBySide && (
                <a className="inline-flex items-center gap-1 text-violet-700 hover:underline dark:text-violet-400" href={result.sideBySide} target="_blank" rel="noreferrer">
                  Side-by-side video <ExternalLinkIcon className="size-3.5" />
                </a>
              )}
            </div>
          </div>
          {/* key keeps the same iframe (and a playing video) across re-renders */}
          <iframe key={result.replay} src={`${result.replay}?embed`} title={`Replay of ${test.name}`} allowFullScreen className="h-[620px] w-full rounded-xl border bg-card" />
        </section>
      ) : done && (
        // A short note, not a big box: on a failed run the steps below matter more.
        <p className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
          <VideoOffIcon className="size-4 shrink-0" />
          <span className="flex-1">No video for this run. Run it again to record one.</span>
          <Button size="sm" variant="outline" disabled={ht.running || test.fileHasProblems} onClick={() => ht.run({ key: test.key })}>
            <PlayIcon /> Run again
          </Button>
        </p>
      )}

      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">{view === 'source' && range ? 'The test as written' : 'Steps'}</h2>
          {range && (
            <div className="flex items-center gap-3">
              {view === 'source' && file?.path && (
                <a href={fileLink(file.path, test.line)} className="inline-flex items-center gap-1 text-sm text-violet-700 hover:underline dark:text-violet-400">
                  Open in VS Code <ExternalLinkIcon className="size-3.5" />
                </a>
              )}
              <div role="group" aria-label="Show the test as" className="inline-flex rounded-lg border bg-muted/50 p-0.5">
                {([['steps', 'Steps', ListIcon], ['source', '.ht file', CodeIcon]] as const).map(([v, label, Icon]) => (
                  <button
                    key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}
                    className={cn('inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground',
                      view === v && 'bg-background text-foreground shadow-sm')}
                  >
                    <Icon className="size-3.5" />{label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        {view === 'source' && range && source ? (
          <TestSource source={source} path={file?.path} range={range} marks={lineMarks} />
        ) : test.steps.length ? (
          <StepList steps={test.steps} result={live ? undefined : result} live={live} errorLink={!!done && result.errors.length > 0} />
        ) : (
          <Empty className="rounded-xl border border-dashed py-8">
            <EmptyHeader>
              <EmptyMedia variant="icon"><ListXIcon /></EmptyMedia>
              <EmptyTitle>No steps yet</EmptyTitle>
              <EmptyDescription>
                {test.fileHasProblems ? 'Fix the lines above, and the steps show up here.' : 'This test has no steps yet.'}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </section>

      {ht.project && !live && (
        <BusinessLogic
          project={ht.project} testKey={test.key} version={ht.discovery.version} running={ht.discovery.running}
          change={ht.changes[test.key]} onAccept={() => ht.accept(test.key)}
        />
      )}
    </div>
  )
}
