export const formatDuration = (ms?: number) =>
  ms == null ? '' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`

export const formatWhen = (iso?: string) =>
  iso ? new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''

/**
 * A HumanTest error without the parts the UI already shows around it:
 * the "Line N · user · step" heading, the "What went wrong:" label and the file link.
 */
export const cleanError = (e: string) => {
  const lines = e.replace(/^Error:\s*/, '').split('\n')
  // "Where the problem is" and its reason are shown as a badge (ProblemWhere), not in the text.
  const where = lines.findIndex((l) => /^\s*Where the problem is:/.test(l))
  if (where >= 0) lines.splice(where, 2)
  return lines
    .filter((l) => l.trim() && !/^\s*(Line \d+ ·|📄|What went wrong:)/.test(l))
    .map((l) => l.trim())
    .join('\n')
}

export interface ErrorRequest { method: string; path: string; status: string; code: number }
export interface ErrorParts { headline: string; shows: string[]; notes: string[]; requests: ErrorRequest[] }

/** A HumanTest error split into its parts: the headline, what the page showed, other notes and the recent requests. */
export const parseError = (e: string): ErrorParts => {
  const lines = cleanError(e).split('\n').filter(Boolean)
  const out: ErrorParts = { headline: lines[0] ?? '', shows: [], notes: [], requests: [] }
  let inRequests = false
  for (const l of lines.slice(1)) {
    const shows = l.match(/^Instead, the page shows:\s*(.*)$/)
    if (shows) { out.shows = shows[1].match(/"[^"]*"/g)?.map((q) => q.slice(1, -1)) ?? [shows[1]]; inRequests = false; continue }
    if (/^Latest backend activity:?$/.test(l)) { inRequests = true; continue }
    const req = inRequests && l.match(/^([A-Z]+)\s+(\S+)\s+→\s+(.+)$/)
    if (req) { out.requests.push({ method: req[1], path: req[2], status: req[3], code: parseInt(req[3], 10) || 0 }); continue }
    inRequests = false
    out.notes.push(l)
  }
  return out
}

export type ProblemPart ='frontend' | 'backend' | 'setup' | 'test'

/** Which side a failure is on, from the runtime's "Where the problem is: 🖥️ Frontend (the page)" line. */
export const problemWhere = (e: string): { part: ProblemPart; label: string; why: string } | undefined => {
  const lines = e.split('\n')
  const i = lines.findIndex((l) => /^\s*Where the problem is:/.test(l))
  if (i < 0) return undefined
  const label = lines[i].trim().replace(/^Where the problem is:\s*/, '')
  const part: ProblemPart = /Frontend/.test(label) ? 'frontend' : /Backend/.test(label) ? 'backend' : /setup/i.test(label) ? 'setup' : 'test'
  return { part, label, why: lines[i + 1]?.trim() ?? '' }
}

/** The "Line N · user · step" heading of a HumanTest error, if it has one. */
export const errorHeading = (e: string) => e.replace(/^Error:\s*/, '').match(/^Line \d+ · .*/m)?.[0]

/** A test file as people name it: "e2e/tests/tooth-issues.ht" → "Tooth issues". */
export const friendlyFile = (file: string) => {
  const base = file.split(/[\\/]/).pop()!.replace(/\.ht$/, '').replace(/[-_]+/g, ' ').trim()
  return base.charAt(0).toUpperCase() + base.slice(1)
}

/** A problem in a .ht file, without paths: "Line 2: I don't understand this line. Did you mean: …" */
export const friendlyProblem = (d: { file: string; line: number; message: string; hint?: string }, withFile = false) =>
  `${withFile ? `${friendlyFile(d.file)}, line` : 'Line'} ${d.line}: ${d.message}${d.hint ? ` ${d.hint}` : ''}`

/** localStorage that never throws (private windows, blocked storage). */
export const storage = {
  get(key: string): string | null {
    try { return localStorage.getItem(key) } catch { return null }
  },
  set(key: string, value: string) {
    try { localStorage.setItem(key, value) } catch { /* not available */ }
  },
}
