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

/** This folder (if it has a config) plus every pilots/<name>/ with one. */
function discoverProjects(): ProjectRef[] {
  const out: ProjectRef[] = [];
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, 'humantest.config.json'))) out.push({ id: 'main', name: `${path.basename(cwd)} (this folder)`, root: cwd });
  const pilots = path.join(cwd, 'pilots');
  if (fs.existsSync(pilots)) {
    for (const d of fs.readdirSync(pilots, { withFileTypes: true })) {
      const root = path.join(pilots, d.name);
      if (d.isDirectory() && fs.existsSync(path.join(root, 'humantest.config.json'))) out.push({ id: d.name, name: d.name, root });
    }
  }
  return out;
}

const projects = discoverProjects();
const findProject = (id: unknown) => projects.find((p) => p.id === id);

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
  if (built.diagnostics.length) return { error: 'Some .ht files have problems. Fix them first.', diagnostics: built.diagnostics };

  const specToFile = new Map(built.parsed.map((p) => [specFileName(project, p.file), p.relFile]));
  const pwArgs = ['test'];
  const file = opts.key ? opts.key.split('::')[0] : opts.file;
  if (file) {
    const parsed = built.parsed.find((p) => p.relFile === file);
    if (!parsed) return { error: `No test file ${file}` };
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
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(path.join(TOOL_ROOT, 'src', 'ui', 'app.html')));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/projects') {
      return json(res, 200, { projects: projects.map(({ id, name }) => ({ id, name })), running: run ? { project: run.project.id, done: run.done, total: run.total } : null });
    }
    if (req.method === 'GET' && url.pathname === '/api/tests') {
      const ref = findProject(url.searchParams.get('project'));
      if (!ref) return json(res, 404, { error: 'Unknown project' });
      return json(res, 200, { ...listTests(ref), history: readHistory(ref) });
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
