// HumanTest UI: a small local web app to see, run and follow tests in the browser.
//   npm run ui                      (opens http://localhost:4800)
//   npm run ui -- --port 4900 --no-open
// It only listens on 127.0.0.1. Tests run through Playwright exactly like `npm test`;
// the reporter sends live events (HUMANTEST_EVENTS=1) that this server forwards to the page.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build, check, loadProject, specFileName, stepTitle } from '../compiler/index.mts';
import type { Project } from '../compiler/project.mts';

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const PORT = Number(flag('--port') ?? process.env.HUMANTEST_UI_PORT ?? 4800);
const PLAYWRIGHT_CLI = createRequire(path.join(TOOL_ROOT, 'package.json')).resolve('@playwright/test/cli');

// ---------------- projects ----------------

interface ProjectRef { id: string; name: string; root: string }

/** The name people see: "name" in humantest.config.json, or else the folder's name. */
function displayName(root: string): string {
  try {
    const name = JSON.parse(fs.readFileSync(path.join(root, 'humantest.config.json'), 'utf8')).name;
    if (typeof name === 'string' && name.trim()) return name.trim();
  } catch { /* fall back to the folder */ }
  return path.basename(root);
}

/** This folder (if it has a config) plus every pilots/<name>/ with one. */
function discoverProjects(): ProjectRef[] {
  const out: ProjectRef[] = [];
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, 'humantest.config.json'))) out.push({ id: 'main', name: displayName(cwd), root: cwd });
  const pilots = path.join(cwd, 'pilots');
  if (fs.existsSync(pilots)) {
    for (const d of fs.readdirSync(pilots, { withFileTypes: true })) {
      const root = path.join(pilots, d.name);
      if (d.isDirectory() && fs.existsSync(path.join(root, 'humantest.config.json'))) out.push({ id: d.name, name: displayName(root), root });
    }
  }
  return out;
}

const projects = discoverProjects();
const findProject = (id: unknown) => projects.find((p) => p.id === id);

/** Tell the page when someone edits a .ht file (tests or phrases) or the config, so the list updates by itself. */
function watchProjects() {
  for (const ref of projects) {
    let timer: NodeJS.Timeout | undefined;
    const changed = () => {
      clearTimeout(timer);
      timer = setTimeout(() => broadcast({ type: 'tests-changed', project: ref.id }), 250);
    };
    try {
      const project = loadProject(ref.root);
      for (const dir of [project.testsDir, project.phrasesDir]) {
        if (!fs.existsSync(dir)) continue;
        fs.watch(dir, { recursive: true }, (_event, file) => { if (!file || String(file).endsWith('.ht')) changed(); });
      }
      fs.watch(project.configPath, changed);
    } catch (e) {
      console.warn(`Not watching ${ref.name} for changes: ${(e as Error).message}`);
    }
  }
}

// ---------------- business logic (.humantest/discovery, written by `cli.mts discover`) ----------------

const fileSlug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
/** Projects whose rules are being worked out right now (it reads the app's code, a few seconds). */
const discovering = new Set<string>();

/** The business rules behind one test's steps. Same file name as the runtime's trace for it. */
function discoveryFor(ref: ProjectRef, key: string) {
  const project = loadProject(ref.root);
  if (!project.config.source?.backend) return { configured: false };
  const [file, ...rest] = key.split('::');
  const out = path.join(ref.root, '.humantest', 'discovery', `${fileSlug(`${file} ${rest.join('::')}`)}.json`);
  const running = discovering.has(ref.id);
  if (!fs.existsSync(out)) return { configured: true, running };
  return { configured: true, running, at: fs.statSync(out).mtime.toISOString(), result: JSON.parse(fs.readFileSync(out, 'utf8')) };
}

/** After a run: work out the rules behind every traced step, in a separate process so the UI stays quick. */
function runDiscovery(ref: ProjectRef) {
  try {
    if (!loadProject(ref.root).config.source?.backend) return;
  } catch {
    return;
  }
  discovering.add(ref.id);
  broadcast({ type: 'discovery', project: ref.id, state: 'running' });
  const child = spawn(process.execPath, [path.join(TOOL_ROOT, 'src', 'cli.mts'), 'discover', '--project', ref.root], {
    cwd: TOOL_ROOT, env: { ...process.env, FORCE_COLOR: '0' },
  });
  let out = '';
  child.stdout?.on('data', (d) => { out += d; });
  child.stderr?.on('data', (d) => { out += d; });
  child.on('close', (code) => {
    discovering.delete(ref.id);
    if (code) broadcast({ type: 'log', line: `Working out the business rules failed:\n${out.slice(-2000)}` });
    broadcast({ type: 'discovery', project: ref.id, state: 'done' });
    computeChanges(ref);
    computeCoverage(ref);
  });
}

