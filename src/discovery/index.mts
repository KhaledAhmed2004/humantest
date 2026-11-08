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
import { actionRules, uploadRules } from './frontend/actions.mts';
import { pageFor, type Frontend } from './frontend/next.mts';
import { draftable, draftFor } from './draft.mts';
import type { GapLine } from './gaps.mts';
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

/** What the page's own code does for a click or upload step. */
export interface PageDiscovered {
  /** Clicked, or a file chosen in a file input. */
  action: PageActionKind;
  /** The words clicked, or the words next to the file input. */
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

export type PageActionKind = 'click' | 'upload';

/**
 * What a step does on the page that the page's own code handles: `click "Create Route"`,
 * `in "Add issue" dialog, click "Save"`, `upload "cover.jpg" to "Route Cover Photo"`.
 */
export function pageAction(text: string): { kind: PageActionKind; label: string } | undefined {
  const hit = matchStep(text);
  if (hit?.def.kind === 'click') return { kind: 'click', label: String(hit.args.name) };
  if (hit?.def.kind === 'upload' && hit.args.field) return { kind: 'upload', label: String(hit.args.field) };
  return undefined;
}

/** How the baselines name a page action: `CLICK "Save" on app/x/page.tsx`. */
export const pageActionKey = (kind: PageActionKind, label: string, page: string) => `${kind.toUpperCase()} "${label}" on ${page}`;
/** A baseline request that is a page action, not an API call. */
export const isPageActionKey = (request: string) => /^(CLICK|UPLOAD) "/.test(request);

/** For a click or upload step: the element it used and the page's own rules around it. */
export function discoverClick(project: Project, fe: Frontend, pathname: string, label: string, kind: PageActionKind = 'click'): PageDiscovered | undefined {
  const pageFile = pageFor(fe, pathname);
  if (!pageFile) return undefined;
  const w = { glossary: project.config.glossary };
  const found = kind === 'upload' ? uploadRules(fe, pageFile, label, w) : actionRules(fe, pageFile, label, w);
  if (!found) return undefined;
  return {
    action: kind, label, page: path.relative(fe.ts.root, pageFile).split(path.sep).join('/'),
    element: found.element, component: found.component, rules: found.rules, groups: present(found.rules),
  };
}

/**
 * Rules for every API call of one traced test, marked with what the test checks, saved to
 * .humantest/discovery/<same name as the trace>.json for the UI.
 */
export function writeDiscovery(project: Project, backend: Backend, t: { file: string; trace: TraceFile }, fe?: Frontend): DiscoveryFile {
  const seen = t.trace.steps.flatMap((s) => (/\bsee\b/i.test(s.text) && !/\bnot\s+see\b|shouldn't see/i.test(s.text) ? [...s.text.matchAll(/"([^"]+)"/g)].map((m) => m[1]) : []));
  const statuses = checkedStatuses(t.trace);
  const cache = new Map<string, Discovered>();
  const steps = t.trace.steps.map((s) => {
    const calls: Discovered[] = [];
    for (const c of s.calls) {
      if (c.simulated) continue;
      const key = `${c.method} ${c.path}`;
      if (calls.some((d) => d.request === key)) continue;
      if (!cache.has(key)) cache.set(key, discover(project, backend, c.method, c.path));
      const d = cache.get(key)!;
      if ('groups' in d) markChecked(d.groups, seen, statuses.get(key));
      calls.push(d);
    }
    const act = fe && s.pageUrl ? pageAction(s.text) : undefined;
    const page = act ? discoverClick(project, fe!, s.pageUrl!, act.label, act.kind) : undefined;
    if (page) markChecked(page.groups, seen);
    return { title: s.title, line: s.line, text: s.text, calls, ...(page ? { page } : {}) };
  });
  addDrafts(project, t.trace, steps, path.basename(backend.ts.root), fe ? path.basename(fe.ts.root) : '');
  const out = path.join(project.root, '.humantest', 'discovery', path.basename(t.file));
  const result: DiscoveryFile = {
    test: t.trace.test, source: t.trace.source, file: out, codeRoot: path.basename(backend.ts.root),
    ...(fe ? { frontRoot: path.basename(fe.ts.root) } : {}), steps,
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ ...result, file: undefined }, (k, v) => (k === 'decl' || k === 'node' ? undefined : v), 1));
  return result;
}

/**
 * A draft test for each rule this test reaches but doesn't check, where a test could look for its
 * message: this test's own lines up to the first step that reaches it, then what to see.
 */
function addDrafts(project: Project, trace: TraceFile, steps: DiscoveryFile['steps'], codeRoot: string, frontRoot: string) {
  const file = trace.source.replace(/:\d+$/, '');
  const testLine = Number(trace.source.match(/:(\d+)$/)?.[1] ?? 0);
  steps.forEach((s, i) => {
    const by = { test: trace.test, file, testLine, stepLine: s.line };
    const each = (request: string, root: string, groups: Group[], status?: number) => {
      const req = { request, area: '', root, reachedBy: [{ ...by, ...(status !== undefined ? { status } : {}) }], lines: [] };
      for (const g of groups) for (const l of g.lines) {
        // The same request's rules are shared by every step that makes it: the first step's draft is the shortest.
        if ((l as GapLine).draft !== undefined) continue;
        const line = { ...l, group: g.title };
        const d = draftable(line) ? draftFor(project, req, line, 'this test does not check') : undefined;
        if (d) (l as GapLine).draft = d;
      }
    };
    if (s.page) each(pageActionKey(s.page.action, s.page.label, s.page.page), frontRoot, s.page.groups);
    for (const c of s.calls) {
      if (!('groups' in c)) continue;
      each(c.request, codeRoot, c.groups, trace.steps[i]?.calls.find((x) => `${x.method} ${x.path}` === c.request)?.status);
    }
  });
}

/**
 * The statuses a test checks, by the request ("POST /api/v1/routes") that answered them. As in the
 * runtime, `backend should reply 409` checks the last reply: of the last `backend should receive …`
 * (the latest matching call so far) or `call …` step before it.
 */
export function checkedStatuses(trace: TraceFile): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const calls: { method: string; path: string }[] = [];
  let last: string | undefined;
  for (const s of trace.steps) {
    const real = s.calls.filter((c) => !c.simulated);
    calls.push(...real);
    const receive = s.text.match(/backend\s+should\s+receive\s+([A-Z]+)\s+(\S+)/i);
    if (receive) {
      const [method, pattern] = [receive[1].toUpperCase(), receive[2].split('?')[0]];
      const parts = pattern.split('/');
      const hit = [...calls].reverse().find((c) => {
        const q = c.path.split('/');
        return c.method === method && q.length === parts.length && parts.every((x, i) => (x.startsWith(':') ? q[i] !== '' : x === q[i]));
      });
      last = hit ? `${hit.method} ${hit.path}` : undefined;
    } else if (/^\s*call\s+[A-Z]+\s/i.test(s.text) && real.length) {
      last = `${real.at(-1)!.method} ${real.at(-1)!.path}`;
    }
    const reply = s.text.match(/(?:backend\s+should\s+(?:reply|respond)(?:\s+with)?|reply\s+status\s+should\s+be)\s+(\d{3})/i);
    if (reply && last) out.set(last, [...(out.get(last) ?? []), Number(reply[1])]);
  }
  return out;
}

/** A trace written by the runtime (see TraceStep in src/runtime/index.ts). */
export interface TraceFile {
  test: string;
  source: string;
  status?: 'passed' | 'failed';
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
