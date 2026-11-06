// Phase 4: notice when the business logic behind a test changes.
// A snapshot is what one test's API calls run through in the app's code: for each call, the
// functions (with a hash of their code) and the rules found in them. The accepted snapshot is the
// baseline, kept next to the tests (e2e/logic/) so it is committed and reviewed like code.
// Comparing two snapshots gives what changed, rule by rule, without running anything.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Project } from '../compiler/project.mts';
import { matchRoute } from './backend/express.mts';
import { sliceRoute } from './backend/slice.mts';
import { clickedLabel, currentTestKeys, discoverClick, readTraces, type Backend, type Frontend, type TraceFile } from './index.mts';
import { actionRules } from './frontend/actions.mts';
import { pageFor } from './frontend/next.mts';
import { extractRules } from './rules/index.mts';
import { renderRule } from './rules/render.mts';
import type { Rule } from './rules/types.mts';

export interface SnapFunction { name: string; file: string; line: number; role: string; hash: string }
export type SnapRule = Rule & { text: string };

export interface SnapRequest {
  /** Method and the route's path pattern, e.g. "GET /api/v1/routes/:id": the same whatever the ids were. */
  request: string;
  route?: { method: string; path: string; file: string; line: number };
  /** No route matched (it may have been removed or renamed). */
  problem?: string;
  /** For a click on the page (not an API call): where, and on what, so it can be found again. */
  ui?: { url: string; label: string };
  functions: SnapFunction[];
  rules: SnapRule[];
}

export interface Snapshot {
  version: 1;
  /** The UI's test key: "<.ht file>::<test name>". */
  key: string;
  test: string;
  source: string;
  /** The test's steps, and which requests each one made. */
  steps: { title: string; line: number; text: string; requests: string[] }[];
  requests: SnapRequest[];
  acceptedAt?: string;
  /** The page's own code (clicks) is part of it. Baselines saved before HumanTest read the frontend lack this. */
  frontend?: boolean;
}

const fileSlug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export const logicDir = (project: Project) => path.resolve(project.root, project.config.logicDir ?? 'e2e/logic');
const baselineFile = (project: Project, key: string) => {
  const [file, ...name] = key.split('::');
  return path.join(logicDir(project), `${fileSlug(`${file} ${name.join('::')}`)}.json`);
};

/** The test key from a trace: its source is "<file>:<line>". */
export const keyOfTrace = (t: TraceFile) => `${t.source.replace(/:\d+$/, '')}::${t.test}`;

/** One request's code and rules, in the current code. `pathname` may be concrete or a pattern. */
function snapRequest(project: Project, backend: Backend, method: string, pathname: string): SnapRequest {
  const hit = matchRoute(backend.table, method, pathname);
  if (!hit) return { request: `${method.toUpperCase()} ${pathname}`, problem: `No route in the backend code matches ${method.toUpperCase()} ${pathname} any more.`, functions: [], rules: [] };
  const r = hit.route;
  const slice = sliceRoute(backend.ts, r);
  const rules = extractRules(backend.ts, slice, { glossary: project.config.glossary });
  const seen = new Set<string>();
  const functions: SnapFunction[] = [];
  for (const it of slice.items) {
    const id = `${it.file}#${it.name}`;
    if (it.repeat || seen.has(id)) continue;
    seen.add(id);
    functions.push({ name: it.name, file: it.file, line: it.line, role: it.role, hash: it.hash });
  }
  return {
    request: `${r.method} ${r.path}`,
    route: { method: r.method, path: r.path, file: r.file, line: r.line },
    functions,
    rules: rules.map((x) => ({ ...x, text: renderRule(x) })),
  };
}

