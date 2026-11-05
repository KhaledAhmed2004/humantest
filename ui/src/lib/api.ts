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

export interface StepResult { title: string; status: 'passed' | 'failed'; duration: number; error?: string }

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
