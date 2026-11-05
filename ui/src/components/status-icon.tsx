import { CircleAlertIcon, CircleCheckIcon, CircleDashedIcon, CircleXIcon, LoaderCircleIcon, MinusCircleIcon } from 'lucide-react'
import { isFailure, statusLabel } from '@/lib/status'
import { cn } from '@/lib/utils'

/** One icon per status, each with its own shape, so status never depends on color alone. */
export function StatusIcon({ status, className }: { status: string; className?: string }) {
  const cls = cn('size-4 shrink-0', className)
  const label = statusLabel(status)
  if (status === 'passed') return <CircleCheckIcon aria-label={label} className={cn(cls, 'text-emerald-600 dark:text-emerald-400')} />
  if (isFailure(status)) return <CircleXIcon aria-label={label} className={cn(cls, 'text-red-600 dark:text-red-400')} />
  if (status === 'running') return <LoaderCircleIcon aria-label={label} className={cn(cls, 'animate-spin text-violet-600 dark:text-violet-400')} />
  if (status === 'problem') return <CircleAlertIcon aria-label={label} className={cn(cls, 'text-amber-600 dark:text-amber-400')} />
  if (status === 'skipped') return <MinusCircleIcon aria-label={label} className={cn(cls, 'text-muted-foreground')} />
  return <CircleDashedIcon aria-label={label} className={cn(cls, 'text-muted-foreground/70')} />
}
