// Bug reports: after a run, every test that failed (or passed with watchdog warnings) gets a
// ready-to-file report in humantest-reports/<test>/bug-report.md, made from the report.json the
// runtime wrote: steps to reproduce (the test's own sentences), expected and actual, the backend
// calls, a screenshot, and a verdict: a bug, or a test that needs updating?
//
// The verdict comes from the business logic baselines: when the code behind a failing test is the
// same as when it last passed, something else broke; when it changed, the test may be out of date.

import fs from 'node:fs';
import path from 'node:path';
import type { Project } from './compiler/project.mts';
import { explainStep, matchStep } from './compiler/steps.mts';
import type { TestChange } from './discovery/baseline.mts';
import type { BugReportData } from './runtime/index.ts';

export const reportsDir = (project: Project) => path.join(project.root, 'humantest-reports');

export type Verdict =
  | { kind: 'bug'; why: string }
  | { kind: 'stale'; why: string }
  | { kind: 'hidden'; why: string }
  | { kind: 'unknown'; why: string };

const VERDICT_LABEL: Record<Verdict['kind'], string> = {
  bug: '🐞 Likely a bug',
  stale: '🔄 The test may need updating',
  hidden: '⚠️ Hidden problems (the test passed)',
  unknown: '❔ Bug, or out-of-date test? HumanTest can\'t tell',
};

/** Remove the reports of an earlier run, so only this run's are there. */
export function clearReports(project: Project) {
  fs.rmSync(reportsDir(project), { recursive: true, force: true });
}

export interface WrittenReport { file: string; test: string; source: string; verdict: Verdict }

/**
 * Write bug-report.md for every report.json of this run. `changes` is what changed in the code
 * behind each test since its baseline (undefined when HumanTest doesn't know the app's code).
 */
export function writeBugReports(project: Project, changes: TestChange[] | undefined, runAgain: (test: string) => string): WrittenReport[] {
  // The Playwright trace path is relative to the project; the command is run from here.
  const fromHere = (p: string) => path.relative(process.cwd(), path.resolve(project.root, p)).split(path.sep).join('/');
  const dir = reportsDir(project);
  if (!fs.existsSync(dir)) return [];
  const out: WrittenReport[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const json = path.join(dir, name, 'report.json');
    if (!fs.existsSync(json)) continue;
    let data: BugReportData;
    try { data = JSON.parse(fs.readFileSync(json, 'utf8')); } catch { continue; }
    const key = `${data.source.replace(/:\d+$/, '')}::${data.test}`;
    const change = changes?.find((c) => c.key === key);
    const verdict = verdictFor(data, changes, change);
    const file = path.join(dir, name, 'bug-report.md');
    if (data.playwrightTrace) {
      data.playwrightTrace = fs.existsSync(path.resolve(project.root, data.playwrightTrace)) ? fromHere(data.playwrightTrace) : undefined;
    }
    if (data.replay) data.replay = fromHere(data.replay);
    fs.writeFileSync(file, render(withValues(data), verdict, change, runAgain(data.test)));
    out.push({ file, test: data.test, source: data.source, verdict });
  }
  if (out.length) fs.writeFileSync(path.join(dir, 'README.md'), index(out, dir));
  return out;
}

export function verdictFor(data: BugReportData, changes: TestChange[] | undefined, change: TestChange | undefined): Verdict {
  if (data.status === 'passed') {
    return { kind: 'hidden', why: 'Every step passed, but the watchdog saw problems no step checks for (errors on the page, failing or slow API calls).' };
  }
  if (!changes) {
    return { kind: 'unknown', why: 'HumanTest doesn\'t know the app\'s code (no "source" in humantest.config.json), so it can\'t say whether the code behind this test changed.' };
  }
  if (!change || change.status === 'new' || change.status === 'gone') {
    return { kind: 'unknown', why: 'This test has never passed before (it has no accepted business logic), so there is nothing to compare with.' };
  }
  const since = change.acceptedAt ? ` (accepted ${new Date(change.acceptedAt).toLocaleString()})` : '';
  if (change.status === 'same') {
    return {
      kind: 'bug',
      why: `The code behind this test is the same as when it last passed${since}, so the test didn't go out of date: ` +
        'something else broke. Look at the app, its data and its settings.',
    };
  }
  if (change.status === 'code-only') {
    return {
      kind: 'bug',
      why: `The code behind this test changed since it last passed${since}, but none of its rules did (a refactor?). ` +
        'A change that was meant to keep the behaviour broke it: see "What changed in the code" below.',
    };
  }
  return {
    kind: 'stale',
    why: `The business logic behind this test changed since it last passed${since}. If the change is intended, ` +
      'update the test (and accept the new logic: npm run ht -- discover --accept); if not, it is a bug in that change.',
  };
}