/** A click on the page, in the current frontend code: the element's own rules and the code behind them. */
function snapClick(project: Project, fe: Frontend, url: string, label: string): SnapRequest {
  const d = discoverClick(project, fe, url, label);
  const pageFile = pageFor(fe, url);
  const where = pageFile ? path.relative(fe.ts.root, pageFile).split(path.sep).join('/') : url;
  const request = `CLICK "${label}" on ${where}`;
  if (!d) return { request, ui: { url, label }, problem: `"${label}" is no longer on ${where} in the frontend code.`, functions: [], rules: [] };
  const found = actionRules(fe, pageFile!, label, { glossary: project.config.glossary });
  return {
    request, ui: { url, label },
    functions: (found?.functions ?? []).map((f) => ({ name: f.name, file: f.file, line: f.line, role: f.role, hash: f.hash })),
    rules: d.rules.map((x) => ({ ...x, text: renderRule(x) })),
  };
}

/** A snapshot of a test from its last trace: the requests it really made, in the current code. */
export function snapshotFromTrace(project: Project, backend: Backend, trace: TraceFile, fe?: Frontend): Snapshot {
  const requests = new Map<string, SnapRequest>();
  const steps = trace.steps.map((s) => {
    const made: string[] = [];
    const label = fe && s.pageUrl ? clickedLabel(s.text) : undefined;
    if (label) {
      const snap = snapClick(project, fe!, s.pageUrl!, label);
      // Only clicks whose element was found: a button from a design library has no rules of its own here.
      if (!snap.problem) {
        if (!requests.has(snap.request)) requests.set(snap.request, snap);
        made.push(snap.request);
      }
    }
    for (const c of s.calls) {
      if (c.simulated) continue;
      const snap = snapRequest(project, backend, c.method, c.path);
      if (!requests.has(snap.request)) requests.set(snap.request, snap);
      if (!made.includes(snap.request)) made.push(snap.request);
    }
    return { title: s.title, line: s.line, text: s.text, requests: made };
  });
  return { version: 1, key: keyOfTrace(trace), test: trace.test, source: trace.source, steps, requests: [...requests.values()], ...(fe ? { frontend: true } : {}) };
}

/** The same test, rebuilt from a baseline's requests against the current code (no test run needed). */
export function snapshotFromBaseline(project: Project, backend: Backend, base: Snapshot, fe?: Frontend): Snapshot {
  const requests = base.requests.map((r) => {
    if (r.ui) return fe ? snapClick(project, fe, r.ui.url, r.ui.label) : r;
    const [method, ...rest] = r.request.split(' ');
    return snapRequest(project, backend, method, rest.join(' '));
  });
  // A request whose route moved to a new pattern is still the same request for the steps.
  const renamed = new Map(base.requests.map((r, i) => [r.request, requests[i].request]));
  return { ...base, acceptedAt: undefined, ...(fe ? { frontend: true } : {}), steps: base.steps.map((s) => ({ ...s, requests: s.requests.map((q) => renamed.get(q) ?? q) })), requests };
}

export function readBaseline(project: Project, key: string): Snapshot | undefined {
  try {
    return JSON.parse(fs.readFileSync(baselineFile(project, key), 'utf8')) as Snapshot;
  } catch {
    return undefined;
  }
}

export function readBaselines(project: Project): Snapshot[] {
  const dir = logicDir(project);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().flatMap((f) => {
    try { return [JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Snapshot]; } catch { return []; }
  });
}

