// What the tests don't cover: for each part of the app, which requests a test reaches, and of their
// rules, which ones a test checks. Plus, for a rule with a message that no test checks, a draft test:
// the lines of a test that reaches it, then what to see. Read from the last run and the code; no AI.

import fs from 'node:fs';
import path from 'node:path';
import type { Project } from '../compiler/project.mts';
import { discover, readTraces, writeDiscovery, type Backend, type Frontend } from './index.mts';
import type { RouteEntry } from './backend/express.mts';
import type { Line } from './rules/present.mts';

/** A test that reaches a request; `status`: what the request answered in that test's last run. */
export interface ReachedBy { test: string; file: string; testLine: number; stepLine: number; status?: number }

export interface GapLine extends Line {
  /** The group it is shown in, e.g. "When the server says no". */
  group: string;
  /** A draft test for it (see draftFor), when `withDrafts` added one. */
  draft?: string;
}

/** A refusal or page stop with a message: a test can look for it, so a draft can be made. */
export const draftable = (l: GapLine) => !l.checked && l.messages.length > 0 && /says no|On the page/.test(l.group);

/** Adds a draft test to every unchecked line that can have one. */
export function withDrafts(project: Project, report: GapReport): GapReport {
  for (const q of report.reached) for (const l of q.lines) if (draftable(l)) l.draft = draftFor(project, q, l);
  return report;
}

export interface GapRequest {
  /** "POST /api/v1/routes", or `CLICK "Save" on app/x/page.tsx` for the page's own rules. */
  request: string;
  /** The part of the app it belongs to, as in GapArea. */
  area: string;
  /** What it does, in words, from its handler's name: "Create route". */
  title?: string;
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
  /** Requests no test reaches, with their rules (none checked), for the feature pages. */
  unreached: { request: string; area: string; title?: string; root: string; rules: number; lines: GapLine[] }[];
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
  const reached = new Map<string, GapRequest>();
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
    d.steps.forEach((s, i) => {
      const by: ReachedBy = { test: d.test, file, testLine, stepLine: s.line };
      if (s.page && fe) add(`${s.page.action === 'upload' ? 'UPLOAD' : 'CLICK'} "${s.page.label}" on ${s.page.page}`, 'page', frontRoot, s.page.groups, by);
      for (const c of s.calls) {
        if (!('route' in c)) continue;
        const status = t.trace.steps[i]?.calls.find((x) => `${x.method} ${x.path}` === c.request)?.status;
        add(`${c.route.method} ${c.route.path}`, areaOf(c.route.path), codeRoot, c.groups, { ...by, ...(status !== undefined ? { status } : {}) });
      }
    });
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
    const title = titleOf(route);
    const hit = reached.get(key);
    if (hit) {
      if (title) hit.title = title;
      a.reached++;
      a.rules += hit.lines.length;
      a.reachedRules += hit.lines.length;
      a.checked += hit.lines.filter((l) => l.checked).length;
      continue;
    }
    // A sample path for the pattern, to read its rules.
    const d = discover(project, backend, route.method, route.path.replace(/:(\w+)\??/g, 'x1').replace(/\*/g, 'x1'));
    const lines: GapLine[] = 'groups' in d ? d.groups.flatMap((g) => g.lines.map((l) => ({ ...l, group: g.title, checked: false }))) : [];
    a.rules += lines.length;
    unreached.push({ request: key, area: a.name, ...(title ? { title } : {}), root: codeRoot, rules: lines.length, lines });
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
    reached: [...reached.values()],
    unreached,
  };
}

/**
 * What a request does, from its handler's name: `RouteController.createRoute` → "Create route",
 * `getAllRoutes` → "Get all routes". None for a handler written in the route itself.
 */
export function titleOf(route: RouteEntry): string | undefined {
  const name = route.handler?.ref?.name ?? route.handler?.text;
  if (!name || /\s|=>|function/.test(name)) return titleFromPath(route.method, route.path);
  const last = name.split('.').pop()!;
  const words = last.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase().trim();
  return words ? words[0].toUpperCase() + words.slice(1) : undefined;
}

/** For a handler without a name: `GET /trips/:id` → "Get one trip", `GET /supports/my-tickets` → "List my tickets". */
function titleFromPath(method: string, p: string): string | undefined {
  const parts = p.split('/').filter(Boolean);
  const fixed = parts.filter((x) => !x.startsWith(':'));
  const last = fixed.at(-1)?.replace(/-/g, ' ');
  if (!last) return undefined;
  const one = last.replace(/ies$/, 'y').replace(/([^s])s$/, '$1');
  const byId = parts.at(-1)?.startsWith(':');
  switch (method) {
    case 'GET': return byId ? `Get one ${one}` : `List ${last}`;
    case 'POST': return byId ? `Add to ${one}` : `Create ${one}`;
    case 'PUT': case 'PATCH': return `Update ${one}`;
    case 'DELETE': return `Delete ${one}`;
    default: return undefined;
  }
}

/**
 * A draft test for a rule no test checks: the lines of a test that reaches it, up to the step that
 * gets there, then what has to be true and what to see. It is a start, not a finished test: making
 * the condition true (another port, a full trip) is for whoever writes it.
 */
export function draftFor(project: Project, req: GapRequest, line: GapLine): string | undefined {
  const message = line.messages[0];
  // A test that got through (2xx), else one that at least got past who may (not 401/403): one turned
  // away at the door never reaches the rules inside.
  const rank = (b: ReachedBy) => (b.status === undefined ? 1 : b.status < 300 ? 0 : b.status === 401 || b.status === 403 ? 3 : 2);
  const by = [...req.reachedBy].sort((a, b) => rank(a) - rank(b))[0];
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
    `# It is not run while it says "Draft:". When the steps are right, change that to "Test:".`,
    `Draft: ${name}`,
    ...body,
    `${indent}should see "${seen}"`,
  ].join('\n');
}

/** The order people read a request's rules in (as present.mts groups them). */
export const READING_ORDER = ['On the page, before anything is sent', 'Who can do it', 'What the request must contain', 'When the server says no', 'What it changes', 'The answer when all is well'];
const readingRank = (g: string) => { const i = READING_ORDER.indexOf(g); return i < 0 ? READING_ORDER.length : i; };

export interface Feature {
  name: string;
  /** Every request of this part of the app, tested or not, with all its rules in reading order. */
  requests: (Omit<GapRequest, 'area'> & { reached: boolean })[];
  /** Clicks and uploads a test made on this part's own pages (`…/routes/…`), with their rules. */
  page: GapRequest[];
}

/** One part of the app ("routes") as a whole: what the code does, request by request. */
export function featureOf(report: GapReport, name: string): Feature {
  const sorted = (lines: GapLine[]) => [...lines].sort((a, b) => readingRank(a.group) - readingRank(b.group));
  const requests = [
    ...report.reached.filter((q) => q.area === name).map(({ area: _a, ...q }) => ({ ...q, lines: sorted(q.lines), reached: true })),
    ...report.unreached.filter((u) => u.area === name).map((u) => ({ request: u.request, ...(u.title ? { title: u.title } : {}), root: u.root, reachedBy: [], lines: sorted(u.lines), reached: false })),
  ];
  // The app's own order: by path, then reading verb order.
  const VERB = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
  const parts = (r: string) => { const [m, p] = r.split(' '); return { m: VERB.indexOf(m), p }; };
  requests.sort((a, b) => { const x = parts(a.request), y = parts(b.request); return x.p.localeCompare(y.p) || x.m - y.m; });
  const page = report.reached.filter((q) => q.area === 'page' && q.request.includes(`/${name}/`));
  return { name, requests, page };
}