// ---------------- the report ----------------

/** The steps with {unique} and the remembered {names} as they were in this run. */
function withValues(d: BugReportData): BugReportData {
  const values = new Map(Object.entries(d.values ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const fill = (s: string) => s.replace(/\{([a-z][\w ]*?)\}/gi, (all, k: string) => values.get(k.trim().toLowerCase()) ?? all);
  return { ...d, steps: d.steps.map((s) => ({ ...s, text: fill(s.text), ...(s.error ? { error: fill(s.error) } : {}) })) };
}

/** Lines that only keep the test itself running (not something a person does or checks). */
const HOUSEKEEPING = new Set(['remember', 'rememberEmail', 'atTheEnd']);
const housekeeping = (text: string) => {
  const hit = matchStep(text.split(' › ').pop()!);
  return !!hit && HOUSEKEEPING.has(hit.def.kind);
};

/** "POST /api/v1/ferries/:id" matches the call "POST /api/v1/ferries/7a58…". */
const sameRequest = (label: string, c: { method: string; path: string }) => {
  const m = /^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)$/.exec(label);
  if (!m || m[1] !== c.method) return false;
  const re = new RegExp(`^${m[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:\w+/g, '[^/]+')}$`);
  return re.test(c.path);
};

/** "story › step" → the step sentence alone. */
const inner = (text: string) => text.split(' › ').pop()!;
const story = (text: string) => (text.includes(' › ') ? text.split(' › ')[0] : undefined);

/** Lines of the runtime's error message under a heading like "What went wrong:". */
function section(error: string | undefined, heading: RegExp): string[] {
  if (!error) return [];
  const lines = error.split('\n');
  const start = lines.findIndex((l) => heading.test(l.trim()));
  if (start < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (!l.trim() || /^\s*📄/.test(l)) break;
    out.push(l.trim());
  }
  return out;
}

/** "Where the problem is: 🖥️ Frontend (the page)" and the reason under it, from the runtime's message. */
function whereFrom(error: string | undefined): { label: string; why: string } | undefined {
  const lines = (error ?? '').split('\n');
  const i = lines.findIndex((l) => /^Where the problem is:/.test(l.trim()));
  if (i < 0) return undefined;
  return { label: lines[i].trim().replace(/^Where the problem is:\s*/, ''), why: section(error, /^Where the problem is:/).join(' ') };
}

/** The steps as a person would do them: a phrase is one step, and whose turn it is is said once. */
function reproduce(steps: BugReportData['steps']): string[] {
  const out: string[] = [];
  let lastStory: string | undefined;
  let lastUser: string | undefined;
  for (const s of steps) {
    const st = story(s.text);
    const failed = s.status === 'failed';
    if (!failed && !st && housekeeping(s.text)) continue;
    if (st && st === lastStory && !failed) continue;
    lastStory = st;
    const who = s.user === 'setup' ? '' : s.user !== lastUser ? `**${s.user}**: ` : '';
    if (s.user !== 'setup') lastUser = s.user;
    const text = failed && st ? `${st}, at the step: ${inner(s.text)}` : st ?? s.text;
    out.push(`${out.length + 1}. ${who}${text}${failed ? '  ← ❌ fails here' : ''}`);
  }
  return out;
}

const fence = (s: string) => '```\n' + s.replace(/```/g, "'''") + '\n```';
const shortWarning = (w: string) => {
  const first = w.split('\n')[0];
  return first.length > 300 ? `${first.slice(0, 300)}…` : first;
};

function render(d: BugReportData, verdict: Verdict, change: TestChange | undefined, runAgain: string): string {
  const failed = d.steps.find((s) => s.status === 'failed');
  const wrong = section(failed?.error, /^What went wrong:/);
  const activity = section(failed?.error, /backend activity/i);
  const L: string[] = [];

  const headline = wrong[0]?.replace(/\.$/, '');
  L.push(d.status === 'failed'
    ? `# ${d.test}${headline ? `: ${headline}` : ''}`
    : `# Hidden problems in: ${d.test}`);
  L.push('');
  const where = whereFrom(failed?.error);
  if (where) L.push(`> **Where the problem is: ${where.label}.** ${where.why}`, '>');
  L.push(`> **${VERDICT_LABEL[verdict.kind]}.** ${verdict.why}`);
  L.push('');
  L.push('| | |', '|---|---|');
  L.push(`| Test | \`${d.source}\` |`);
  L.push(`| App | ${d.baseURL} |`);
  if (failed?.page) L.push(`| Page | \`${failed.page}\` |`);
  L.push(`| Browser | ${d.browser} |`);
  L.push(`| When | ${new Date(d.at).toLocaleString()} |`);
  L.push('');

  if (failed) {
    L.push('## Steps to reproduce', '', ...reproduce(d.steps.slice(0, d.steps.indexOf(failed) + 1)), '');
    const hit = matchStep(inner(failed.text));
    L.push('## Expected', '', `\`${inner(failed.text)}\``);
    if (hit) L.push('', `(${explainStep(hit.def, hit.args)})`);
    L.push('');
    L.push('## Actual', '', wrong.length ? wrong.join('\n') : fence(failed.error ?? 'The step failed.'), '');
    const calls = failed.calls.length
      ? failed.calls.map((c) => `- \`${c.method} ${c.path}\` → ${c.status ?? 'no reply'}${c.simulated ? ' (simulated by the test)' : ''}`)
      : activity.map((a) => `- \`${a}\``);
    if (calls.length) L.push('## Backend calls since the last action', '', ...calls, '');
  } else {
    L.push('## What the test did', '', ...reproduce(d.steps), '');
  }

  if (d.warnings.length) {
    L.push(failed ? '## Also noticed (watchdog)' : '## The problems (watchdog)', '');
    for (const w of d.warnings) L.push(`- line ${w.line} · ${w.user}: ${shortWarning(w.message)}`);
    L.push('');
  }

  if (change && (change.status === 'changed' || change.status === 'code-only')) {
    L.push('## What changed in the code since it last passed', '');
    // The calls made just before it failed come first: that is where to look.
    // Calls belong to the action that sent them, so: the last two steps up to the failure that sent any.
    const near = failed ? d.steps.slice(0, d.steps.indexOf(failed) + 1).filter((s) => s.calls.length).slice(-2).flatMap((s) => s.calls) : [];
    const isNear = (label: string) => near.some((c) => sameRequest(label, c));
    const changed = change.requests.filter((x) => x.change !== 'same').sort((a, b) => Number(isNear(b.request)) - Number(isNear(a.request)));
    for (const r of changed) {
      L.push(`- **${r.request}**: ${r.change === 'removed' ? 'no longer reached' : r.change === 'added' ? 'new' : 'changed'}${r.problem ? ` (${r.problem})` : ''}${isNear(r.request) ? ' ← called just before it failed' : ''}`);
      const MAX = 6;
      if (r.rules.length > MAX) L.push(`  - (${r.rules.length} rule changes; the first ${MAX}:)`);
      for (const rule of r.rules.slice(0, MAX)) {
        const where = `\`${rule.source.file}:${rule.source.line}\``;
        if (rule.change === 'changed') L.push(`  - was: ${rule.before}`, `    now: ${rule.after} ${where}`);
        else L.push(`  - ${rule.change === 'added' ? 'new' : 'gone'}: ${rule.after ?? rule.before} ${where}`);
      }
      for (const f of r.functions) {
        const commit = !f.lastCommit ? '' : /^not committed/.test(f.lastCommit) ? ' · not committed yet' : ` · last commit ${f.lastCommit}`;
        L.push(`  - code: \`${f.name}\` (${f.change}) \`${f.file}:${f.line}\`${commit}`);
      }
    }
    L.push('');
  }

  L.push('## Evidence', '');
  if (d.screenshot) L.push(`![The page when it failed](${d.screenshot})`, '');
  if (d.playwrightTrace) L.push(`- Every click, request and DOM snapshot: \`npx playwright show-trace ${d.playwrightTrace}\``);
  if (d.replay) L.push(`- Replay video: \`${d.replay}\``);
  L.push(`- Run it again: \`${runAgain}\``);
  L.push('');
  L.push('_Written by HumanTest from the test above._', '');
  return L.join('\n');
}

function index(reports: WrittenReport[], dir: string): string {
  const L = ['# Bug reports from the last run', '', '| | Test | Report |', '|---|---|---|'];
  for (const r of reports) {
    const rel = path.relative(dir, r.file).split(path.sep).join('/');
    L.push(`| ${VERDICT_LABEL[r.verdict.kind]} | ${r.test} (\`${r.source}\`) | [bug-report.md](${encodeURI(rel)}) |`);
  }
  L.push('');
  return L.join('\n');
}

export { VERDICT_LABEL };