// ---------------- changes in the business logic since it was accepted (e2e/logic/) ----------------

interface ChangesState { computing: boolean; at?: string; tests: unknown[]; error?: string; again?: boolean }
const changesOf = new Map<string, ChangesState>();

const cli = (ref: ProjectRef, extra: string[]) =>
  spawn(process.execPath, [path.join(TOOL_ROOT, 'src', 'cli.mts'), 'discover', ...extra, '--project', ref.root], {
    cwd: TOOL_ROOT, env: { ...process.env, FORCE_COLOR: '0' },
  });

/** Compares the current code with each test's accepted logic, in a separate process (it reads all the code). */
function computeChanges(ref: ProjectRef) {
  try {
    if (!loadProject(ref.root).config.source?.backend) return;
  } catch {
    return;
  }
  const state = changesOf.get(ref.id) ?? { computing: false, tests: [] };
  changesOf.set(ref.id, state);
  // Already working: do it once more afterwards, with the newest code.
  if (state.computing) { state.again = true; return; }
  state.computing = true;
  const child = cli(ref, ['--changes', '--json']);
  let out = '';
  let err = '';
  child.stdout?.on('data', (d) => { out += d; });
  child.stderr?.on('data', (d) => { err += d; });
  child.on('close', (code) => {
    state.computing = false;
    try {
      // The JSON is the last line; anything before it is the CLI's own notes.
      const last = out.trim().split(/\r?\n/).pop() ?? '';
      state.tests = last.startsWith('[') ? JSON.parse(last) : [];
      state.error = undefined;
      state.at = new Date().toISOString();
    } catch {
      state.error = `Could not compare the business logic (exit ${code}). ${err.slice(-500)}`;
    }
    broadcast({ type: 'changes', project: ref.id });
    if (state.again) { state.again = false; computeChanges(ref); }
  });
}

// ---------------- what the tests don't cover (discover --gaps), with draft tests ----------------

interface CoverageState { computing: boolean; at?: string; report?: unknown; error?: string; again?: boolean }
const coverageOf = new Map<string, CoverageState>();

