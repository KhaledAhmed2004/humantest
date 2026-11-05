export type Status = 'passed' | 'failed' | 'timedOut' | 'interrupted' | 'running' | 'queued' | 'never' | 'notrun' | 'problem' | 'skipped'

export const STATUS_LABEL: Record<Status, string> = {
  passed: 'Passed', failed: 'Failed', timedOut: 'Took too long', interrupted: 'Stopped', running: 'Running…',
  queued: 'Waiting to run', never: 'Not run yet', notrun: 'Not run', problem: 'Needs fixing', skipped: 'Skipped',
}

export const statusLabel = (s: string) => STATUS_LABEL[s as Status] ?? s

export const isFailure = (s: string) => s === 'failed' || s === 'timedOut' || s === 'interrupted'
