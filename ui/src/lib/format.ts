export const formatDuration = (ms?: number) =>
  ms == null ? '' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`

export const formatWhen = (iso?: string) =>
  iso ? new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''

/**
 * A HumanTest error without the parts the UI already shows around it:
 * the "Line N · user · step" heading, the "What went wrong:" label and the file link.
 */
export const cleanError = (e: string) =>
  e.replace(/^Error:\s*/, '')
    .split('\n')
    .filter((l) => l.trim() && !/^\s*(Line \d+ ·|📄|What went wrong:)/.test(l))
    .map((l) => l.trim())
    .join('\n')

/** The "Line N · user · step" heading of a HumanTest error, if it has one. */
export const errorHeading = (e: string) => e.replace(/^Error:\s*/, '').match(/^Line \d+ · .*/m)?.[0]

/** localStorage that never throws (private windows, blocked storage). */
export const storage = {
  get(key: string): string | null {
    try { return localStorage.getItem(key) } catch { return null }
  },
  set(key: string, value: string) {
    try { localStorage.setItem(key, value) } catch { /* not available */ }
  },
}
