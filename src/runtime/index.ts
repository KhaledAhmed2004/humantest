// HumanTest runtime: what the generated Playwright specs call.
// - every user gets their own browser context (separate login, cookies, video)
// - every API call the page makes is recorded, so tests can check the backend
// - a watchdog reports hidden problems (5xx, JS errors, slow APIs) even when nobody asserted them
// - demo mode (HUMANTEST_DEMO=1) slows things down and shows captions for readable videos

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { encodeFrames, hasFfmpeg, sideBySide, toMp4, writeReplay, type Frame, type ReplayStep } from './replay';
import path from 'node:path';
import {
  test, expect, request as apiRequest,
  type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page,
  type Request, type Response, type TestInfo,
} from '@playwright/test';

const DEMO = !!process.env.HUMANTEST_DEMO;
// What "type …" and "choose …" can fill in. Radix's hidden native <select> only mirrors the real dropdown.
const FIELD_CSS = 'input:not([type=hidden]):not([type=file]):not([type=checkbox]):not([type=radio]), textarea, select:not([aria-hidden=true]), [role=combobox]';

interface Config {
  baseURL: string;
  apiPrefix?: string;
  /**
   * Hosts the page may send API calls to, e.g. ["localhost:5000"]. A call anywhere else is blocked
   * and fails the test, so a frontend that still points at a real server can't change its data.
   */
  apiHosts?: string[];
  login?: {
    endpoint: string;
    /** For apps that keep the token in a cookie they set themselves: where the token is in the reply. */
    tokenCookie?: { name: string; from: string };
    /**
     * Keep logins between runs, in .humantest/sessions.json (never commit it), so running the tests
     * again soon doesn't log everyone in again. A login is kept until its token expires, at most
     * 10 minutes. Off unless set.
     */
    keepBetweenRuns?: boolean;
  };
  users: Record<string, { email?: string; password?: string }>;
  elements?: Record<string, string>;
  watchdog?: { failTestOnWarning?: boolean; slowApiMs?: number };
  demo?: { pauseAfterStepMs?: number; typingDelayMs?: number };
  accessibility?: { tags?: string[]; ignoreRules?: string[]; ignoreWhenModalOpen?: string[] };
}

export interface StateContext {
  /** Backend client with baseURL already set, e.g. `api.post('/api/test/reset')`. */
  api: APIRequestContext;
  /** The "quoted" values from the Start with: line. */
  args: string[];
  /**
   * The login token of a user from the config (`login.tokenCookie.from` in the login reply),
   * e.g. `headers: { Authorization: \`Bearer ${await token('admin')}\` }`. Shares the tests' login.
   */
  token: (user: string) => Promise<string>;
}
export type StateFn = (ctx: StateContext) => Promise<void>;
/**
 * A state file: its default export sets the data up. `export const logsOut = true` when it resets
 * the users or their sessions (a fresh database): logins from before it then no longer work, so
 * HumanTest logs in again after it. Otherwise logins are kept (backends limit how many there are).
 */
export type StateModule = { default: StateFn; logsOut?: boolean };

interface Session { cookies: Awaited<ReturnType<BrowserContext['cookies']>>; token?: string; at: number }
// One login per user per run (per Playwright worker). Access tokens usually live 15 minutes or more.
const SESSIONS = new Map<string, Session>();
const SESSION_REUSE_MS = 10 * 60_000;
/** A kept login must still work for this long, or HumanTest logs in again. */
const TOKEN_MARGIN_MS = 2 * 60_000;
const SESSIONS_FILE = () => path.join(process.cwd(), '.humantest', 'sessions.json');

/** When a JWT expires (its `exp`), or undefined when the token isn't a JWT. */
function tokenExpiry(token?: string): number | undefined {
  try {
    const exp = JSON.parse(Buffer.from(token!.split('.')[1], 'base64url').toString('utf8')).exp;
    return typeof exp === 'number' ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a login can still be used: not older than SESSION_REUSE_MS, and its token not about to expire. */
function fresh(s: Session): boolean {
  const exp = tokenExpiry(s.token);
  return Date.now() - s.at < SESSION_REUSE_MS && (exp === undefined || exp - Date.now() > TOKEN_MARGIN_MS);
}

/** The key a login is kept under on disk: a hash, so the file never holds a password. */
const diskKey = (key: string) => createHash('sha256').update(key).digest('hex');

/** Logins kept by earlier runs (`login.keepBetweenRuns`). Unreadable or missing: none. */
function readKept(): Record<string, Session> {
  try {
    return JSON.parse(fs.readFileSync(SESSIONS_FILE(), 'utf8'));
  } catch {
    return {};
  }
}

/** Writes the file whole (to a temporary file, then renamed), so a parallel worker never reads half of it. */
function writeKept(kept: Record<string, Session>) {
  const file = SESSIONS_FILE();
  const live = Object.fromEntries(Object.entries(kept).filter(([, s]) => fresh(s)));
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // The file holds working logins: git must never pick it up, even where .humantest isn't ignored.
    const ignore = path.join(path.dirname(file), '.gitignore');
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, 'sessions.json\n');
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(live));
    fs.renameSync(tmp, file);
  } catch {
    /* Keeping logins only saves time; a run never fails over it. */
  }
}

function forgetKept() {
  try { fs.rmSync(SESSIONS_FILE(), { force: true }); } catch { /* nothing kept */ }
}

interface Options { browser: Browser; testInfo: TestInfo; configPath: string; source: string; line: number }

export async function humantest(opts: Options, body: (ht: Scenario) => Promise<void>) {
  const config = JSON.parse(fs.readFileSync(opts.configPath, 'utf8')) as Config;
  const ht = new Scenario(opts, config);
  opts.testInfo.annotations.push({ type: 'source', description: `${opts.source}:${opts.line}` });
  let passed = false;
  try {
    await body(ht);
    passed = true;
  } finally {
    await ht.finish(passed);
  }
}

class HumanError extends Error {
  readonly humantest = true;
}

const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');
const fileSlug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const short = (v: unknown, max = 300) => {
  const t = typeof v === 'string' ? v : JSON.stringify(v);
  return t && t.length > max ? `${t.slice(0, max)}…` : t;
};
/**
 * {today}, {tomorrow}, {yesterday}, {in 3 days}, {3 days ago} in a step's text: that date on the
 * test machine, as YYYY-MM-DD. Tests that need "a day with trips" keep working as days pass.
 */
