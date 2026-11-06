// Types and calls for the HumanTest server (src/ui/server.mts).

export interface Diagnostic { file: string; line: number; text: string; message: string; hint?: string }

export interface PlannedStep { line: number; user: string; text: string; story?: string; title: string }

export interface TestInfo {
  key: string
  name: string
  line: number
  users: string[]
  state?: string
  steps: PlannedStep[]
}

export interface TestFile { file: string; spec: string; diagnostics: Diagnostic[]; tests: TestInfo[] }

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
}
export interface RuleGroup { title: string; lines: RuleLine[] }
export type DiscoveredCall =
  | { request: string; route: { method: string; path: string; file: string; line: number }; groups: RuleGroup[] }
  | { request: string; problem: string }
export interface DiscoveryResult { test: string; source: string; codeRoot?: string; steps: { title: string; line: number; text: string; calls: DiscoveredCall[] }[] }
export interface DiscoveryResponse { configured: boolean; running?: boolean; at?: string; result?: DiscoveryResult }

/** What changed in a test's business logic since it was accepted (src/discovery/baseline.mts). */
export interface RuleChange { change: 'added' | 'removed' | 'changed'; before?: string; after?: string; source: { file: string; line: number } }
export interface FunctionChange { change: 'added' | 'removed' | 'changed'; name: string; file: string; line: number; lastCommit?: string }
export interface RequestChange { request: string; change: 'added' | 'removed' | 'changed' | 'same'; problem?: string; ruleCount?: number; functions: FunctionChange[]; rules: RuleChange[] }
export interface TestChange { key: string; test: string; source: string; acceptedAt?: string; status: 'same' | 'changed' | 'code-only' | 'new'; requests: RequestChange[] }
export interface ChangesResponse { computing: boolean; at?: string; tests: TestChange[]; error?: string }

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

export interface TestsResponse { files: TestFile[]; problems: Diagnostic[]; history: History }

export type ServerEvent =
  | { type: 'run-start'; project: string; demo: boolean; scope: string }
  | { type: 'progress'; done: number; total: number }
  | { type: 'test-begin'; key: string }
  | { type: 'step'; key: string; step: string }
  | { type: 'test-end'; key: string; result: TestResult; done: number; total: number }
  | { type: 'log'; line: string }
  | { type: 'run-end'; code: number | null }
  | { type: 'tests-changed'; project: string }
  | { type: 'discovery'; project: string; state: 'running' | 'done' }
  | { type: 'changes'; project: string }

export async function getProjects(): Promise<{ projects: Project[]; running: { project: string; done: number; total: number } | null }> {
  return (await fetch('/api/projects')).json()
}

export async function getTests(project: string): Promise<TestsResponse> {
  return (await fetch(`/api/tests?project=${encodeURIComponent(project)}`)).json()
}

export type RunScope = { key?: string; file?: string }

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