export function saveBaseline(project: Project, snap: Snapshot): string {
  const file = baselineFile(project, snap.key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const out: Snapshot = { ...snap, acceptedAt: new Date().toISOString() };
  fs.writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`);
  return file;
}

// ---------------- comparing ----------------

export interface RuleChange {
  change: 'added' | 'removed' | 'changed';
  before?: string;
  after?: string;
  /** Where it is now (or was, when removed). */
  source: { file: string; line: number };
}

export interface FunctionChange { change: 'added' | 'removed' | 'changed'; name: string; file: string; line: number; lastCommit?: string }

export interface RequestChange {
  request: string;
  change: 'added' | 'removed' | 'changed' | 'same';
  problem?: string;
  /** For a request no longer reached: how many rules were behind it (they are not listed one by one). */
  ruleCount?: number;
  functions: FunctionChange[];
  rules: RuleChange[];
}

export interface TestChange {
  key: string;
  test: string;
  source: string;
  acceptedAt?: string;
  /** "changed": rules differ. "code-only": code changed but no rule did (e.g. a refactor). */
  status: 'same' | 'changed' | 'code-only' | 'new' | 'gone';
  requests: RequestChange[];
}

/** Facts of a rule, without where it is or how it reads (moving code is not a change in logic). */
const facts = (r: SnapRule) => {
  const { id: _id, source: _s, text: _t, ...rest } = r;
  return JSON.stringify(rest);
};

export function compare(before: Snapshot | undefined, after: Snapshot): TestChange {
  const base = { key: after.key, test: after.test, source: after.source, acceptedAt: before?.acceptedAt };
  if (!before) return { ...base, status: 'new', requests: [] };
  const old = new Map(before.requests.map((r) => [r.request, r]));
  // A baseline from before HumanTest read the frontend has no clicks: they are not new logic, so they are left out
  // (accepting again adds them).
  const comparable = before.frontend || !after.frontend ? after.requests : after.requests.filter((r) => !r.ui);
  const now = new Map(comparable.map((r) => [r.request, r]));
  const requests: RequestChange[] = [];
  for (const [req, b] of old) {
    const a = now.get(req);
    // The test no longer reaches this route (removed, renamed, or the test calls something else now):
    // one line, not every rule that was behind it.
    if (!a || (a.problem && !b.problem)) {
      requests.push({ request: req, change: 'removed', ...(a?.problem ? { problem: a.problem } : {}), ruleCount: b.rules.length, functions: [], rules: [] });
      continue;
    }
    const functions = compareFunctions(b.functions, a.functions);
    const rules = compareRules(b.rules, a.rules);
    const change = rules.length || functions.length ? 'changed' : 'same';
    requests.push({ request: req, change, ...(a.problem ? { problem: a.problem } : {}), functions, rules });
  }
  for (const [req, a] of now) {
    if (old.has(req)) continue;
    requests.push({ request: req, change: 'added', ruleCount: a.rules.length, functions: [], rules: [] });
  }
  const ruleChanges = requests.some((r) => r.rules.length || r.change === 'added' || r.change === 'removed');
  const codeChanges = requests.some((r) => r.functions.length);
  return { ...base, status: ruleChanges ? 'changed' : codeChanges ? 'code-only' : 'same', requests };
}

function compareFunctions(before: SnapFunction[], after: SnapFunction[]): FunctionChange[] {
  const key = (f: SnapFunction) => `${f.file}#${f.name}`;
  const old = new Map(before.map((f) => [key(f), f]));
  const now = new Map(after.map((f) => [key(f), f]));
  const out: FunctionChange[] = [];
  for (const [k, f] of now) {
    const o = old.get(k);
    if (!o) out.push({ change: 'added', name: f.name, file: f.file, line: f.line });
    else if (o.hash !== f.hash) out.push({ change: 'changed', name: f.name, file: f.file, line: f.line });
  }
  for (const [k, f] of old) if (!now.has(k)) out.push({ change: 'removed', name: f.name, file: f.file, line: f.line });
  return out;
}

/**
 * Rule by rule, by id. A rule whose id changed (its condition was edited) shows up as removed + added;
 * when the two are clearly the same rule (same place, same kind, same message or field), they are
 * shown as one change instead.
 */
function compareRules(before: SnapRule[], after: SnapRule[]): RuleChange[] {
  const old = new Map(before.map((r) => [r.id, r]));
  const now = new Map(after.map((r) => [r.id, r]));
  const out: RuleChange[] = [];
  const removed = before.filter((r) => !now.has(r.id));
  const added = after.filter((r) => !old.has(r.id));
  for (const a of after) {
    const b = old.get(a.id);
    if (b && facts(b) !== facts(a)) out.push({ change: 'changed', before: b.text, after: a.text, source: a.source });
  }
  const sameRule = (b: SnapRule, a: SnapRule) => {
    if (b.kind !== a.kind) return false;
    if (b.kind === 'reject' && a.kind === 'reject') return b.in === a.in && (b.message === a.message || b.when.map((c) => c.code).join() === a.when.map((c) => c.code).join());
    if (b.kind === 'check' && a.kind === 'check') return b.section === a.section && b.field === a.field;
    return false;
  };
  for (const b of removed) {
    const i = added.findIndex((a) => sameRule(b, a));
    if (i >= 0) {
      const [a] = added.splice(i, 1);
      out.push({ change: 'changed', before: b.text, after: a.text, source: a.source });
    } else {
      out.push({ change: 'removed', before: b.text, source: b.source });
    }
  }
  for (const a of added) out.push({ change: 'added', after: a.text, source: a.source });
  return out;
}

/** Who last touched a file, from git (if the code is in a repository): "46403c6 · Khaled · 2 days ago · fix: …". */
export function lastCommit(root: string, file: string): string | undefined {
  try {
    const dirty = execFileSync('git', ['status', '--porcelain', '--', file], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (dirty) return 'not committed yet';
    const out = execFileSync('git', ['log', '-1', '--format=%h · %an · %ar · %s', '--', file], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/**
 * What changed since each test's baseline, in the current code. Without running the tests: the
 * requests are the ones the test made when its baseline was accepted.
 */
export function changes(project: Project, backend: Backend, fe?: Frontend): TestChange[] {
  const keys = currentTestKeys(project);
  return readBaselines(project).map((base): TestChange => {
    // Its test was renamed or deleted: nothing to compare (accepting removes the old baseline).
    if (!keys.has(base.key)) return { key: base.key, test: base.test, source: base.source, acceptedAt: base.acceptedAt, status: 'gone', requests: [] };
    const result = compare(base, snapshotFromBaseline(project, backend, base, fe));
    for (const r of result.requests) {
      // A click's code is the frontend's; an API call's is the backend's.
      const root = r.request.startsWith('CLICK ') && fe ? fe.ts.root : backend.ts.root;
      for (const f of r.functions) f.lastCommit = lastCommit(root, f.file);
    }
    return result;
  });
}

/**
 * After a run: tests run for the first time get their baseline (what they rely on now); for the
 * others, what changed since it was accepted, including calls the test makes now and didn't before.
 */
export function afterRun(project: Project, backend: Backend, fe?: Frontend): { started: number; changed: TestChange[] } {
  let started = 0;
  const changed: TestChange[] = [];
  for (const { trace } of readTraces(project, true)) {
    const snap = snapshotFromTrace(project, backend, trace, fe);
    const base = readBaseline(project, snap.key);
    if (!base) { saveBaseline(project, snap); started++; continue; }
    const diff = compare(base, snap);
    if (diff.status === 'changed') changed.push(diff);
  }
  return { started, changed };
}

/**
 * Accepts the current logic as the baseline: from the test's last trace, else from its old baseline.
 * Accepting everything also removes the baselines of tests that no longer exist.
 */
export function accept(project: Project, backend: Backend, key?: string, fe?: Frontend): { saved: string[]; removed: string[] } {
  const saved: string[] = [];
  const removed: string[] = [];
  const current = currentTestKeys(project);
  const traces = new Map(readTraces(project).map((t) => [keyOfTrace(t.trace), t.trace]));
  const baselines = readBaselines(project);
  const keys = key ? [key] : [...new Set([...traces.keys(), ...baselines.map((b) => b.key)])];
  for (const k of keys) {
    if (!current.has(k)) {
      if (!key) {
        const f = baselineFile(project, k);
        if (fs.existsSync(f)) { fs.rmSync(f); removed.push(f); }
      }
      continue;
    }
    const trace = traces.get(k);
    const old = readBaseline(project, k);
    const snap = trace ? snapshotFromTrace(project, backend, trace, fe) : old ? snapshotFromBaseline(project, backend, old, fe) : undefined;
    if (snap) saved.push(saveBaseline(project, snap));
  }
  return { saved, removed };
}
