import { ExternalLinkIcon, FileTextIcon, PlayIcon, TriangleAlertIcon, UserIcon, VideoIcon, VideoOffIcon } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { StatusIcon } from '@/components/status-icon'
import { statusLabel } from '@/lib/status'
import { StepList } from '@/components/step-list'
import { formatDuration, formatWhen } from '@/lib/format'
import type { HumanTest, TestRow } from '@/lib/use-humantest'

export function TestDetail({ ht, test }: { ht: HumanTest; test: TestRow }) {
  const file = ht.files.find((f) => f.file === test.file)
  const result = ht.history.last[test.key]
  const live = ht.live[test.key]
  const status = ht.statusOf(test)
  const done = result && !live

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-6">
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl leading-snug font-semibold">{test.name}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1 font-mono text-xs"><FileTextIcon className="size-3.5" />{test.file}:{test.line}</span>
            {test.users.map((u) => <Badge key={u} variant="outline" className="gap-1"><UserIcon className="size-3" />{u}</Badge>)}
            {test.state && <Badge variant="secondary">starts with: {test.state}</Badge>}
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
          <AlertTitle>This file has problems, so it can't run yet</AlertTitle>
          <AlertDescription className="text-amber-900 dark:text-amber-200">
            {file.diagnostics.map((d, i) => (
              <div key={i}><code className="font-mono text-xs">{d.file}:{d.line}</code> {d.message}{d.hint && <> 💡 {d.hint}</>}</div>
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
            <pre className="font-mono text-xs whitespace-pre-wrap">{result.errors[0].replace(/^Error:\s*/, '')}</pre>
          </AlertDescription>
        </Alert>
      )}

      {done && result.watchdog.length > 0 && (
        <Alert className="border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <TriangleAlertIcon />
          <AlertTitle>The watchdog noticed hidden problems</AlertTitle>
          <AlertDescription className="text-amber-900 dark:text-amber-200">
            <ul className="list-disc pl-4">{result.watchdog.map((w, i) => <li key={i}>{w}</li>)}</ul>
          </AlertDescription>
        </Alert>
      )}

      {done && result.replay ? (
        <section className="space-y-2">
          <div className="flex items-baseline justify-between">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold"><VideoIcon className="size-4" /> Replay</h2>
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
          <iframe key={result.replay} src={`${result.replay}?embed`} title={`Replay of ${test.name}`} className="h-[620px] w-full rounded-xl border bg-card" />
        </section>
      ) : !live && (
        <Empty className="rounded-xl border border-dashed py-8">
          <EmptyHeader>
            <EmptyMedia variant="icon"><VideoOffIcon /></EmptyMedia>
            <EmptyTitle>No video for the last run</EmptyTitle>
            <EmptyDescription>Click “Run with video” to record one, with every step captioned.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Steps</h2>
        <StepList steps={test.steps} result={live ? undefined : result} live={live} />
      </section>
    </div>
  )
}