/** Works out the coverage again, in a separate process (it reads all the code). */
function computeCoverage(ref: ProjectRef) {
  try {
    if (!loadProject(ref.root).config.source?.backend) return;
  } catch {
    return;
  }
  const state = coverageOf.get(ref.id) ?? { computing: false };
  coverageOf.set(ref.id, state);
  if (state.computing) { state.again = true; return; }
  state.computing = true;
  broadcast({ type: 'coverage', project: ref.id });
  const child = cli(ref, ['--gaps', '--drafts', '--json']);
  let out = '';
  let err = '';
  child.stdout?.on('data', (d) => { out += d; });
  child.stderr?.on('data', (d) => { err += d; });
  child.on('close', (code) => {
    state.computing = false;
    try {
      // The JSON starts on a line of its own; anything before it is the CLI's own notes.
      const start = out.search(/^{/m);
      state.report = JSON.parse(out.slice(start));
      state.error = undefined;
      state.at = new Date().toISOString();
    } catch {
      state.error = `Could not work out what the tests cover (exit ${code}). ${err.slice(-500)}`;
    }
    broadcast({ type: 'coverage', project: ref.id });
    if (state.again) { state.again = false; computeCoverage(ref); }
  });
}

/**
 * Saves a draft test as a new file in the tests folder (tests/drafts/<name>.ht), never over an
 * existing one, so it can be opened and finished in an editor. Says if the file needs fixing.
 */
function saveDraft(ref: ProjectRef, text: string) {
  const project = loadProject(ref.root);
  const name = text.match(/^(?:Test|Draft):\s*(.+)$/m)?.[1] ?? 'draft';
  const dir = path.join(project.testsDir, 'drafts');
  fs.mkdirSync(dir, { recursive: true });
  const slug = fileSlug(name).slice(0, 60) || 'draft';
  let file = path.join(dir, `${slug}.ht`);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${slug}-${n}.ht`);
  fs.writeFileSync(file, `${text.trimEnd()}\n`);
  const rel = path.relative(ref.root, file).split(path.sep).join('/');
  const diagnostics = check(project).parsed.find((p) => p.file === file)?.diagnostics ?? [];
  return { file: rel, path: file, diagnostics };
}

/** Re-compare whenever someone edits the backend's code: the badge shows up within seconds of saving. */
function watchBackends() {
  for (const ref of projects) {
    let dirs: string[] = [];
    try {
      const source = loadProject(ref.root).config.source;
      if (!source?.backend) continue;
      dirs = [source.backend, source.frontend].filter((d): d is string => !!d).map((d) => path.resolve(ref.root, d)).filter((d) => fs.existsSync(d));
    } catch {
      continue;
    }
    let timer: NodeJS.Timeout | undefined;
    for (const dir of dirs) {
      try {
        fs.watch(dir, { recursive: true }, (_e, file) => {
          const f = String(file ?? '');
          if (!/\.[cm]?[jt]sx?$/.test(f) || /(^|[\\/])(node_modules|dist|build|coverage|\.next)[\\/]/.test(f)) return;
          clearTimeout(timer);
          timer = setTimeout(() => { computeChanges(ref); computeCoverage(ref); }, 2000);
        });
      } catch (e) {
        console.warn(`Not watching ${dir} for changes: ${(e as Error).message}`);
      }
    }
    computeChanges(ref);
    computeCoverage(ref);
  }
}

function acceptChanges(ref: ProjectRef, key: string | undefined, done: (ok: boolean, message: string) => void) {
  const child = cli(ref, ['--accept', '--json', ...(key ? ['--key', key] : [])]);
  let out = '';
  child.stdout?.on('data', (d) => { out += d; });
  child.stderr?.on('data', (d) => { out += d; });
  child.on('close', (code) => {
    done(code === 0, code === 0 ? 'Accepted.' : out.slice(-500));
    computeChanges(ref);
  });
}

// ---------------- history (per project, in .humantest/history.json) ----------------

interface TestResult {
  key: string;
  status: string;
  duration: number;
  errors: string[];
  watchdog: string[];
  replay?: string;
  sideBySide?: string;
  steps: { title: string; status: string; duration: number; error?: string }[];
  finishedAt: string;
  demo: boolean;
}
interface History { last: Record<string, TestResult>; runs: { at: string; demo: boolean; results: Record<string, string> }[] }

const historyFile = (p: ProjectRef) => path.join(p.root, '.humantest', 'history.json');
function readHistory(p: ProjectRef): History {
  try { return JSON.parse(fs.readFileSync(historyFile(p), 'utf8')); } catch { return { last: {}, runs: [] }; }
}
function writeHistory(p: ProjectRef, h: History) {
  fs.mkdirSync(path.dirname(historyFile(p)), { recursive: true });
  h.runs = h.runs.slice(-30);
  fs.writeFileSync(historyFile(p), JSON.stringify(h, null, 1));
}

// ---------------- reading tests ----------------

function listTests(ref: ProjectRef) {
  const project = loadProject(ref.root);
  const result = check(project);
  const byFile = new Set(result.parsed.map((p) => p.relFile));
  return {
    files: result.parsed.map((pf) => ({
      file: pf.relFile,
      spec: specFileName(project, pf.file),
      diagnostics: pf.diagnostics,
      tests: pf.tests.map((t) => ({
        key: `${pf.relFile}::${t.name}`,
        name: t.name,
        line: t.line,
        users: t.users.map((u) => u.name),
        state: t.state?.name,
        ...(t.draft ? { draft: true } : {}),
        steps: t.steps.map((st) => ({ line: st.line, user: st.user, text: st.text, story: st.story?.text, title: stepTitle(st) })),
      })),
    })),
    // Problems outside the test files (e.g. in phrases).
    problems: result.diagnostics.filter((d) => !byFile.has(d.file)),
  };
}

// ---------------- running ----------------

interface Run { project: ProjectRef; demo: boolean; child: ChildProcess; specToFile: Map<string, string>; results: Record<string, string>; total: number; done: number }
let run: Run | undefined;

const clients = new Set<http.ServerResponse>();
function broadcast(event: Record<string, unknown>) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const c of clients) c.write(data);
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function startRun(ref: ProjectRef, opts: { key?: string; file?: string; demo: boolean }) {
  const project: Project = loadProject(ref.root);
  const built = build(project);
  if (built.diagnostics.length) return { error: 'Some tests need fixing before anything can run.', diagnostics: built.diagnostics };

  const specToFile = new Map(built.parsed.map((p) => [specFileName(project, p.file), p.relFile]));
  const pwArgs = ['test'];
  const file = opts.key ? opts.key.split('::')[0] : opts.file;
  if (file) {
    const parsed = built.parsed.find((p) => p.relFile === file);
    if (!parsed) return { error: 'That test file no longer exists. Refresh the page.' };
    // Playwright reads file arguments as regexes, so a Windows path (backslashes) would match nothing.
    pwArgs.push(`${escapeRegex(specFileName(project, parsed.file))}$`);
  }
  if (opts.key) pwArgs.push('--grep', `${escapeRegex(opts.key.split('::').slice(1).join('::'))}$`);

  const child = spawn(process.execPath, [PLAYWRIGHT_CLI, ...pwArgs], {
    cwd: ref.root,
    env: { ...process.env, HUMANTEST_EVENTS: '1', FORCE_COLOR: '0', ...(opts.demo ? { HUMANTEST_DEMO: '1' } : {}) },
  });
  run = { project: ref, demo: opts.demo, child, specToFile, results: {}, total: 0, done: 0 };
  const thisRun = run;
  broadcast({ type: 'run-start', project: ref.id, demo: opts.demo, scope: opts.key ?? opts.file ?? 'all' });

  const keyOf = (e: any) => `${specToFile.get(e.spec) ?? e.spec}::${e.title}`;
  const onLine = (line: string) => {
    if (!line.startsWith('@@HT@@')) {
      if (line.trim()) broadcast({ type: 'log', line: line.replace(/\u001b\[[0-9;]*m/g, '') });
      return;
    }
    let e: any;
    try { e = JSON.parse(line.slice(6)); } catch { return; }
    if (e.type === 'begin') { thisRun.total = e.total; broadcast({ type: 'progress', done: 0, total: e.total }); }
    if (e.type === 'test-begin') broadcast({ type: 'test-begin', key: keyOf(e) });
    if (e.type === 'step') broadcast({ type: 'step', key: keyOf(e), step: e.step });
    if (e.type === 'test-end') {
      const key = keyOf(e);
      const toUrl = (p?: string) => (p ? `/files/${ref.id}/${p.split(path.sep).join('/')}` : undefined);
      const result: TestResult = {
        key, status: e.status, duration: e.duration, errors: e.errors, watchdog: e.watchdog,
        replay: toUrl(e.replay), sideBySide: toUrl(e.sideBySide), steps: e.steps,
        finishedAt: new Date().toISOString(), demo: thisRun.demo,
      };
      thisRun.results[key] = e.status;
      thisRun.done++;
      const h = readHistory(ref);
      h.last[key] = result;
      writeHistory(ref, h);
      broadcast({ type: 'test-end', key, result, done: thisRun.done, total: thisRun.total });
    }
  };
  let buf = '';
  child.stdout?.on('data', (d) => {
    buf += d.toString();
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? '';
    lines.forEach(onLine);
  });
  child.stderr?.on('data', (d) => d.toString().split(/\r?\n/).filter(Boolean).forEach((l: string) => broadcast({ type: 'log', line: l })));
  child.on('close', (code) => {
    if (buf) onLine(buf);
    if (thisRun.done === 0 && code !== 0) broadcast({ type: 'log', line: `Playwright exited with code ${code} before any test ran. See the output above.` });
    const h = readHistory(ref);
    if (Object.keys(thisRun.results).length) h.runs.push({ at: new Date().toISOString(), demo: thisRun.demo, results: thisRun.results });
    writeHistory(ref, h);
    run = undefined;
    broadcast({ type: 'run-end', code });
    if (thisRun.done > 0) runDiscovery(ref);
  });
  return { ok: true };
}

function stopRun() {
  if (!run?.child.pid) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(run.child.pid), '/t', '/f']);
  else run.child.kill('SIGTERM');
}

// ---------------- files (videos and replays), with Range support for seeking ----------------

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.mp4': 'video/mp4', '.webm': 'video/webm', '.json': 'application/json' };

function serveFile(req: http.IncomingMessage, res: http.ServerResponse, ref: ProjectRef, relPath: string) {
  const base = path.join(ref.root, 'humantest-videos');
  const file = path.resolve(ref.root, decodeURIComponent(relPath));
  if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end('Not found');
    return;
  }
  const size = fs.statSync(file).size;
  const type = TYPES[path.extname(file)] ?? 'application/octet-stream';
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Number(range[2]) : size - 1;
    res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes', 'content-length': end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes' });
    fs.createReadStream(file).pipe(res);
  }
}

// ---------------- the React app (ui/dist, built by `npm run build -w ui`) ----------------

const APP_DIR = path.join(TOOL_ROOT, 'ui', 'dist');
const APP_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};

function serveApp(res: http.ServerResponse, pathname: string) {
  const index = path.join(APP_DIR, 'index.html');
  if (!fs.existsSync(index)) {
    res.writeHead(503, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<p style="font:16px system-ui;padding:40px">The HumanTest UI isn\'t built yet. Run <code>npm run ui</code> (it builds it first), or <code>npm run build -w ui</code>.</p>');
    return;
  }
  const file = path.resolve(APP_DIR, '.' + decodeURIComponent(pathname));
  const isFile = file.startsWith(APP_DIR + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile();
  const target = isFile ? file : index;   // unknown paths get the app itself
  const hashed = target.includes(`${path.sep}assets${path.sep}`);
  res.writeHead(200, {
    'content-type': APP_TYPES[path.extname(target)] ?? 'application/octet-stream',
    'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  fs.createReadStream(target).pipe(res);
}

// ---------------- HTTP ----------------

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
async function readBody(req: http.IncomingMessage): Promise<any> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/files/')) {
      return serveApp(res, url.pathname);
    }
    if (req.method === 'GET' && url.pathname === '/api/projects') {
      return json(res, 200, { projects: projects.map(({ id, name }) => ({ id, name })), running: run ? { project: run.project.id, done: run.done, total: run.total } : null });
    }
    if (req.method === 'GET' && url.pathname === '/api/tests') {
      const ref = findProject(url.searchParams.get('project'));
      if (!ref) return json(res, 404, { error: 'Unknown project' });
      return json(res, 200, { ...listTests(ref), history: readHistory(ref) });
    }
    if (req.method === 'GET' && url.pathname === '/api/discovery') {
      const ref = findProject(url.searchParams.get('project'));
      if (!ref) return json(res, 404, { error: 'Unknown project' });
      return json(res, 200, discoveryFor(ref, url.searchParams.get('key') ?? ''));
    }
    if (req.method === 'GET' && url.pathname === '/api/changes') {
      const ref = findProject(url.searchParams.get('project'));
      if (!ref) return json(res, 404, { error: 'Unknown project' });
      return json(res, 200, changesOf.get(ref.id) ?? { computing: false, tests: [] });
    }
    if (req.method === 'GET' && url.pathname === '/api/coverage') {
      const ref = findProject(url.searchParams.get('project'));
      if (!ref) return json(res, 404, { error: 'Unknown project' });
      return json(res, 200, coverageOf.get(ref.id) ?? { computing: false });
    }
    if (req.method === 'POST' && url.pathname === '/api/draft') {
      const body = await readBody(req);
      const ref = findProject(body.project);
      if (!ref) return json(res, 404, { error: 'Unknown project' });
      if (typeof body.text !== 'string' || !/^(Test|Draft):/m.test(body.text)) return json(res, 400, { error: 'That is not a draft test.' });
      return json(res, 200, saveDraft(ref, body.text));
    }
    if (req.method === 'POST' && url.pathname === '/api/accept') {
      const body = await readBody(req);
      const ref = findProject(body.project);
      if (!ref) return json(res, 404, { error: 'Unknown project' });
      return acceptChanges(ref, typeof body.key === 'string' ? body.key : undefined, (ok, message) => json(res, ok ? 200 : 500, ok ? { ok } : { error: message }));
    }
    if (req.method === 'POST' && url.pathname === '/api/run') {
      const body = await readBody(req);
      const ref = findProject(body.project);
      if (!ref) return json(res, 404, { error: 'Unknown project' });
      if (run) return json(res, 409, { error: 'A run is already going. Wait for it, or stop it.' });
      const r = startRun(ref, { key: body.key, file: body.file, demo: !!body.demo });
      return json(res, 'error' in r ? 400 : 200, r);
    }
    if (req.method === 'POST' && url.pathname === '/api/stop') {
      stopRun();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    const m = url.pathname.match(/^\/files\/([^/]+)\/(.+)$/);
    if (req.method === 'GET' && m) {
      const ref = findProject(m[1]);
      if (!ref) return json(res, 404, { error: 'Unknown project' });
      return serveFile(req, res, ref, m[2]);
    }
    json(res, 404, { error: 'Not found' });
  } catch (e) {
    json(res, 500, { error: String((e as Error).message ?? e) });
  }
});

setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 20_000).unref();
watchProjects();
watchBackends();

server.listen(PORT, '127.0.0.1', () => {
  const link = `http://localhost:${PORT}`;
  console.log(`HumanTest UI: ${link}`);
  console.log(`Projects: ${projects.map((p) => p.name).join(', ') || 'none found'}`);
  if (!args.includes('--no-open')) {
    const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', link]] as const
      : process.platform === 'darwin' ? ['open', [link]] as const : ['xdg-open', [link]] as const;
    spawn(opener[0], [...opener[1]], { stdio: 'ignore', detached: true }).unref();
  }
});
