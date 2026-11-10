import type { PlannedStep, TestInfo } from '@/lib/api'

/**
 * How a happy-path test is read, the way the industry splits them:
 * - its scope: one part of the app (a feature flow) or a story across several (a full user journey);
 * - what it checks: the page, the server's answer, data kept after a reload, an email (a side effect);
 * - who does it, with what data, and from what starting state.
 * All worked out from the steps, so nobody labels a test.
 */

export type Check = 'page' | 'server' | 'reload' | 'email'
export const CHECKS: { id: Check; label: string; hint: string; example: string }[] = [
  { id: 'page', label: 'Page', hint: 'The page shows the result', example: 'should see "Route created successfully"' },
  { id: 'server', label: 'Server', hint: 'The server answers that it worked', example: 'backend should reply 201 Created' },
  { id: 'reload', label: 'Reload', hint: 'After a reload, what was saved is still there', example: 'reload the page, then should see "Sea Star"' },
  { id: 'email', label: 'Email', hint: 'Something happens beyond the page: an email is sent', example: 'Rahim should get an email "Booking confirmed"' },
]

/** Data set-up through the API (`call …`, `remember …`, clean-up): not something a user does on the page. */
const SETUP = /^(call [a-z]+ \/|remember |at the end,|when the test ends,|backend should reply)/

const lower = (s: PlannedStep) => s.text.trim().toLowerCase()
/** A step that sets data up through the API (alone or from a `Given …` sentence), not on the page. */
const isSetup = (s: PlannedStep) => SETUP.test(lower(s))

/** API path segments that say who calls, not what part of the app: /api/v1/operator/schedules is schedules. */
const NOT_A_PART = new Set(['api', 'admin', 'operator', 'me', 'dashboard', 'public', 'private'])
const VERSION = /^v\d+$/

/** The part of the app a path belongs to: /api/v1/operator/schedules/:id → schedules. */
function partOfPath(path: string): string | undefined {
  const segs = path.split('?')[0].split('/').filter(Boolean).map((x) => x.toLowerCase())
  return segs.find((x) => !NOT_A_PART.has(x) && !VERSION.test(x) && !x.startsWith(':') && !x.startsWith('{'))
}

const RECEIVE = /^backend should receive ([a-z]+) (\S+)/
const PAGE = /^go to (?:the )?(.+?) page$/
const GOTO = /^go to "([^"]+)"/

/** What the test asks the server to do, in the order the user does it (set-up left out). */
function requests(steps: PlannedStep[]): { method: string; path: string }[] {
  return steps.flatMap((s) => {
    const m = RECEIVE.exec(lower(s))
    return m ? [{ method: m[1].toUpperCase(), path: m[2] }] : []
  })
}

/** The parts of the app the user goes through: from what the page sends, else from the pages visited. */
export function parts(steps: PlannedStep[]): string[] {
  const fromRequests = requests(steps).map((r) => partOfPath(r.path))
  const found = fromRequests.filter(Boolean) as string[]
  if (found.length) return [...new Set(found)]
  const fromPages = steps.filter((s) => !isSetup(s)).map((s) => {
    const t = lower(s)
    const page = PAGE.exec(t)?.[1]
    if (page) return page.split(' ')[0]
    const url = GOTO.exec(s.text.trim())?.[1]
    return url ? partOfPath(url) : undefined
  })
  return [...new Set(fromPages.filter(Boolean) as string[])]
}

const PART_NAMES: Record<string, string> = { auth: 'Login & sign-up', users: 'Users', fleet: 'Ferries' }
export const partLabel = (p: string) => PART_NAMES[p] ?? p.charAt(0).toUpperCase() + p.slice(1)

/** The users who do something on the page, not only set data up for the test. */
export function actors(steps: PlannedStep[]): string[] {
  return [...new Set(steps.filter((s) => !isSetup(s)).map((s) => s.user))]
}

export function checks(steps: PlannedStep[]): Set<Check> {
  const texts = steps.filter((s) => !s.story || !isSetup(s)).map(lower)
  const has = (re: RegExp) => texts.some((t) => re.test(t))
  const out = new Set<Check>()
  if (has(/(^|, )should (still )?(see|not see|be on)|dialog should be|should be (visible|enabled|checked)/)) out.add('page')
  // A 2xx the user's own step got, not one a set-up sentence got.
  if (steps.some((s, i) => /^backend should reply 2\d\d/.test(lower(s)) && !s.story && !/^call /.test(lower(steps[i - 1] ?? s)))) out.add('server')
  if (has(/^(reload|refresh)/)) out.add('reload')
  if (has(/should (not )?get an email|^the email should/)) out.add('email')
  return out
}

/** Where the test starts from, the "state" a tester names. */
export function startState(test: Pick<TestInfo, 'steps' | 'state'>): string {
  if (test.state) return `Start with: ${test.state}`
  if (test.steps.some((s) => s.story && isSetup(s))) return 'Data made by the test'
  if (test.steps.some((s) => s.user.startsWith('new '))) return 'A new user'
  return 'Data already there'
}

/** What a happy test sends first that changes something: two tests sending it are two sets of data. */
export function mainRequest(steps: PlannedStep[]): string | undefined {
  const r = requests(steps).find((x) => x.method !== 'GET')
  return r && `${r.method} ${r.path.replace(/\{[^}]+\}|\/\d+(?=\/|$)/g, ':id')}`
}

/** Crosses three parts of the app, or two with two people: a story, not one feature's flow. */
export function isJourney(steps: PlannedStep[]): boolean {
  const p = parts(steps).length
  return p >= 3 || (p >= 2 && actors(steps).length >= 2)
}