export function withDates(text: string): string {
  return text.replace(/{(today|tomorrow|yesterday|in (\d+) days?|(\d+) days? ago)}/gi, (_m, word: string, ahead?: string, back?: string) => {
    const shift = ahead ? Number(ahead) : back ? -Number(back) : ({ today: 0, tomorrow: 1, yesterday: -1 } as Record<string, number>)[word.toLowerCase()];
    const d = new Date();
    d.setDate(d.getDate() + shift);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** `a.b[0].c` inside a parsed JSON reply. */
const pick = (obj: unknown, dotted: string) =>
  dotted.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean).reduce<any>((v, k) => (v == null ? undefined : v[k]), obj);

interface Warning { line: number; user: string; message: string }

/** One API call, as written to the trace file. Only names of query and body fields, never their values. */
export interface TraceCall {
  method: string;
  path: string;
  query: string[];
  bodyKeys: string[];
  status?: number;
  simulated?: boolean;
  /** The page the user was on when the call was sent. */
  pageUrl?: string;
}

export interface TraceStep {
  /** Same title as the Playwright step, so the reporter can match them. */
  title: string;
  user: string;
  line: number;
  text: string;
  status: 'passed' | 'failed';
  calls: TraceCall[];
  /** The page (path) the step ended on. */
  pageUrl?: string;
}

export interface Trace { version: 1; test: string; source: string; status: 'passed' | 'failed'; steps: TraceStep[] }

export class Scenario {
  readonly users: User[] = [];
  readonly warnings: Warning[] = [];
  /** Error replies a step checked (`backend should reply 409`): the page complaining about them is expected. */
  readonly expectedErrors: { user: string; method: string; path: string; status: number }[] = [];
  /** Every step with its timing, for the replay. */
  readonly records: ReplayStep[] = [];
  /** When each user's video started recording (ms since epoch). */
  readonly videoStarts = new Map<string, number>();
  currentLine = 0;
  /** Set when an API call went to a host outside `apiHosts`. The test fails at the end of the step. */
  blocked?: string;
  /** The page (path) each step ended on, by index into `records`: discovery finds the page's code from it. */
  readonly stepPages: (string | undefined)[] = [];

  constructor(readonly opts: Options, readonly config: Config) {}

  /** Whether an API call to this URL is allowed by `apiHosts` (always, when it isn't set). */
  allowsHost(url: string): boolean {
    const hosts = this.config.apiHosts;
    if (!hosts?.length) return true;
    try {
      const u = new URL(url, this.config.baseURL);
      return hosts.includes(u.host) || hosts.includes(u.hostname);
    } catch {
      return false;
    }
  }

  /**
   * Where `call GET /api/...` goes. A path is the app's own address, unless the API is on one other
   * host (`apiHosts`, and the app itself is not on it): then it is that host's.
   */
  apiURL(pathname: string): URL {
    const base = new URL(this.config.baseURL);
    const hosts = this.config.apiHosts ?? [];
    if (/^https?:\/\//i.test(pathname) || hosts.length !== 1 || hosts.includes(base.host) || hosts.includes(base.hostname)) {
      return new URL(pathname, base);
    }
    return new URL(pathname, `${base.protocol}//${hosts[0]}`);
  }

  blockedError(url: string, who: 'page' | 'login' | 'call' = 'page'): string {
    const allowed = `not one of the allowed API hosts (${this.config.apiHosts!.join(', ')})`;
    if (who === 'login') {
      return `The login endpoint ${url} is ${allowed}, so HumanTest did not log in there.\n` +
        `Change "login.endpoint" or "apiHosts" in humantest.config.json.`;
    }
    return `${who === 'call' ? 'This step' : 'The page'} tried to call ${url}, which is ${allowed}.\n` +
      `The call was blocked, so nothing changed there. Point the frontend at your local backend, ` +
      `or add the host to "apiHosts" in humantest.config.json if it is safe to change.`;
  }

  warn(user: string, message: string) {
    if (this.warnings.some((w) => w.message === message && w.user === user)) return;
    this.warnings.push({ line: this.currentLine, user, message });
  }

  async startWith(line: number, name: string, args: string[], state: StateFn | StateModule) {
    const fn = typeof state === 'function' ? state : state.default;
    this.currentLine = line;
    const rec: ReplayStep = { user: 'setup', line, text: `start with: ${name}`, start: Date.now(), end: 0, status: 'passed' };
    this.records.push(rec);
    await test.step(`line ${line} · start with: ${name}`, async () => {
      const api = await apiRequest.newContext({ baseURL: this.config.baseURL });
      try {
        const token = async (user: string) => {
          const t = (await this.login(user)).token;
          if (!t) throw new Error('token() needs "login.tokenCookie" in humantest.config.json, to know where the token is in the login reply.');
          return t;
        };
        await fn({ api, args, token });
        // After it: the logins from before it (and from inside it) may no longer work.
        if (typeof state !== 'function' && state.logsOut) {
          SESSIONS.clear();
          forgetKept();
        }
      } catch (e) {
        rec.status = 'failed';
        const err = this.humanError(line, 'setup', `Start with: ${name}`, e);
        rec.error = err.message;
        throw err;
      } finally {
        rec.end = Date.now();
        await api.dispose();
      }
    }, { box: true });
  }

  async user(line: number, name: string): Promise<User> {
    const info = this.opts.testInfo;
    // Demo videos: with ffmpeg, we record screencast frames that carry their exact paint time,
    // so the replay lines videos and steps up to a few ms. Without ffmpeg, Playwright's own video.
    const useScreencast = DEMO && hasFfmpeg();
    const context = await this.opts.browser.newContext({
      baseURL: this.config.baseURL,
      viewport: { width: 1280, height: 720 },
      recordVideo: DEMO && !useScreencast ? { dir: info.outputPath(`videos-${fileSlug(name)}`), size: { width: 1280, height: 720 } } : undefined,
    });
    const page = await context.newPage();
    if (DEMO) {
      // Tells whoever watches the replay that this user is waiting for their turn.
      // (It also makes Playwright's own video start now: it only starts on the first paint.)
      const label = name.replace(/[&<>"]/g, '');
      await page.setContent(`<body style="margin:0;display:grid;place-items:center;height:100vh;background:#f3f4f6;` +
        `font:600 30px system-ui,sans-serif;color:#6b7280">👤 ${label} · waiting</body>`);
    }
    this.videoStarts.set(name, Date.now());
    const recorder = useScreencast ? new FrameRecorder(page, info.outputPath(`frames-${fileSlug(name)}`)) : undefined;
    await recorder?.start();
    const u = new User(this, name, context, page, recorder);
    await u.init();
    this.users.push(u);

    if (this.config.users[name]?.email) {
      await test.step(`line ${line} · log in as ${name} (${this.config.users[name].email})`, async () => {
        try {
          await context.addCookies((await this.login(name)).cookies);
        } catch (e) {
          throw this.humanError(line, name, `log in as ${name}`, e);
        }
      }, { box: true });
    }
    return u;
  }

  /**
   * Log a user in, once per run: later tests (and states) reuse the session, because backends
   * often allow only a few logins a minute. Kept in memory, and with `login.keepBetweenRuns` also in
   * .humantest/sessions.json for the next runs (the token and cookies, never the password).
   */
  async login(name: string): Promise<Session> {
    const creds = this.config.users[name] ?? {};
    if (!creds.email) throw new Error(`The user "${name}" has no email/password in humantest.config.json, so HumanTest can't log them in.`);
    const endpoint = this.config.login?.endpoint ?? '/api/login';
    const url = new URL(endpoint, this.config.baseURL).toString();
    const key = `${url}|${creds.email}|${creds.password}`;
    const cached = SESSIONS.get(key);
    if (cached && fresh(cached)) return cached;
    const keep = !!this.config.login?.keepBetweenRuns;
    if (keep) {
      const kept = readKept()[diskKey(key)];
      if (kept && fresh(kept)) {
        SESSIONS.set(key, kept);
        return kept;
      }
    }
    if (!this.allowsHost(url)) throw new Error(this.blockedError(url, 'login'));

    const api = await apiRequest.newContext();
    try {
      const res = await api.post(url, { data: { email: creds.email, password: creds.password } });
      if (!res.ok()) {
        const why = res.status() === 429
          ? 'The backend refuses more logins for now (too many in a short time). Wait a minute and run again.'
          : `Check the email/password for "${name}" in humantest.config.json.`;
        throw new Error(`${endpoint} replied ${res.status()}: ${short(await res.text())}\n${why}`);
      }
      const cookies = (await api.storageState()).cookies;
      let token: string | undefined;
      const tc = this.config.login?.tokenCookie;
      if (tc) {
        let t: unknown;
        try { t = pick(await res.json(), tc.from); } catch { /* not JSON */ }
        if (typeof t !== 'string' || !t) {
          throw new Error(`${endpoint} replied ${res.status()}, but there is no token at "${tc.from}" in the reply.\n` +
            `Check "login.tokenCookie.from" in humantest.config.json. The reply was: ${short(await res.text())}`);
        }
        token = t;
        cookies.push({ name: tc.name, value: t, domain: new URL(this.config.baseURL).hostname, path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' });
      }
      const session: Session = { cookies, token, at: Date.now() };
      SESSIONS.set(key, session);
      if (keep) writeKept({ ...readKept(), [diskKey(key)]: session });
      return session;
    } finally {
      await api.dispose();
    }
  }

  humanError(line: number, user: string, text: string, err: unknown, u?: User): Error {
    if ((err as any)?.humantest) return err as Error;
    const raw = stripAnsi(String((err as any)?.message ?? err)).split(/\n\s*Call log:/)[0];
    // Our own sentence explains the problem; Playwright's locator details belong in the trace, not here.
    const NOISE = /^\s*(Locator:|Expected:|Received:|Timeout:|Error: element\(s\) not found|expect\(.*\)\.\w+\(.*\) failed)/;
    const lines = raw.split('\n').map((l) => l.trimEnd()).filter(Boolean);
    const clean = lines.filter((l) => !NOISE.test(l));
    const why = (clean.length ? clean : lines).slice(0, 10).map((l) => `      ${l}`).join('\n');
    const parts = [
      `Line ${line} · ${user} · ${text}`,
      ``,
      `   What went wrong:`,
      why,
    ];
    if (u) {
      const activity = u.log.filter((e) => e.line === line);
      const shown = activity.length ? activity : u.log.slice(-5);
      if (shown.length) {
        parts.push('', activity.length ? '   Backend activity during this step:' : '   Latest backend activity:');
        for (const e of shown) parts.push(`      ${e.method} ${e.path} → ${e.status ?? 'no reply'}${e.mocked ? ' (simulated)' : ''}`);
      }
      // A login kept from an earlier run stops working when the backend forgets it (a fresh database, a new secret).
      if (this.config.login?.keepBetweenRuns && u.log.some((e) => e.status === 401)) {
        parts.push('', `   This login may be one kept from an earlier run that the backend no longer accepts.`,
          `   Delete .humantest/sessions.json and run again to log in afresh.`);
      }
    }
    parts.push('', `   📄 ${this.opts.source}:${line}`);
    const out = new HumanError(parts.join('\n'));
    out.stack = out.message;
    return out;
  }

  async finish(passed: boolean) {
    const info = this.opts.testInfo;
    this.dropExpected();
    const videoDir = path.join(process.cwd(), 'humantest-videos', fileSlug(info.title));
    const saved: { user: string; file: string; started: number; burnedCaptions?: boolean }[] = [];
    for (const u of this.users) {
      if (u.recorder) {
        // Screencast: the video starts at its first frame's own timestamp.
        fs.mkdirSync(videoDir, { recursive: true });
        const rec = await u.recorder.stop(path.join(videoDir, `${fileSlug(u.name)}.mp4`));
        await u.context.close().catch(() => {});
        if (rec) {
          saved.push({ user: u.name, ...rec });
          await info.attach(`🎬 ${u.name}`, { path: rec.file, contentType: 'video/mp4' });
        }
        continue;
      }
      const video = u.page.video();
      await u.context.close().catch(() => {});
      if (!video) continue;
      fs.mkdirSync(videoDir, { recursive: true });
      const webm = path.join(videoDir, `${fileSlug(u.name)}.webm`);
      await video.saveAs(webm).catch(() => {});
      if (!fs.existsSync(webm)) continue;
      const mp4 = webm.replace(/\.webm$/, '.mp4');
      const file = toMp4(webm, mp4) ? (fs.rmSync(webm), mp4) : webm;
      // Playwright's video starts on the page's first paint, which happens right when the page is made
      // (the "waiting" screen). Measured: within ~20-80 ms. (Its length can't be used: the last
      // ~1.4 s after the final change aren't written, which would put the video 1.5 s ahead.)
      const started = this.videoStarts.get(u.name) ?? Date.now();
      saved.push({ user: u.name, file, started, burnedCaptions: true });
      await info.attach(`🎬 ${u.name}`, { path: file, contentType: file.endsWith('.mp4') ? 'video/mp4' : 'video/webm' });
    }

    if (saved.length) {
      const zero = Math.min(...saved.map((s) => s.started));
      const at = (ms: number) => ms - zero;
      const videos = saved.map((s) => ({ user: s.user, file: path.basename(s.file), offset: at(s.started), burnedCaptions: s.burnedCaptions }));
      const replay = writeReplay(videoDir, {
        title: info.title,
        source: `${this.opts.source}:${this.opts.line}`,
        status: passed ? 'passed' : 'failed',
        videos,
        steps: this.records.map((r) => ({ ...r, start: at(r.start), end: at(r.end || Date.now()) })),
        requests: this.users.flatMap((u) => u.log.map((e) => ({
          user: u.name, method: e.method, path: e.path, status: e.status, at: at(e.at), simulated: e.mocked,
        }))),
        warnings: this.warnings,
      });
      info.annotations.push({ type: 'replay', description: path.relative(process.cwd(), replay) });
      if (saved.length > 1) {
        const out = path.join(videoDir, 'side-by-side.mp4');
        // Each caption stays a little after its step, but never past the start of that user's next step.
        const captionsFor = (user: string) => {
          const mine = this.records.filter((r) => r.user === user);
          return mine.map((r, i) => ({
            start: at(r.start),
            end: Math.min(at(r.end || Date.now()) + 400, mine[i + 1] ? at(mine[i + 1].start) : Infinity),
            text: `${user} · line ${r.line} · ${r.text.split(' › ').pop()}`,
          }));
        };
        if (sideBySide(saved.map((s) => ({ file: s.file, offset: at(s.started), captions: captionsFor(s.user) })), out)) {
          info.annotations.push({ type: 'video', description: `everyone side by side: ${path.relative(process.cwd(), out)}` });
        }
      }
    }

    this.writeTrace(passed);

    for (const w of this.warnings) {
      info.annotations.push({ type: 'watchdog', description: `line ${w.line} · ${w.user} · ${w.message}` });
    }
    if (passed && this.blocked) throw new HumanError(this.blocked);
    if (passed && this.warnings.length && this.config.watchdog?.failTestOnWarning) {
      throw new HumanError(`The test steps passed, but the watchdog found ${this.warnings.length} problem(s):\n` +
        this.warnings.map((w) => `   ⚠ line ${w.line} · ${w.user} · ${w.message}`).join('\n'));
    }
  }

  /**
   * The test asked for a 409 from POST /api/v1/routes, so the page logging "[API Error 409]: POST
   * /routes", or the 5xx it answered, is what the test checks, not a hidden problem. A warning goes
   * only when it names that status, the method, and the last fixed part of the path, for that user.
   */
  private dropExpected() {
    const expected = (w: Warning) => this.expectedErrors.some((e) => {
      if (e.user !== w.user) return false;
      const last = e.path.split('/').filter((x) => x && !x.startsWith(':')).pop() ?? '';
      return new RegExp(`\\b${e.status}\\b`).test(w.message) && w.message.includes(e.method) && w.message.includes(`/${last}`);
    });
    for (let i = this.warnings.length - 1; i >= 0; i--) if (expected(this.warnings[i])) this.warnings.splice(i, 1);
  }

  /**
   * Writes .humantest/traces/<test>.json: every step with the API calls it caused.
   * Written on every run (not only demo runs), so other tools can see what each step touched.
   */
  private writeTrace(passed: boolean) {
    const info = this.opts.testInfo;
    const calls = new Map<number, TraceCall[]>();
    for (const u of this.users) {
      for (const e of u.log) {
        if (e.step < 0) continue;
        const list = calls.get(e.step) ?? [];
        list.push({ method: e.method, path: e.path, query: e.query, bodyKeys: e.bodyKeys, status: e.status,
          ...(e.mocked ? { simulated: true } : {}), ...(e.pageUrl ? { pageUrl: e.pageUrl } : {}) });
        calls.set(e.step, list);
      }
    }
    const trace: Trace = {
      version: 1,
      test: info.title,
      source: `${this.opts.source}:${this.opts.line}`,
      status: passed ? 'passed' : 'failed',
      steps: this.records.map((r, i) => ({
        title: r.user === 'setup' ? `line ${r.line} · ${r.text}` : `line ${r.line} · ${r.user} · ${r.text}`,
        user: r.user, line: r.line, text: r.text, status: r.status, calls: calls.get(i) ?? [],
        ...(this.stepPages[i] ? { pageUrl: this.stepPages[i] } : {}),
      })),
    };
    const file = path.join(process.cwd(), '.humantest', 'traces', `${fileSlug(`${this.opts.source} ${info.title}`)}.json`);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(trace, null, 1));
      info.annotations.push({ type: 'trace', description: path.relative(process.cwd(), file) });
    } catch (e) {
      this.warn('setup', `Could not write the trace file: ${(e as Error).message}`);
    }
  }
}

/**
 * Records a page with Playwright's screencast: every frame arrives as a JPEG with the exact time
 * it was painted. Frames go straight to disk (long tests would not fit in memory) and are
 * turned into an mp4 at the end. Playwright's showActions draws a moving cursor and highlights
 * the element each action targets.
 */
/**
 * Screencast video size. Frames always arrive at the viewport's CSS size (1280×720), even with a
 * higher deviceScaleFactor or a bigger size option (measured), so recording larger only upscales.
 */
const VIDEO_SIZE = { width: 1280, height: 720 };

class FrameRecorder {
  private readonly frames: Frame[] = [];

  constructor(private readonly page: Page, private readonly dir: string) {}

  async start() {
    fs.rmSync(this.dir, { recursive: true, force: true });
    fs.mkdirSync(this.dir, { recursive: true });
    await this.page.screencast.start({
      size: VIDEO_SIZE,
      quality: 90,
      onFrame: (f) => {
        const file = path.join(this.dir, `f${String(this.frames.length).padStart(6, '0')}.jpg`);
        fs.writeFileSync(file, f.data);
        this.frames.push({ file, ts: f.timestamp });
      },
    });
    await this.page.screencast.showActions({
      cursor: 'pointer',
      duration: 900,
      style: {
        point: 'width: 22px; height: 22px; border-radius: 50%; border: 3px solid #7c3aed; background: rgba(124,58,237,.18)',
        highlight: 'outline: 3px solid #7c3aed; outline-offset: 2px; border-radius: 6px; background: rgba(124,58,237,.10)',
        title: 'display: none',   // the replay shows our own step text instead
      },
    });
    // The browser only sends a frame when something changes, so nudge one out now: the video starts here.
    await this.page.evaluate(() => { document.body.style.outline = '1px solid transparent'; }).catch(() => {});
  }

  /** Stops recording and writes the mp4. Returns it with the time of its first frame. */
  async stop(out: string): Promise<{ file: string; started: number } | undefined> {
    await this.page.screencast.stop().catch(() => {});
    const end = Date.now();
    const ok = encodeFrames(this.frames, end, out, VIDEO_SIZE);
    fs.rmSync(this.dir, { recursive: true, force: true });
    return ok && this.frames.length ? { file: out, started: this.frames[0].ts } : undefined;
  }
}

interface LogEntry {
  method: string;
  path: string;
  line: number;
  /** When the request was sent (ms since epoch). */
  at: number;
  status?: number;
  mocked?: boolean;
  req?: Request;
  body?: Promise<string | null>;
  /** Which step sent it: an index into Scenario.records, or -1 before this user's first step. */
  step: number;
  /** Names of the query parameters (not their values). */
  query: string[];
  /** Top-level field names of a JSON or form body (not their values). */
  bodyKeys: string[];
  /** Path of the page the user was on. */
  pageUrl?: string;
}

interface Reply { label: string; status: number; text: () => Promise<string | null> }

export class User {
  readonly log: LogEntry[] = [];
  private mark = 0;
  /** The element the last click landed on: while it is still there, the page hasn't moved on. */
  private lastClicked?: Locator;
  private lastReply?: Reply;
  private readonly mocked = new WeakSet<Request>();
  /** Reply bodies, captured on the Node side so they survive page navigations. */
  private readonly bodies = new WeakMap<Request, string>();
  private offline = false;
  private caption?: string;
  /** This user's latest step (index into Scenario.records), so its API calls are counted to it. */
  private stepIndex = -1;

  /** Route every API call through Node so we always have its reply body. Simulations are added later and run first. */
  async init() {
    const prefix = this.ht.config.apiPrefix ?? '/api';
    await this.context.route((url) => url.pathname.startsWith(prefix), async (route) => {
      const url = route.request().url();
      if (!this.ht.allowsHost(url)) {
        this.ht.blocked ??= this.ht.blockedError(url);
        await route.abort('blockedbyclient').catch(() => {});
        return;
      }
      try {
        const res = await route.fetch();
        const body = await res.text();
        this.bodies.set(route.request(), body);
        await route.fulfill({ response: res, body });
      } catch {
        await route.continue().catch(() => {});
      }
    });
  }

  constructor(readonly ht: Scenario, readonly name: string, readonly context: BrowserContext, readonly page: Page,
    readonly recorder?: FrameRecorder) {
    const prefix = ht.config.apiPrefix ?? '/api';
    const slowMs = ht.config.watchdog?.slowApiMs ?? 2000;
    const isApi = (r: Request) => { try { return new URL(r.url()).pathname.startsWith(prefix); } catch { return false; } };
    const entryOf = (r: Request) => this.log.find((e) => e.req === r);

    context.on('request', (req) => {
      if (!isApi(req)) return;
      const url = new URL(req.url());
      let bodyKeys: string[] = [];
      try {
        const body = req.postDataJSON();
        if (body && typeof body === 'object' && !Array.isArray(body)) bodyKeys = Object.keys(body);
      } catch { /* not JSON or form data, e.g. a file upload */ }
      let pageUrl: string | undefined;
      try { pageUrl = new URL(page.url()).pathname; } catch { /* about:blank */ }
      this.log.push({
        method: req.method(), path: url.pathname, line: ht.currentLine, at: Date.now(), req,
        step: this.stepIndex, query: [...new Set(url.searchParams.keys())], bodyKeys, pageUrl,
      });
    });
    context.on('response', (res: Response) => {
      const req = res.request();
      const entry = entryOf(req);
      if (entry) {
        entry.status = res.status();
        entry.mocked = this.mocked.has(req);
        entry.body = Promise.resolve(this.bodies.get(req) ?? null);
      }
      if (res.status() >= 500 && !this.mocked.has(req)) {
        ht.warn(name, `${req.method()} ${new URL(req.url()).pathname} returned ${res.status()} (nobody checked this)`);
      }
    });
    context.on('requestfinished', (req) => {
      if (!isApi(req) || this.mocked.has(req)) return;
      const t = req.timing();
      if (t.responseEnd > slowMs) ht.warn(name, `${req.method()} ${new URL(req.url()).pathname} was slow: ${Math.round(t.responseEnd)} ms`);
    });
    context.on('requestfailed', (req) => {
      const err = req.failure()?.errorText ?? '';
      if (this.mocked.has(req) || this.offline || /ABORTED/i.test(err) || !ht.allowsHost(req.url())) return;
      ht.warn(name, `${req.method()} ${req.url()} failed: ${err}`);
    });
    page.on('pageerror', (err) => ht.warn(name, `JavaScript error on the page: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() !== 'error' || /Failed to load resource/i.test(msg.text())) return;
      // React writes console.error('In HTML, %s cannot be a descendant of <%s>.', '<div>', 'p'):
      // the text alone keeps the %s, so the arguments are put in.
      const text = msg.text();
      if (!/%[sdoOif]/.test(text)) { ht.warn(name, `Console error: ${text}`); return; }
      void Promise.all(msg.args().map((a) => a.jsonValue().catch(() => '…')))
        .then(([format, ...args]) => {
          let k = 0;
          const filled = (typeof format === 'string' ? format : text).replace(/%[sdoOif]/g, () => (k < args.length ? String(typeof args[k] === 'object' ? JSON.stringify(args[k++]) : args[k++]) : '…'));
          ht.warn(name, `Console error: ${filled}`);
        })
        .catch(() => ht.warn(name, `Console error: ${text}`));
    });
    if (DEMO) page.on('load', () => { void this.showCaption(); });
  }

  // ---------------- step wrapper ----------------

  /** The element the current step acted on or checked, in page pixels (only recorded for videos). */
  private focus?: { x: number; y: number; w: number; h: number };

  private async noteFocus(loc: Locator) {
    if (!DEMO) return;
    const b = await loc.boundingBox({ timeout: 500 }).catch(() => null);
    if (b && b.width > 0 && b.height > 0) {
      this.focus = { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
    }
  }

  /** `check`: the step only looks (or waits), so API calls during it still belong to the step before. */
  async step(line: number, text: string, fn: (u: User) => Promise<void>, opts: { check?: boolean } = {}) {
    await test.step(`line ${line} · ${this.name} · ${text}`, async () => {
      this.ht.currentLine = line;
      this.caption = `👤 ${this.name}   ·   line ${line}   ·   ${text}`;
      const rec: ReplayStep = { user: this.name, line, text, start: Date.now(), end: 0, status: 'passed' };
      if (!opts.check || this.stepIndex < 0) this.stepIndex = this.ht.records.length;
      const index = this.ht.records.length;
      this.ht.records.push(rec);
      this.focus = undefined;
      await this.showCaption();
      const notePage = () => {
        try { this.ht.stepPages[index] = new URL(this.page.url()).pathname; } catch { /* about:blank */ }
      };
      try {
        await fn(this);
        notePage();
        if (this.ht.blocked) throw new Error(this.ht.blocked);
      } catch (e) {
        notePage();
        const err = this.ht.humanError(line, this.name, text, e, this);
        rec.status = 'failed';
        rec.error = err.message.split('\n').slice(2).join('\n').trim();
        rec.end = Date.now();
        if (this.focus) rec.box = this.focus;
        throw err;
      }
      // Where on the page this step happened, so the replay can zoom in there.
      if (this.focus) rec.box = this.focus;
      if (DEMO) {
        await this.showCaption();
        await this.page.waitForTimeout(this.ht.config.demo?.pauseAfterStepMs ?? 700);
      }
      rec.end = Date.now();
    }, { box: true });
  }

  // ---------------- page sections ("in "Selected tooth", ...") ----------------

  private scope?: { name: string; kind?: string | null };

  /** Where to look for things: the whole page, or the section named in "in "...", ...". */
  private get root(): Page | Locator {
    if (!this.scope) return this.page;
    const { name, kind } = this.scope;
    const ROLES: Record<string, string[]> = {
      dialog: ['dialog', 'alertdialog'],
      panel: ['region', 'group'], section: ['region', 'group'], region: ['region'],
      form: ['form'], table: ['table'], row: ['row'], menu: ['menu'], list: ['list'],
    };
    const roles = (kind && ROLES[kind]) || ['dialog', 'alertdialog', 'region', 'group', 'form', 'navigation', 'table', 'row', 'menu'];
    let loc = this.page.getByRole(roles[0] as any, { name });
    for (const r of roles.slice(1)) loc = loc.or(this.page.getByRole(r as any, { name }));
    return loc.first();
  }

  async within(name: string, kind: string | null, fn: () => Promise<void>) {
    this.scope = { name, kind };
    try {
      await expect(this.root as Locator, `I can't find a ${kind ?? 'section'} called "${name}" on the page.`).toBeVisible();
      await fn();
    } finally {
      this.scope = undefined;
    }
  }

  // ---------------- finding elements ----------------
  // Candidates are tried in order: an exact name beats a partial one, a button beats plain text.

  private mapped(name: string): Locator | undefined {
    const css = this.ht.config.elements?.[name];
    return css ? this.root.locator(css) : undefined;
  }

  private clickableCandidates(name: string, role?: string): Locator[] {
    const r = this.root;
    const mapped = this.mapped(name);
    if (mapped) return [mapped];
    if (role === 'dialog') return [this.page.getByRole('dialog', { name }), this.page.getByRole('alertdialog', { name })];
    if (role === 'panel' || role === 'section') {
      return [r.getByRole('region', { name, exact: true }), r.getByRole('group', { name, exact: true }), r.getByRole('region', { name }), r.getByRole('group', { name })];
    }
    const roles = role === 'button' ? ['button'] : role === 'link' ? ['link']
      : ['button', 'link', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'tab', 'radio', 'checkbox', 'option', 'switch'];
    return [
      ...roles.map((x) => r.getByRole(x as any, { name, exact: true })),
      ...(role ? [] : [r.getByText(name, { exact: true })]),
      ...roles.map((x) => r.getByRole(x as any, { name })),
    ];
  }

  private fieldCandidates(name: string): Locator[] {
    const r = this.root;
    const mapped = this.mapped(name);
    if (mapped) return [mapped];
    return [
      r.getByLabel(name, { exact: true }),
      r.getByPlaceholder(name, { exact: true }),
      r.getByRole('textbox', { name, exact: true }),
      r.getByRole('combobox', { name, exact: true }),
      r.getByLabel(name),
      r.getByPlaceholder(name),
      r.getByRole('combobox', { name }),
      this.near(name, FIELD_CSS),
    ];
  }

  /**
   * The `css` element inside the smallest block that also shows a text starting with `name`:
   * for a label that isn't linked to its input (`<Label>From *</Label>` next to a dropdown).
   */
  private near(name: string, css: string): Locator {
    const text = this.page.getByText(new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'));
    return this.root.locator('div, section, fieldset, form, label, li')
      .filter({ has: text }).filter({ has: this.page.locator(css) })
      .last().locator(css).first();
  }

  /** Wait until one of the candidates is visible, then use the best one. */
  /**
   * `exact`: how many of the candidates (the first ones) are a sure match. When only a weaker
   * match is on screen, the page may still be changing: "Continue to pay" is part of "Continue to
   * Payment" on the page before. So an exact match gets a moment to appear first.
   */
  private async pick(candidates: Locator[], what: string, exact = candidates.length): Promise<Locator> {
    let any = candidates[0];
    for (const c of candidates.slice(1)) any = any.or(c);
    await expect(any.first(), `I can't find ${what}.`).toBeVisible();
    const firstVisible = async () => {
      for (const [i, c] of candidates.entries()) {
        if (await c.first().isVisible().catch(() => false)) return i;
      }
      return -1;
    };
    // The partial match is the very thing the last step clicked: the page hasn't changed yet
    // (a dev server compiles a page on its first visit), so wait as long as for anything else.
    const stale = async (j: number) => !!this.lastClicked &&
      await candidates[j].first().evaluate((el, last) => el === last, await this.lastClicked.elementHandle({ timeout: 100 }).catch(() => null)).catch(() => false);
    let i = await firstVisible();
    for (const start = Date.now(); i >= exact;) {
      const waited = Date.now() - start;
      if (waited > 15_000 || (waited > 1500 && !(await stale(i)))) break;
      await sleep(100);
      i = await firstVisible();
    }
    return i >= 0 ? candidates[i].first() : any.first();
  }

  private clickable(name: string, role?: string) {
    const where = this.scope ? ` inside "${this.scope.name}"` : '';
    const candidates = this.clickableCandidates(name, role);
    // Buttons and links with exactly these words come first. Plain text with the same words (help text
    // that names the button: "Click Continue to pay") and partial matches only win when no such
    // button shows up: a button that is still loading would otherwise lose to its own description.
    const special = role === 'dialog' || role === 'panel' || role === 'section' || !!this.mapped(name);
    const strong = special ? candidates.length : role === 'button' || role === 'link' ? 1 : 10;
    return this.pick(candidates, `a ${role ?? 'button, link or menu item'} called "${name}"${where}`, strong);
  }

  private field(name: string) {
    const where = this.scope ? ` inside "${this.scope.name}"` : '';
    const candidates = this.fieldCandidates(name);
    // The last four are partial: label, placeholder, dropdown name, the words next to it.
    return this.pick(candidates, `an input or dropdown called "${name}"${where} (looked for a label, placeholder or name)`, candidates.length > 1 ? candidates.length - 4 : 1);
  }

  // ---------------- browser actions ----------------

  async goTo(url: string) {
    url = withDates(url);
    this.mark = this.log.length;
    await this.page.goto(url);
  }

  async reload() {
    this.mark = this.log.length;
    await this.page.reload();
  }

  async type(value: string, field: string) {
    value = withDates(value);
    const loc = await this.field(field);
    await this.noteFocus(loc);
    this.mark = this.log.length;
    if (DEMO) {
      await loc.fill('');
      await loc.pressSequentially(value, { delay: this.ht.config.demo?.typingDelayMs ?? 60 });
    } else {
      await loc.fill(value);
    }
  }

  async typeToday(field: string) {
    const loc = await this.field(field);
    await this.noteFocus(loc);
    // The browser's own date, in the format date inputs take (YYYY-MM-DD).
    const today = await this.page.evaluate(() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    });
    this.mark = this.log.length;
    await loc.fill(today);
  }

  async choose(option: string, field: string) {
    option = withDates(option);
    const loc = await this.field(field);
    await this.noteFocus(loc);
    this.mark = this.log.length;
    const tag = await loc.evaluate((e) => e.tagName.toLowerCase());
    if (tag === 'select') {
      await loc.selectOption({ label: option });
      return;
    }
    // A custom dropdown (Radix, shadcn, Headless UI ...): open it, then pick the option, which may render outside the section.
    if (DEMO) await this.highlight(loc);
    await loc.click();
    const opt = await this.option(option, field);
    if (DEMO) await this.highlight(opt);
    await opt.click();
  }

  /**
   * The option called `name` in an open dropdown. When none is called exactly that, the one option
   * that starts with it: "Blowing Point ➔ Marigot" picks "Blowing Point ➔ Marigot • 20 mins trip",
   * so a test doesn't break over the details an option adds (a trip length, a seat count).
   */
  private async option(name: string, field: string): Promise<Locator> {
    const exact = this.page.getByRole('option', { name, exact: true });
    try {
      await expect(exact).toBeVisible({ timeout: 2000 });
      return exact;
    } catch { /* look for one that starts with it */ }
    const lead = new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
    const starts = this.page.getByRole('option', { name: lead });
    // The options may still be loading.
    await starts.first().waitFor({ timeout: 5000 }).catch(() => {});
    const n = await starts.count();
    if (n === 1) return starts;
    const all = (await this.page.getByRole('option').allInnerTexts()).map((t) => t.trim()).filter(Boolean);
    const shown = all.length ? `\nIts options: ${all.slice(0, 8).map((t) => `"${t}"`).join(', ')}${all.length > 8 ? ` and ${all.length - 8} more` : ''}.` : '';
    throw new Error(n > 1
      ? `The "${field}" dropdown has ${n} options that start with "${name}". Write more of the one you mean.${shown}`
      : `The "${field}" dropdown opened, but it has no option called "${name}".${shown}`);
  }

  /**
   * Choose a file in a file input. Upload widgets often hide the input and don't label it,
   * so after the label, the input inside the smallest block that also shows `field` is used.
   */
  async upload(file: string, field?: string) {
    const full = [path.join(process.cwd(), 'e2e', 'files', file), path.resolve(process.cwd(), file)].find((f) => fs.existsSync(f));
    if (!full) throw new Error(`There is no file "${file}". Put it in e2e/files/ (looked for ${path.join('e2e', 'files', file)}).`);
    const r = this.root;
    const inputs = r.locator('input[type=file]');
    const where = this.scope ? ` inside "${this.scope.name}"` : '';
    let loc: Locator | undefined = field ? this.mapped(field) : undefined;
    if (!loc && field) {
      const labelled = r.getByLabel(field).and(inputs);
      const near = this.near(field, 'input[type=file]');
      await expect(labelled.or(near).first(), `I can't find a file input for "${field}"${where}.`).toBeAttached();
      loc = (await labelled.count()) ? labelled.first() : near.first();
    }
    if (!loc) {
      await expect(inputs.first(), `I can't find a file input${where}.`).toBeAttached();
      const n = await inputs.count();
      if (n > 1) throw new Error(`There are ${n} file inputs${where}. Say which one: upload "${file}" to "<the text next to it>".`);
      loc = inputs.first();
    }
    if (DEMO) await this.highlight(loc).catch(() => {});
    this.mark = this.log.length;
    await loc.setInputFiles(full);
  }

  async press(key: string) {
    this.mark = this.log.length;
    await this.page.keyboard.press(key);
  }

  async click(name: string, role?: string) {
    const loc = await this.clickable(name, role);
    await this.noteFocus(loc);
    if (DEMO) await this.highlight(loc);
    this.mark = this.log.length;
    await loc.click();
    this.lastClicked = loc;
  }

  async see(text: string) {
    text = withDates(text);
    try {
      await expect(this.root.getByText(text).first(), `"${text}" should be visible${this.scope ? ` inside "${this.scope.name}"` : ' on the page'}, but it isn't.`).toBeVisible();
      await this.noteFocus(this.root.getByText(text).first());
    } catch (e) {
      const similar = await this.similarText(text);
      if (!similar.length) throw e;
      throw new Error(`"${text}" should be visible${this.scope ? ` inside "${this.scope.name}"` : ' on the page'}, but it isn't.\n` +
        `Instead, ${this.scope ? 'that part of the page' : 'the page'} shows: ${similar.map((t) => `"${t}"`).join(', ')}`);
    }
  }

  /** Visible lines that look like what the test expected. Helps explain failures. */
  private async similarText(expected: string): Promise<string[]> {
    const root = this.scope ? (this.root as Locator) : this.page.locator('body');
    const lines: string[] = await root.innerText({ timeout: 1000 })
      .then((t) => t.split('\n').map((l) => l.trim()).filter(Boolean)).catch(() => []);
    const words = expected.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
    return lines
      .map((l) => ({ l, score: words.filter((w) => l.toLowerCase().includes(w)).length }))
      .filter((x) => x.score > 0 && x.l.length < 120)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((x) => x.l);
  }

  async notSee(text: string) {
    text = withDates(text);
    await expect(this.root.getByText(text).first(), `"${text}" should NOT be visible, but it is.`).toBeHidden();
  }

  async onPage(pathname: string) {
    await expect.poll(() => new URL(this.page.url()).pathname, { message: `The browser should be on ${pathname}.` }).toBe(pathname);
  }

  async shouldBe(name: string, state: 'enabled' | 'disabled' | 'visible' | 'hidden' | 'focused', role?: string) {
    const candidates = role === 'field' ? this.fieldCandidates(name) : this.clickableCandidates(name, role);
    const msg = `"${name}"${role ? ` ${role}` : ''} should be ${state}.`;
    if (state === 'hidden') {
      await expect.poll(async () => {
        for (const c of candidates) if (await c.first().isVisible().catch(() => false)) return 'visible';
        return 'hidden';
      }, { message: msg }).toBe('hidden');
      return;
    }
    const loc = role === 'field' ? await this.field(name) : await this.clickable(name, role);
    await this.noteFocus(loc);
    if (state === 'enabled') await expect(loc, msg).toBeEnabled();
    if (state === 'disabled') await expect(loc, msg).toBeDisabled();
    if (state === 'focused') await expect(loc, msg).toBeFocused();
  }

  async wait(seconds: number) {
    await this.page.waitForTimeout(seconds * 1000);
  }

  // ---------------- accessibility ----------------

  async noAccessibilityProblems() {
    const cfg = this.ht.config.accessibility ?? {};
    // Let animations finish, so axe never measures half-faded text.
    await this.page.emulateMedia({ reducedMotion: 'reduce' });
    await this.page.evaluate(() => Promise.all(document.getAnimations()
      .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
      .map((a) => a.finished.catch(() => null))));
    let axe = new AxeBuilder({ page: this.page }).withTags(cfg.tags ?? ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
    const modalOpen = await this.page.locator('[role="dialog"][aria-modal="true"], [role="alertdialog"], [role="menu"], [role="listbox"]').count() > 0;
    const off = [...(cfg.ignoreRules ?? []), ...(modalOpen ? cfg.ignoreWhenModalOpen ?? [] : [])];
    if (off.length) axe = axe.disableRules(off);
    const { violations } = await axe.analyze();
    if (violations.length) {
      throw new Error(`Found ${violations.length} accessibility problem(s):\n` + violations.map((v) =>
        `• [${v.impact ?? 'unknown'}] ${v.help} (${v.id}), ${v.nodes.length} element(s): ` +
        `${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')}\n  ${v.helpUrl}`).join('\n'));
    }
  }

  // ---------------- backend checks ----------------

  private seenSinceMark() {
    return this.log.slice(this.mark).map((e) => `${e.method} ${e.path} → ${e.status ?? '…'}`);
  }

  async backendReceives(method: string, pathname: string, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    let entry: LogEntry | undefined;
    // ":id" (or any ":name") stands for one part of the path that changes from run to run.
    const parts = pathname.split('/');
    const matches = (p: string) => {
      const q = p.split('/');
      return q.length === parts.length && parts.every((x, i) => (x.startsWith(':') ? q[i] !== '' : x === q[i]));
    };
    while (!(entry = this.log.slice(this.mark).find((e) => e.method === method && matches(e.path))) && Date.now() < deadline) {
      await sleep(50);
    }
    if (!entry) {
      const seen = this.seenSinceMark();
      throw new Error(`The backend never received ${method} ${pathname} (waited ${timeoutMs / 1000}s).\n` +
        `Requests since the last action: ${seen.length ? seen.join(', ') : 'none'}`);
    }
    while (entry.status === undefined && Date.now() < deadline + 10_000) await sleep(50);
    if (entry.status === undefined) throw new Error(`${method} ${pathname} was sent, but no reply came back.`);
    const e = entry;
    this.lastReply = { label: `${method} ${pathname}`, status: e.status!, text: () => e.body ?? Promise.resolve(null) };
  }

  async noBackendRequest(waitMs = 1000) {
    await sleep(waitMs);
    const seen = this.seenSinceMark();
    if (seen.length) throw new Error(`Expected no backend request, but the page sent: ${seen.join(', ')}`);
  }

  async call(method: string, pathname: string) {
    this.mark = this.log.length;
    const url = this.ht.apiURL(pathname);
    if (!this.ht.allowsHost(url.toString())) throw new Error(this.ht.blockedError(url.toString(), 'call'));
    // The login's cookies go with it; its token too, the way the page sends it (many APIs read only the header).
    const token = this.ht.config.users[this.name]?.email ? (await this.ht.login(this.name)).token : undefined;
    const res = await this.context.request.fetch(url.toString(), { method, ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}) });
    const body = res.text().catch(() => null);
    this.log.push({
      method, path: pathname, line: this.ht.currentLine, at: Date.now(), status: res.status(), body,
      step: this.stepIndex, query: [...new Set(url.searchParams.keys())], bodyKeys: [],
    });
    this.lastReply = { label: `${method} ${pathname}`, status: res.status(), text: () => body };
  }

  private reply(): Reply {
    if (!this.lastReply) {
      throw new Error('There is no backend reply to check yet.\nAdd a line like  backend should receive POST /api/users  or  call GET /api/...  before this one.');
    }
    return this.lastReply;
  }

  private async replyJson(): Promise<unknown> {
    const r = this.reply();
    const text = await r.text();
    if (text == null) throw new Error(`I couldn't read the body of the ${r.label} reply.`);
    try { return JSON.parse(text); } catch { return text; }
  }

  async replyStatus(expected: number) {
    const r = this.reply();
    if (r.status !== expected) {
      const body = await r.text().catch(() => null);
      throw new Error(`${r.label} replied ${r.status}, expected ${expected}.${body ? `\nReply body: ${short(body)}` : ''}`);
    }
    if (expected >= 400) {
      const [method, pathname] = r.label.split(' ');
      this.ht.expectedErrors.push({ user: this.name, method, path: pathname, status: expected });
    }
  }

  async replyContains(key: string, negate: boolean) {
    const body = await this.replyJson();
    const found = deepHas(body, key);
    if (found === negate) {
      throw new Error(`The ${this.reply().label} reply ${negate ? 'should NOT contain' : 'should contain'} "${key}", but it ${found ? 'does' : "doesn't"}.\n` +
        `Reply body: ${short(body)}`);
    }
  }

  async replyField(field: string, expected: unknown) {
    const body = await this.replyJson();
    const actual = getPath(body, field);
    if (String(actual) !== String(expected)) {
      throw new Error(`In the ${this.reply().label} reply, ${field} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}.\nReply body: ${short(body)}`);
    }
  }

  // ---------------- simulate problems ----------------

  private async intercept(method: string, pathname: string, handle: (route: import('@playwright/test').Route) => Promise<void>) {
    await this.context.route((url) => url.pathname === pathname, async (route) => {
      if (route.request().method() !== method) return route.fallback();
      this.mocked.add(route.request());
      await handle(route);
    });
  }

  async simulateReply(method: string, pathname: string, status: number, body?: unknown) {
    await this.intercept(method, pathname, async (route) => {
      const text = JSON.stringify(body ?? { error: `Simulated ${status} from HumanTest` });
      this.bodies.set(route.request(), text);
      await route.fulfill({ status, contentType: 'application/json', body: text });
    });
  }

  async simulateSlow(method: string, pathname: string, seconds: number) {
    await this.intercept(method, pathname, async (route) => {
      await sleep(seconds * 1000);
      // Hand over to the recorder, which forwards it to the real server.
      await route.fallback().catch(() => {});
    });
  }

  async setOffline(off: boolean) {
    this.offline = off;
    await this.context.setOffline(off);
  }

  // ---------------- demo mode visuals ----------------

  private async showCaption() {
    // With the screencast recorder, the replay page draws captions itself (sharp at any size),
    // and the side-by-side video gets them from ffmpeg, so nothing is painted into the page.
    if (!DEMO || !this.caption || this.recorder) return;
    await this.page.evaluate((text) => {
      let el = document.getElementById('__ht_caption');
      if (!el) {
        el = document.createElement('div');
        el.id = '__ht_caption';
        Object.assign(el.style, {
          position: 'fixed', left: '50%', bottom: '24px', transform: 'translateX(-50%)', zIndex: '2147483647',
          background: 'rgba(17,24,39,.92)', color: '#fff', font: '600 18px/1.4 system-ui, sans-serif',
          padding: '10px 18px', borderRadius: '10px', boxShadow: '0 6px 24px rgba(0,0,0,.35)',
          pointerEvents: 'none', maxWidth: '90vw', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        });
        document.documentElement.appendChild(el);
      }
      el.textContent = text;
    }, this.caption).catch(() => {});
  }

  private async highlight(loc: Locator) {
    if (this.recorder) return;   // Playwright's showActions already draws the cursor and the highlight.
    const box = await loc.boundingBox().catch(() => null);
    if (!box) return;
    await this.page.evaluate(({ x, y }) => {
      const d = document.createElement('div');
      Object.assign(d.style, {
        position: 'fixed', left: `${x - 24}px`, top: `${y - 24}px`, width: '48px', height: '48px',
        border: '3px solid #ef4444', borderRadius: '50%', boxShadow: '0 0 0 6px rgba(239,68,68,.25)',
        zIndex: '2147483647', pointerEvents: 'none',
      });
      document.documentElement.appendChild(d);
      setTimeout(() => d.remove(), 900);
    }, { x: box.x + box.width / 2, y: box.y + box.height / 2 }).catch(() => {});
    await this.page.waitForTimeout(400);
  }
}

function deepHas(v: unknown, key: string): boolean {
  if (v == null) return false;
  if (typeof v !== 'object') return String(v) === key;
  if (Array.isArray(v)) return v.some((x) => deepHas(x, key));
  return Object.entries(v as Record<string, unknown>).some(([k, x]) => k === key || deepHas(x, key));
}

function getPath(v: unknown, p: string): unknown {
  return p.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)
    .reduce<any>((acc, k) => (acc == null ? undefined : acc[k]), v);
}
