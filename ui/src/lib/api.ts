// Types and calls for the HumanTest server (src/ui/server.mts).

export interface Diagnostic { file: string; line: number; text: string; message: string; hint?: string }

export interface PlannedStep { line: number; user: string; text: string; story?: string; title: string }

export interface TestInfo {
  key: string
  name: string
  line: number
  users: string[]
  state?: string
  /** Written `Draft:`: listed, not run until it says `Test:`. */
  draft?: boolean
  steps: PlannedStep[]
}

/** `source` is the .ht text, `path` where the file is on disk. */
export interface TestFile { file: string; spec: string; path?: string; source?: string; diagnostics: Diagnostic[]; tests: TestInfo[] }

/** An API call a step caused. Only the names of query and body fields are kept, never their values. */
export interface StepCall { method: string; path: string; query: string[]; bodyKeys: string[]; status?: number; simulated?: boolean; pageUrl?: string }

export interface StepResult { title: string; status: 'passed' | 'failed'; duration: number; error?: string; calls?: StepCall[] }

export interface TestResult {
  key: string
  status: string
  duration: number
  errors: string[]
  watchdog: string[]
  replay?: string
  sideBySide?: string
  steps: StepResult[]
  finishedAt: string
  demo: boolean
}

export interface History {
  last: Record<string, TestResult>
  runs: { at: string; demo: boolean; results: Record<string, string> }[]
}

export interface Project { id: string; name: string }

/** One business rule, grouped and written out by src/discovery/rules/present.mts. */
export interface RuleLine {
  text: string
  source: { file: string; line: number }
  translated: boolean
  messages: string[]
  status?: number
  ids: string[]
  checked?: boolean
  /** How the test checks it: it sees the message, or it checks the status the request answered. */
  checkedBy?: 'message' | 'status'
  /** Other tests that check it, when this test doesn't (added by the server from their last runs). */
  checkedElsewhere?: string[]
  /** A draft test that would check it, when it isn't checked and has a message to look for. */
  draft?: string
}
export interface RuleGroup { title: string; lines: RuleLine[] }
export type DiscoveredCall =
  | { request: string; route: { method: string; path: string; file: string; line: number }; groups: RuleGroup[] }
  | { request: string; problem: string }
/** What the page's own code does for a click step. */
export interface PageRules { label: string; page: string; element: { file: string; line: number; tag: string }; component: string; groups: RuleGroup[] }
export interface DiscoveryResult {
  test: string
  source: string
  codeRoot?: string
  frontRoot?: string
  /** The backend and frontend folders on this computer (forward slashes), to open a rule in the editor. */
  codeDir?: string
  frontDir?: string
  steps: { title: string; line: number; text: string; calls: DiscoveredCall[]; page?: PageRules }[]
}
export interface DiscoveryResponse { configured: boolean; running?: boolean; at?: string; result?: DiscoveryResult }

/** What changed in a test's business logic since it was accepted (src/discovery/baseline.mts). */
export interface RuleChange { change: 'added' | 'removed' | 'changed'; before?: string; after?: string; source: { file: string; line: number } }
export interface FunctionChange { change: 'added' | 'removed' | 'changed'; name: string; file: string; line: number; lastCommit?: string }
export interface RequestChange { request: string; change: 'added' | 'removed' | 'changed' | 'same'; problem?: string; ruleCount?: number; functions: FunctionChange[]; rules: RuleChange[] }
export interface TestChange { key: string; test: string; source: string; acceptedAt?: string; status: 'same' | 'changed' | 'code-only' | 'new' | 'gone'; requests: RequestChange[] }
export interface ChangesResponse { computing: boolean; at?: string; tests: TestChange[]; error?: string }

/** What the tests cover (src/discovery/gaps.mts): per part of the app, and each rule no test checks. */
export interface GapLine extends RuleLine { group: string; draft?: string }
export interface GapRequest {
  request: string
  area: string
  /** What it does, from its handler's name: "Create route". */
  title?: string
  root: string
  reachedBy: { test: string; file: string; testLine: number; stepLine: number }[]
  lines: GapLine[]
}
export interface GapArea { name: string; requests: number; reached: number; rules: number; reachedRules: number; checked: number }
export interface GapReport { areas: GapArea[]; reached: GapRequest[]; unreached: { request: string; area: string; title?: string; root: string; rules: number; lines: GapLine[] }[] }
export interface CoverageResponse { computing: boolean; at?: string; report?: GapReport; error?: string }

export async function getCoverage(project: string): Promise<CoverageResponse> {
  const r = await fetch(`/api/coverage?project=${encodeURIComponent(project)}`)
  // A server started before this page was built doesn't know the request.
  if (r.status === 404) return { computing: false, error: 'The HumanTest server running now is older than this page. Stop it (Ctrl+C) and run "npm run ui" again.' }
  return r.json()
}

/** Saves a draft test as a new .ht file in the tests folder. */
export async function saveDraft(project: string, text: string): Promise<{ file?: string; path?: string; diagnostics?: Diagnostic[]; error?: string }> {
  const r = await fetch('/api/draft', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project, text }) })
  return r.json()
}

export async function getChanges(project: string): Promise<ChangesResponse> {
  return (await fetch(`/api/changes?project=${encodeURIComponent(project)}`)).json()
}

export async function acceptChanges(project: string, key?: string): Promise<{ ok?: boolean; error?: string }> {
  const r = await fetch('/api/accept', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project, key }) })
  return r.json()
}

export async function getDiscovery(project: string, key: string): Promise<DiscoveryResponse> {
  return (await fetch(`/api/discovery?project=${encodeURIComponent(project)}&key=${encodeURIComponent(key)}`)).json()
}

export interface TestsResponse { files: TestFile[]; problems: Diagnostic[]; history: History; roles?: string[] }

export type ServerEvent =
  | { type: 'run-start'; project: string; demo: boolean; scope: string }
  | { type: 'progress'; done: number; total: number }
  | { type: 'test-begin'; key: string }
  | { type: 'step'; key: string; step: string }
  | { type: 'test-end'; key: string; result: TestResult; done: number; total: number }
  | { type: 'log'; line: string }
  | { type: 'run-end'; code: number | null; startFailed?: boolean }
  | { type: 'tests-changed'; project: string }
  | { type: 'discovery'; project: string; state: 'running' | 'done' }
  | { type: 'changes'; project: string }
  | { type: 'coverage'; project: string }

export async function getProjects(): Promise<{ projects: Project[]; running: { project: string; done: number; total: number } | null }> {
  return (await fetch('/api/projects')).json()
}

export async function getTests(project: string): Promise<TestsResponse> {
  return (await fetch(`/api/tests?project=${encodeURIComponent(project)}`)).json()
}

export type RunScope = { key?: string; file?: string; keys?: string[] }

export async function startRun(project: string, scope: RunScope, demo: boolean): Promise<{ ok?: true; error?: string; diagnostics?: Diagnostic[] }> {
  const res = await fetch('/api/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project, demo, ...scope }),
  })
  return res.json()
}

export async function stopRun() {
  await fetch('/api/stop', { method: 'POST' })
}

/** Live events from the server while tests run. */
export function subscribe(onEvent: (e: ServerEvent) => void): () => void {
  const es = new EventSource('/api/events')
  es.onmessage = (m) => onEvent(JSON.parse(m.data) as ServerEvent)
  return () => es.close()
}
