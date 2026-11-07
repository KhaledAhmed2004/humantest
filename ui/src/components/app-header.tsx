import { MoonIcon, PlayIcon, SquareIcon, SunIcon, VideoIcon } from 'lucide-react'
import { useTheme } from 'next-themes'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { HumanTest } from '@/lib/use-humantest'
import { cn } from '@/lib/utils'

export type View = 'tests' | 'logic' | 'coverage'
const VIEW_LABEL: Record<View, string> = { tests: 'Tests', logic: 'Business logic', coverage: 'Coverage' }

export function AppHeader({ ht, demo, onDemoChange, view, onViewChange }: {
  ht: HumanTest; demo: boolean; onDemoChange: (on: boolean) => void; view: View; onViewChange: (v: View) => void
}) {
  const { resolvedTheme, setTheme } = useTheme()

  return (
    <header className="flex flex-wrap items-center gap-3 border-b bg-background px-4 py-2.5">
      <div className="mr-2 text-base font-semibold tracking-tight">
        Human<span className="text-violet-600 dark:text-violet-400">Test</span>
      </div>

      <Select value={ht.project ?? undefined} onValueChange={ht.setProject} disabled={ht.running}>
        <SelectTrigger className="w-56" aria-label="Project">
          <SelectValue placeholder="Choose a project" />
        </SelectTrigger>
        <SelectContent>
          {ht.projects.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
        </SelectContent>
      </Select>

      {/* Tests, or what they cover. */}
      <nav aria-label="View" className="flex rounded-lg bg-muted p-0.5">
        {(['tests', 'logic', 'coverage'] as const).map((v) => (
          <button key={v} type="button" onClick={() => onViewChange(v)} aria-current={view === v ? 'page' : undefined}
            className={cn('rounded-md px-3 py-1 text-sm font-medium text-foreground/70 transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
              view === v && 'bg-background text-foreground shadow-sm')}>
            {VIEW_LABEL[v]}
          </button>
        ))}
      </nav>

      <div className="flex-1" />

      {/* Only shown while tests run; nothing to say otherwise. */}
      <span aria-live="polite">
        {ht.running && (
          <Badge className="bg-violet-600 text-white dark:bg-violet-500">
            {ht.progress
              ? `Running test ${Math.min(ht.progress.done + 1, ht.progress.total)} of ${ht.progress.total}`
              : 'Getting ready…'}
          </Badge>
        )}
      </span>

      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-2">
            <Switch id="demo" checked={demo} onCheckedChange={onDemoChange} />
            <Label htmlFor="demo" className="flex cursor-pointer items-center gap-1.5 text-muted-foreground">
              <VideoIcon className="size-4" /> Record video
            </Label>
          </div>
        </TooltipTrigger>
        <TooltipContent>Runs a little slower and records a video of each test</TooltipContent>
      </Tooltip>

      {ht.running ? (
        <Button variant="destructive" onClick={ht.stop}><SquareIcon /> Stop</Button>
      ) : (
        <Button onClick={() => ht.run({}, demo)} disabled={!ht.project}><PlayIcon /> Run all tests</Button>
      )}

      <Button
        variant="ghost"
        size="icon"
        aria-label={resolvedTheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
      >
        {resolvedTheme === 'dark' ? <SunIcon /> : <MoonIcon />}
      </Button>
    </header>
  )
}
