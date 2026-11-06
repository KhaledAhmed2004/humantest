// What the tests don't cover: for each part of the app, which requests a test reaches, and of their
// rules, which ones a test checks. Plus, for a rule with a message that no test checks, a draft test:
// the lines of a test that reaches it, then what to see. Read from the last run and the code; no AI.

import fs from 'node:fs';
import path from 'node:path';
import type { Project } from '../compiler/project.mts';
import { discover, readTraces, writeDiscovery, type Backend, type Frontend } from './index.mts';
import type { Line } from './rules/present.mts';

export interface ReachedBy { test: string; file: string; testLine: number; stepLine: number }

export interface GapLine extends Line {
  /** The group it is shown in, e.g. "When the server says no". */
  group: string;
}

export interface GapRequest {
  /** "POST /api/v1/routes", or `CLICK "Save" on app/x/page.tsx` for the page's own rules. */
  request: string;
  /** The code folder its rules are in, for the file paths. */
  root: string;
  reachedBy: ReachedBy[];
  lines: GapLine[];
}

export interface GapArea {
  /** The first part of the path after the API prefix: "routes", "bookings". "page" for clicks and uploads. */
  name: string;
  requests: number;
  reached: number;
  rules: number;
  /** Rules in the requests the tests reach. */
  reachedRules: number;
  checked: number;
}

export interface GapReport {
  areas: GapArea[];
  /** Requests the tests reach, each with all its rules (checked or not). */
  reached: GapRequest[];
  /** Requests no test reaches. */
  unreached: { request: string; area: string; rules: number }[];
}

/** Most telling first: what stops the user, what the request changes, then who may, then fields. */
const GROUP_ORDER = ['When the server says no', 'On the page, before anything is sent', 'What it changes', 'The answer when all is well', 'Who can do it', 'What the request must contain'];
export const groupRank = (g: string) => { const i = GROUP_ORDER.indexOf(g); return i < 0 ? GROUP_ORDER.length : i; };

export function gaps(project: Project, backend: Backend, fe?: Frontend): GapReport {
  const prefix = (project.config.apiPrefix ?? '/api').replace(/\/$/, '');
  const areaOf = (p: string) => (p.startsWith(prefix) ? p.slice(prefix.length) : p).split('/').filter(Boolean)[0] ?? '(root)';
  const codeRoot = path.basename(backend.ts.root);
  const frontRoot = fe ? path.basename(fe.ts.root) : '';

  // Every test's last run, with its rules marked checked or not.
  const reached = new Map<string, GapRequest & { area: string }>();
  const add = (key: string, area: string, root: string, groups: { title: string; lines: Line[] }[], by: ReachedBy) => {
    let r = reached.get(key);
    if (!r) {
      r = { request: key, area, root, reachedBy: [], lines: groups.flatMap((g) => g.lines.map((l) => ({ ...l, group: g.title, checked: false }))) };
      reached.set(key, r);
    }
    if (!r.reachedBy.some((x) => x.test === by.test)) r.reachedBy.push(by);
    // Checked by any test that reaches it.
    const now = groups.flatMap((g) => g.lines);
    for (const l of r.lines) if (now.some((n) => n.checked && n.ids.join() === l.ids.join())) l.checked = true;
  };
  for (const t of readTraces(project)) {
    const d = writeDiscovery(project, backend, t, fe);
    const [file, testLine] = [t.trace.source.replace(/:\d+$/, ''), Number(t.trace.source.match(/:(\d+)$/)?.[1] ?? 0)];
    for (const s of d.steps) {
      const by = { test: d.test, file, testLine, stepLine: s.line };
      if (s.page && fe) add(`${s.page.action === 'upload' ? 'UPLOAD' : 'CLICK'} "${s.page.label}" on ${s.page.page}`, 'page', frontRoot, s.page.groups, by);
      for (const c of s.calls) {
        if (!('route' in c)) continue;
        add(`${c.route.method} ${c.route.path}`, areaOf(c.route.path), codeRoot, c.groups, by);
      }
    }
  }

  // Every request the backend has, reached or not.
  const unreached: GapReport['unreached'] = [];
  const areas = new Map<string, GapArea>();
  const area = (name: string) => {
    if (!areas.has(name)) areas.set(name, { name, requests: 0, reached: 0, rules: 0, reachedRules: 0, checked: 0 });
    return areas.get(name)!;
  };
  const seen = new Set<string>();
  for (const route of backend.table.routes) {
    const key = `${route.method} ${route.path}`;
    // Catch-alls (`*`, a bare `/`) answer anything; they are not requests of the app's own.
    if (seen.has(key) || route.path === '/' || route.path.includes('*')) continue;
    seen.add(key);
    const a = area(areaOf(route.path));
    a.requests++;
    const hit = reached.get(key);
    if (hit) {
      a.reached++;
      a.rules += hit.lines.length;
      a.reachedRules += hit.lines.length;
      a.checked += hit.lines.filter((l) => l.checked).length;
      continue;
    }
    // A sample path for the pattern, to read its rules.
    const d = discover(project, backend, route.method, route.path.replace(/:(\w+)\??/g, 'x1').replace(/\*/g, 'x1'));
    const n = 'groups' in d ? d.groups.reduce((k, g) => k + g.lines.length, 0) : 0;
    a.rules += n;
    unreached.push({ request: key, area: a.name, rules: n });
  }
  for (const r of reached.values()) {
    if (r.area !== 'page') continue;
    const a = area('page');
    a.requests++;
    a.reached++;
    a.rules += r.lines.length;
    a.reachedRules += r.lines.length;
    a.checked += r.lines.filter((l) => l.checked).length;
  }
  for (const r of reached.values()) r.lines.sort((x, y) => groupRank(x.group) - groupRank(y.group));
  return {
    areas: [...areas.values()].sort((x, y) => (y.reached - x.reached) || x.name.localeCompare(y.name)),
    reached: [...reached.values()].map(({ area: _a, ...r }) => r),
    unreached,
  };
}

/**
 * A draft test for a rule no test checks: the lines of a test that reaches it, up to the step that
 * gets there, then what has to be true and what to see. It is a start, not a finished test: making
 * the condition true (another port, a full trip) is for whoever writes it.
 */
export function draftFor(project: Project, req: GapRequest, line: GapLine): string | undefined {
  const message = line.messages[0];
  const by = req.reachedBy[0];
  if (!message || !by) return undefined;
  const file = path.join(project.root, by.file);
  if (!fs.existsSync(file)) return undefined;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  // From the test's own header to the step that reached this request.
  const body = lines.slice(by.testLine, by.stepLine).filter((l) => !/^\s*#/.test(l));
  while (body.length && !body.at(-1)!.trim()) body.pop();
  const indent = body.at(-1)?.match(/^\s*/)?.[0] ?? '    ';
  // A message with {placeholders}: look for its longest fixed part.
  const seen = message.split(/\{[^}]*\}/).map((x) => x.trim()).sort((a, b) => b.length - a.length)[0] || message;
  const why = line.text.replace(/,? (the server answers|the page stops|the request is refused).*$/, '').replace(/^If /, '');
  const name = `${line.status ? `${line.status} ` : ''}${seen.replace(/[."]+$/, '')}`.slice(0, 70);
  return [
    `# Draft from "${by.test}" (${by.file}:${by.testLine}), for this rule no test checks:`,
    `#   ${line.text}`,
    `#   ${req.root}/${line.source.file}:${line.source.line}`,
    `# Change the steps so that this is true before the last one: ${why}`,
    `Test: ${name}`,
    ...body,
    `${indent}should see "${seen}"`,
  ].join('\n');
}
