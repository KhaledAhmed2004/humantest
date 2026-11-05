export type Status = 'passed' | 'failed' | 'timedOut' | 'interrupted' | 'running' | 'queued' | 'never' | 'notrun' | 'problem' | 'skipped'

export const STATUS_LABEL: Record<Status, string> = {
  passed: 'Passed', failed: 'Failed', timedOut: 'Timed out', interrupted: 'Stopped', running: 'Running…',
  queued: 'Waiting to run', never: 'Not run yet', notrun: 'Not run', problem: 'Has problems', skipped: 'Skipped',
}

export const statusLabel = (s: string) => STATUS_LABEL[s as Status] ?? s

export const isFailure = (s: string) => s === 'failed' || s === 'timedOut' || s === 'interrupted'
