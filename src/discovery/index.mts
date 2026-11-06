// Business logic discovery: from what a test did (its trace) to the app code that ran.
// Phase 2 of docs/DISCOVERY-PLAN.md: find the code. Nothing is translated or judged here yet.

import fs from 'node:fs';
import path from 'node:path';
import type { Project } from '../compiler/project.mts';
import { buildRouteTable, matchRoute, type RouteTable } from './backend/express.mts';
import { sliceRoute, type Slice } from './backend/slice.mts';
import { extractRules, type Rule } from './rules/index.mts';
import { markChecked, present, type Group } from './rules/present.mts';
import { openTsProject, type TsProject } from './ts-project.mts';
import { matchStep } from '../compiler/steps.mts';
import { check } from '../compiler/index.mts';
import { actionRules } from './frontend/actions.mts';
import { pageFor, type Frontend } from './frontend/next.mts';
export { openFrontend, type Frontend } from './frontend/next.mts';

export interface Backend { ts: TsProject; table: RouteTable }

export function openBackend(project: Project): Backend {
  const dir = project.config.source?.backend;
  if (!dir) throw new Error('No "source.backend" in humantest.config.json: HumanTest needs to know where the backend code is.');
  const p = openTsProject(path.resolve(project.root, dir));
  return { ts: p, table: buildRouteTable(p) };
}

export type Located =
  | { request: string; slice: Slice; params: Record<string, string> }
  | { request: string; problem: string };

export function locate(backend: Backend, method: string, pathname: string): Located {
  const request = `${method.toUpperCase()} ${pathname}`;
  const hit = matchRoute(backend.table, method, pathname);
  if (!hit) return { request, problem: `No route in the backend code matches ${request}.` };
  return { request, slice: sliceRoute(backend.ts, hit.route), params: hit.params };
}

export type Discovered =
  | { request: string; route: { method: string; path: string; file: string; line: number }; rules: Rule[]; groups: Group[] }
  | { request: string; problem: string };

/** The business rules behind one API call, as data (`rules`) and grouped for reading (`groups`). */
export function discover(project: Project, backend: Backend, method: string, pathname: string): Discovered {
  const l = locate(backend, method, pathname);
  if ('problem' in l) return l;
  const rules = extractRules(backend.ts, l.slice, { glossary: project.config.glossary });
  const r = l.slice.route;
  return { request: l.request, route: { method: r.method, path: r.path, file: r.file, line: r.line }, rules, groups: present(rules) };
}

/** What the page's own code does for a click step. */
export interface PageDiscovered {
  label: string;
  /** The page file, relative to the frontend folder. */
  page: string;
  element: { file: string; line: number; tag: string };
  component: string;
  rules: Rule[];
  groups: Group[];
}

export interface DiscoveryFile {
  test: string;
  source: string;
  file: string;
  /** The backend folder's name, which rule file paths are relative to (e.g. "backend"). */
  codeRoot: string;
  /** The frontend folder's name, for the page rules' file paths. */
  frontRoot?: string;
  steps: { title: string; line: number; text: string; calls: Discovered[]; page?: PageDiscovered }[];
}

/** The label a click step clicks: `click "Create Route"`, `in "Add issue" dialog, click "Save"`. */
export function clickedLabel(text: string): string | undefined {
  const hit = matchStep(text);
  return hit && hit.def.kind === 'click' ? String(hit.args.name) : undefined;
}

/** For a click step: the element it clicked and the page's own rules around it. */
export function discoverClick(project: Project, fe: Frontend, pathname: string, label: string): PageDiscovered | undefined {
  const pageFile = pageFor(fe, pathname);
  if (!pageFile) return undefined;
  const found = actionRules(fe, pageFile, label, { glossary: project.config.glossary });
  if (!found) return undefined;
  return {
    label, page: path.relative(fe.ts.root, pageFile).split(path.sep).join('/'),
    element: found.element, component: found.component, rules: found.rules, groups: present(found.rules),
  };
}

/**
 * Rules for every API call of one traced test, marked with what the test checks, saved to
 * .humantest/discovery/<same name as the trace>.json for the UI.
 */
export function writeDiscovery(project: Project, backend: Backend, t: { file: string; trace: TraceFile }, fe?: Frontend): DiscoveryFile {
  const seen = t.trace.steps.flatMap((s) => (/\bsee\b/i.test(s.text) && !/\bnot\s+see\b|shouldn't see/i.test(s.text) ? [...s.text.matchAll(/"([^"]+)"/g)].map((m) => m[1]) : []));
  const cache = new Map<string, Discovered>();
  const steps = t.trace.steps.map((s) => {
    const calls: Discovered[] = [];
    for (const c of s.calls) {
      if (c.simulated) continue;
      const key = `${c.method} ${c.path}`;
      if (calls.some((d) => d.request === key)) continue;
      if (!cache.has(key)) cache.set(key, discover(project, backend, c.method, c.path));
      const d = cache.get(key)!;
      if ('groups' in d) markChecked(d.groups, seen);
      calls.push(d);
    }
    const label = fe && s.pageUrl ? clickedLabel(s.text) : undefined;
    const page = label ? discoverClick(project, fe!, s.pageUrl!, label) : undefined;
    if (page) markChecked(page.groups, seen);
    return { title: s.title, line: s.line, text: s.text, calls, ...(page ? { page } : {}) };
  });
  const out = path.join(project.root, '.humantest', 'discovery', path.basename(t.file));
  const result: DiscoveryFile = {
    test: t.trace.test, source: t.trace.source, file: out, codeRoot: path.basename(backend.ts.root),
    ...(fe ? { frontRoot: path.basename(fe.ts.root) } : {}), steps,
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ ...result, file: undefined }, (k, v) => (k === 'decl' || k === 'node' ? undefined : v), 1));
  return result;
}

/** A trace written by the runtime (see TraceStep in src/runtime/index.ts). */
export interface TraceFile {
  test: string;
  source: string;
  steps: { title: string; user: string; line: number; text: string; pageUrl?: string; calls: { method: string; path: string; status?: number; simulated?: boolean; pageUrl?: string }[] }[];
}

/** The keys ("<.ht file>::<test name>") of the tests that exist now. */
export function currentTestKeys(project: Project): Set<string> {
  return new Set(check(project).parsed.flatMap((pf) => pf.tests.map((t) => `${pf.relFile}::${t.name}`)));
}

const traceKey = (t: TraceFile) => `${t.source.replace(/:\d+$/, '')}::${t.test}`;

/**
 * The last trace of each test that still exists. Traces of tests that were renamed or deleted are
 * left out (and removed with their discovery files when `prune` is set: they are only a cache).
 */
export function readTraces(project: Project, prune = false): { file: string; trace: TraceFile }[] {
  const dir = path.join(project.root, '.humantest', 'traces');
  if (!fs.existsSync(dir)) return [];
  const keys = currentTestKeys(project);
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().flatMap((f) => {
    let trace: TraceFile;
    try {
      trace = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as TraceFile;
    } catch {
      return [];
    }
    if (keys.has(traceKey(trace))) return [{ file: path.join(dir, f), trace }];
    if (prune) {
      fs.rmSync(path.join(dir, f), { force: true });
      fs.rmSync(path.join(project.root, '.humantest', 'discovery', f), { force: true });
    }
    return [];
  });
}
