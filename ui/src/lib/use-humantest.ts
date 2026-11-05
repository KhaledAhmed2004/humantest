import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  getProjects, getTests, startRun, stopRun, subscribe,
  type Diagnostic, type History, type Project, type RunScope, type ServerEvent, type TestFile, type TestInfo,
} from './api'
import { friendlyProblem, storage } from './format'

export interface LiveState { state: 'queued' | 'running'; steps: string[] }
export interface TestRow extends TestInfo { file: string; fileHasProblems: boolean }

const EMPTY_HISTORY: History = { last: {}, runs: [] }

/** Everything the UI needs: the project's tests, their results, and what's running right now. */
export function useHumanTest() {
  const [projects, setProjects] = useState<Project[]>([])
  const [project, setProject] = useState<string | null>(null)
  const [files, setFiles] = useState<TestFile[]>([])
  const [problems, setProblems] = useState<Diagnostic[]>([])
  const [history, setHistory] = useState<History>(EMPTY_HISTORY)
  const [live, setLive] = useState<Record<string, LiveState>>({})
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  // The project the latest request was for, so a slow answer for another project is ignored.
  const projectRef = useRef(project)

  const loadTests = useCallback(async (id: string) => {
    const r = await getTests(id)
    if (projectRef.current !== id) return
    setFiles(r.files ?? [])
    setProblems(r.problems ?? [])
    setHistory(r.history ?? EMPTY_HISTORY)
  }, [])

  // Projects, once.
  useEffect(() => {
    getProjects().then((r) => {
      setProjects(r.projects)
      const saved = storage.get('ht.project')
      setProject(r.projects.some((p) => p.id === saved) ? saved : r.projects[0]?.id ?? null)
      setRunning(!!r.running)
    }).catch(() => toast.error('HumanTest isn’t running. Start it again, then refresh this page.'))
  }, [])

  useEffect(() => {
    projectRef.current = project
    if (!project) return
    storage.set('ht.project', project)
    loadTests(project)
  }, [project, loadTests])

  const changeProject = useCallback((id: string) => {
    setLive({})
    setLogs([])
    setProject(id)
  }, [])

  // Live events.
  useEffect(() => subscribe((e: ServerEvent) => {
    switch (e.type) {
      case 'run-start':
        setRunning(true); setProgress(null); setLogs([])
        break
      case 'progress':
        setProgress({ done: e.done, total: e.total })
        break
      case 'test-begin':
        setLive((l) => ({ ...l, [e.key]: { state: 'running', steps: [] } }))
        break
      case 'step':
        setLive((l) => ({ ...l, [e.key]: { state: 'running', steps: [...(l[e.key]?.steps ?? []), e.step] } }))
        break
      case 'test-end':
        setLive((l) => { const { [e.key]: _, ...rest } = l; return rest })
        setHistory((h) => ({ ...h, last: { ...h.last, [e.key]: e.result } }))
        setProgress({ done: e.done, total: e.total })
        break
      case 'log':
        setLogs((l) => [...l.slice(-799), e.line])
        break
      case 'run-end':
        setRunning(false); setLive({}); setProgress(null)
        if (projectRef.current) loadTests(projectRef.current)
        break
      case 'tests-changed':
        // A .ht file was edited: re-read the list (and its "did you mean" problems) right away.
        if (e.project === projectRef.current) loadTests(e.project)
        break
    }
  }), [loadTests])

  const tests: TestRow[] = useMemo(
    () => files.flatMap((f) => f.tests.map((t) => ({ ...t, file: f.file, fileHasProblems: f.diagnostics.length > 0 }))),
    [files],
  )

  const statusOf = useCallback((t: TestRow): string => {
    if (t.fileHasProblems) return 'problem'
    if (live[t.key]) return live[t.key].state
    return history.last[t.key]?.status ?? 'never'
  }, [live, history])

  const run = useCallback(async (scope: RunScope, demo: boolean) => {
    if (!project) return
    const r = await startRun(project, scope, demo)
    if (r.error) {
      toast.error(r.error, {
        description: r.diagnostics?.slice(0, 5).map((d) => friendlyProblem(d, true)).join('\n'),
      })
      return
    }
    // Show what is about to run right away.
    setLive((l) => {
      const next = { ...l }
      for (const t of tests) {
        if (scope.key ? t.key === scope.key : scope.file ? t.file === scope.file : true) next[t.key] = { state: 'queued', steps: [] }
      }
      return next
    })
    setRunning(true)
  }, [project, tests])

  return {
    projects, project, setProject: changeProject, files, problems, history, tests, live, running, progress, logs,
    statusOf, run, stop: stopRun,
  }
}

export type HumanTest = ReturnType<typeof useHumanTest>
