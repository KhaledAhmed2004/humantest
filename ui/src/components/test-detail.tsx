import { ExternalLinkIcon, FileTextIcon, ListXIcon, PlayIcon, TriangleAlertIcon, UserIcon, VideoIcon, VideoOffIcon } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { StatusIcon } from '@/components/status-icon'
import { statusLabel } from '@/lib/status'
import { StepList } from '@/components/step-list'
import { BusinessLogic } from '@/components/business-logic'
import { cleanError, errorHeading, formatDuration, formatWhen, friendlyFile, friendlyProblem } from '@/lib/format'
import type { HumanTest, TestRow } from '@/lib/use-humantest'

export function TestDetail({ ht, test }: { ht: HumanTest; test: TestRow }) {
  const file = ht.files.find((f) => f.file === test.file)
  const result = ht.history.last[test.key]
  const live = ht.live[test.key]
  const status = ht.statusOf(test)
  const done = result && !live

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-start gap-4">
        {/* Full width on phones, so the name isn't squeezed next to the buttons. */}
        <div className="min-w-0 basis-full sm:basis-0 sm:flex-1">
          <h1 className="text-xl leading-snug font-semibold">{test.name}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1 text-xs" title={`${test.file}, line ${test.line}`}><FileTextIcon className="size-3.5" />{friendlyFile(test.file)}</span>
            {test.users.map((u) => <Badge key={u} variant="outline" className="gap-1"><UserIcon className="size-3" />{u}</Badge>)}
            {test.state && <Badge variant="secondary">Starts with {test.state}</Badge>}
          </div>
        </div>
        <div className="flex gap-2">
          <Button disabled={ht.running || test.fileHasProblems} onClick={() => ht.run({ key: test.key }, false)}>
            <PlayIcon /> Run
          </Button>
          <Button variant="outline" disabled={ht.running || test.fileHasProblems} onClick={() => ht.run({ key: test.key }, true)}>
            <VideoIcon /> Run with video
          </Button>
        </div>
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
            {formatDuration(result.duration)} · {formatWhen(result.finishedAt)}{result.demo && ' · with video'}
          </span>
        )}
      </div>

      {done && result.errors.length > 0 && (
        <Alert variant="destructive">
          <AlertTitle>What went wrong</AlertTitle>
          <AlertDescription>
            {errorHeading(result.errors[0]) && <p className="font-medium">{errorHeading(result.errors[0])}</p>}
            <pre className="font-mono text-xs whitespace-pre-wrap">{cleanError(result.errors[0])}</pre>
          </AlertDescription>
        </Alert>
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
              <a className="inline-flex items-center gap-1 text-violet-700 hover:underline dark:text-violet-400" href={result.replay} target="_blank" rel="noreferrer">
                Open in a new tab <ExternalLinkIcon className="size-3.5" />
              </a>
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
          No video for this run. Use “Run with video” to record one.
        </p>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Steps</h2>
        {test.steps.length ? (
          <StepList steps={test.steps} result={live ? undefined : result} live={live} />
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
