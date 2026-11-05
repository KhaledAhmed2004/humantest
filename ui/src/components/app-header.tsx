import { MoonIcon, PlayIcon, SquareIcon, SunIcon, VideoIcon } from 'lucide-react'
import { useTheme } from 'next-themes'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { HumanTest } from '@/lib/use-humantest'

export function AppHeader({ ht, demo, onDemoChange }: { ht: HumanTest; demo: boolean; onDemoChange: (on: boolean) => void }) {
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

      <div className="flex-1" />

      <Badge variant={ht.running ? 'default' : 'secondary'} className={ht.running ? 'bg-violet-600 text-white dark:bg-violet-500' : ''} aria-live="polite">
        {ht.running ? (ht.progress ? `Running ${ht.progress.done}/${ht.progress.total}` : 'Starting…') : 'Idle'}
      </Badge>

      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-2">
            <Switch id="demo" checked={demo} onCheckedChange={onDemoChange} />
            <Label htmlFor="demo" className="flex cursor-pointer items-center gap-1.5 text-muted-foreground">
              <VideoIcon className="size-4" /> Record video
            </Label>
          </div>
        </TooltipTrigger>
        <TooltipContent>Runs slowly with captions, and makes a replay for each test</TooltipContent>
      </Tooltip>

      {ht.running ? (
        <Button variant="destructive" onClick={ht.stop}><SquareIcon /> Stop</Button>
      ) : (
        <Button onClick={() => ht.run({}, demo)} disabled={!ht.project}><PlayIcon /> Run all</Button>
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
