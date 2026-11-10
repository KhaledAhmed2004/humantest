import { Fragment } from 'react'
import { fileLink } from '@/lib/editor'
import { cn } from '@/lib/utils'

/** A light touch of colour: comments faded, quoted text and {values} stand out, block headers bold. */
function Highlighted({ text }: { text: string }) {
  const hash = (() => {
    let quoted = false
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '"') quoted = !quoted
      else if (text[i] === '#' && !quoted) return i
    }
    return -1
  })()
  const code = hash >= 0 ? text.slice(0, hash) : text
  const comment = hash >= 0 ? text.slice(hash) : ''
  const parts = code.split(/("[^"]*"|\{[^}]*\})/)
  const header = /:\s*$/.test(code)
  return (
    <>
      <span className={cn(header && 'font-semibold text-foreground')}>
        {parts.map((p, i) => (
          <Fragment key={i}>
            {p.startsWith('"') ? <span className="text-emerald-700 dark:text-emerald-400">{p}</span>
              : p.startsWith('{') ? <span className="text-violet-700 dark:text-violet-400">{p}</span>
              : p}
          </Fragment>
        ))}
      </span>
      {comment && <span className="text-muted-foreground italic">{comment}</span>}
    </>
  )
}

export interface LineMark { tone: 'failed' | 'running' | 'problem'; note?: string }

/** One test's .ht lines with line numbers. A line number opens that line in VS Code when the file's path is known. */
export function TestSource({ source, path, range, marks }: {
  source: string
  path?: string
  range: [number, number]
  marks: Map<number, LineMark>
}) {
  const lines = source.split(/\r?\n/).slice(range[0] - 1, range[1])
  return (
    <div className="overflow-x-auto rounded-xl border bg-card py-2">
      <pre className="min-w-fit font-mono text-xs leading-6">
        {lines.map((text, i) => {
          const n = range[0] + i
          const mark = marks.get(n)
          return (
            <div
              key={n}
              title={mark?.note}
              className={cn(
                'grid grid-cols-[3.5rem_1fr] pr-4',
                mark?.tone === 'failed' && 'bg-red-50 dark:bg-red-950/40',
                mark?.tone === 'running' && 'bg-violet-50 dark:bg-violet-950/40',
                mark?.tone === 'problem' && 'bg-amber-50 dark:bg-amber-950/40',
              )}
            >
              {path ? (
                <a href={fileLink(path, n)} title="Open this line in VS Code" className="pr-4 text-right text-muted-foreground/70 tabular-nums select-none hover:text-foreground hover:underline">{n}</a>
              ) : (
                <span className="pr-4 text-right text-muted-foreground/70 tabular-nums select-none">{n}</span>
              )}
              <span className="whitespace-pre text-foreground/85"><Highlighted text={text} /></span>
            </div>
          )
        })}
      </pre>
    </div>
  )
}
