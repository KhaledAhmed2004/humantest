// HumanTest runtime: what the generated Playwright specs call.
// - every user gets their own browser context (separate login, cookies, video)
// - every API call the page makes is recorded, so tests can check the backend
// - a watchdog reports hidden problems (5xx, JS errors, slow APIs) even when nobody asserted them
// - demo mode (HUMANTEST_DEMO=1) slows things down and shows captions for readable videos

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { whereProblem, PART_LABEL } from './where';
import { allMail, startMailbox, waitForMail, type Email } from './mailbox';
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

/**
 * Slow networks, with the numbers Chrome DevTools uses for its presets: the delay added to every
 * request (ms) and the speed down and up (bytes per second). `slower` is how much longer steps may
 * wait for the page to show something before they fail.
 */
export const NETWORKS = {
  'slow 3G': { latency: 2000, down: 50_000, up: 50_000, slower: 4 },
  '3G': { latency: 562.5, down: 180_000, up: 84_375, slower: 2 },
  '4G': { latency: 165, down: 1_012_500, up: 168_750, slower: 1.5 },
} as const;
export type NetworkName = keyof typeof NETWORKS;

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
  /**
   * A test mailbox: HumanTest catches the app's email on this SMTP port (no TLS, any login), so
   * steps can read it and nothing is really sent. Point the app's SMTP host at localhost and this port.
   * `waitSeconds`: how long "should get an email" waits (10). `quietSeconds`: how long
   * "should not get an email" watches (3).
   */
  email?: { port: number; waitSeconds?: number; quietSeconds?: number };
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
  if (config.email?.port) {
    await startMailbox(config.email.port);
    ht.mailFrom = allMail().length;
  }
  opts.testInfo.annotations.push({ type: 'source', description: `${opts.source}:${opts.line}` });
  let passed = false;
  try {
    await body(ht);
    passed = true;
  } finally {
    await ht.finish(passed);
  }
}

/** The "message" of a JSON reply, if it has one (waits briefly for the body). */
async function replyMessage(body: Promise<string | null> | undefined): Promise<string | undefined> {
  if (!body) return undefined;
  const text = await Promise.race([body.catch(() => null), sleep(1000).then(() => null)]);
  try {
    const m = (JSON.parse(text ?? '') as { message?: unknown }).message;
    return typeof m === 'string' ? m.slice(0, 200) : undefined;
  } catch { return undefined; }
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

/** {name} in a step: a remembered value, {unique} or a date. JSON's own braces never match. */
const PLACEHOLDER = /\{([a-z][\w ]*?)\}/gi;
/** A {name} standing on its own as a JSON value, not inside quotes. */
const LONE_PLACEHOLDER = /(^|[:[,]\s*)\{([a-z][\w ]*?)\}(?=\s*[,\]}]|\s*$)/gi;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Input types that can't be typed into key by key, with the value format they take. */
const SET_WHOLE: Record<string, { what: string; example: string }> = {
  date: { what: 'date', example: '2027-09-25 (or {today}, {in 10 days})' },
  time: { what: 'time', example: '09:30' },
  'datetime-local': { what: 'date and time', example: '2027-09-25T09:30 (or {in 10 days}T09:30)' },
  month: { what: 'month', example: '2027-09' },
  week: { what: 'week', example: '2027-W39' },
  color: { what: 'colour', example: '#1d4ed8' },
  range: { what: 'slider', example: 'a number, e.g. 50' },
};

/**
 * Runs in every page: tells Node (window.__htAppeared) the text of each element that shows up or
 * changes, so a toast that is gone again by the time its line runs still counts as seen.
 * HumanTest's own overlays (id "__ht…", e.g. the demo caption) are left out, and so are big
 * chunks such as a whole page rendering: a message is short.
 */
const WATCH_TEXT = `(() => {
  if (window.__htWatching) return;
  window.__htWatching = true;
  const pending = new Set();
  let batchAt = 0;
  const flush = () => {
    const at = batchAt;
    batchAt = 0;
    for (const el of pending) {
      try {
        if (!el.isConnected || el.closest('[id^="__ht"]')) continue;
        if ((el.textContent || '').length > 2000) continue;
        if (el.checkVisibility && !el.checkVisibility()) continue;
        const text = (el.innerText || '').trim();
        if (text && text.length <= 500 && window.__htAppeared) window.__htAppeared(at, text);
      } catch (e) { /* the page goes on */ }
    }
    pending.clear();
  };
  const watch = () => new MutationObserver((changes) => {
    for (const c of changes) {
      if (c.type === 'childList') {
        for (const n of c.addedNodes) {
          const el = n.nodeType === 1 ? n : n.parentElement;
          if (el) pending.add(el);
        }
      } else if (c.target.parentElement) {
        pending.add(c.target.parentElement);
      }
    }
    if (!batchAt && pending.size) { batchAt = Date.now(); setTimeout(flush, 50); }
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  if (document.documentElement) watch();
  else document.addEventListener('DOMContentLoaded', watch);
})();`;
/** `a.b[0].c` inside a parsed JSON reply. */
/**
 * One value inside a parsed JSON reply: `a.b[0].c`, or an item of a list found by its fields:
 * `data.items[name="Royal Alpha"].id`, `routes[departurePort.name="A", destinationPort.name="B"].id`.
 */
export function pick(obj: unknown, path: string): unknown {
  const part = /\s*(?:\.?([A-Za-z_$][\w$]*)|\[\s*(\d+)\s*\]|\[([^\]]*)\])/y;
  let v: any = obj;
  for (let i = 0; i < path.length && v != null;) {
    part.lastIndex = i;
    const m = part.exec(path);
    if (!m) throw new Error(`I can't read the field "${path}" (at "${path.slice(i)}").`);
    i = part.lastIndex;
    if (m[1] !== undefined) v = v[m[1]];
    else if (m[2] !== undefined) v = v[Number(m[2])];
    else {
      const conds = [...m[3].matchAll(/([\w$.]+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g)].map((c) => ({ field: c[1], value: c[2] ?? c[3] }));
      if (!conds.length) throw new Error(`I can't read [${m[3]}] in "${path}". Write it like [name="Royal Alpha"].`);
      v = Array.isArray(v) ? v.find((item) => conds.every((c) => String(pick(item, c.field)) === c.value)) : undefined;
    }
  }
  return v;
}

export interface Warning { line: number; user: string; message: string }

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

/**
 * What a bug report is made from (humantest-reports/<test>/report.json), written when a test fails
 * or passes with watchdog warnings. `npm test` turns it into bug-report.md.
 */
export interface BugReportData {
  version: 1;
  test: string;
  source: string;
  status: 'passed' | 'failed';
  at: string;
  baseURL: string;
  browser: string;
  steps: { user: string; line: number; text: string; status: 'passed' | 'failed'; error?: string; page?: string; calls: TraceCall[] }[];
  warnings: Warning[];
  /** Next to report.json. */
  screenshot?: string;
  /** Playwright's trace of the failed run (kept on failure), for `npx playwright show-trace`. */
  playwrightTrace?: string;
  replay?: string;
  /** What {unique} and each remembered {name} stood for in this run, so the steps read as they ran. */
  values?: Record<string, unknown>;
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
  /** Email that arrived before this test started isn't this test's. */
  mailFrom = 0;
  /** The email the last "should get an email" found, for "the email should contain …" and co. */
  email?: Email;
  /** Emails a step already found, so the next "should get an email" finds a new one. */
  readonly mailTaken = new Set<number>();
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

  /** Values kept with "remember … as <name>", used as {name} in later steps (by any user). */
  readonly vars = new Map<string, unknown>();
  /** {unique}: the same short random text all through one test, different in every run. */
  readonly unique = Math.random().toString(36).slice(2, 8);
  /** "at the end, call …": run when the test ends, last one first, even when the test failed. */
  readonly cleanups: { user: User; line: number; method: string; path: string; data?: unknown }[] = [];

  /** The value behind {name}: a remembered value (keeping its type), {unique}, or a date. */
  value(raw: string): unknown {
    const key = raw.trim().toLowerCase();
    if (this.vars.has(key)) return this.vars.get(key);
    if (key === 'unique') return this.unique;
    const date = withDates(`{${raw}}`);
    if (date !== `{${raw}}`) return date;
    const known = [...this.vars.keys()].map((k) => `{${k}}`).join(', ');
    throw new Error(`{${raw}} has no value yet.\nAdd a line like  remember data.id as ${key}  after the reply it comes from.` +
      (known ? `\nRemembered so far: ${known}` : ''));
  }

  /** {today}, {unique}, {ferry} … in a step's text, filled in. */
  fill(text: string): string {
    return text.replace(PLACEHOLDER, (_all, raw: string) => String(this.value(raw)));
  }

  /**
   * A JSON body with its {placeholders} filled in. A placeholder on its own keeps its type, so
   * {"ferryId": {ferry}} sends a number when the id is a number; inside quotes it becomes text.
   */
  fillBody(text: string): unknown {
    const marked = text.replace(LONE_PLACEHOLDER, (_m, pre: string, raw: string) => `${pre}"\\u0001${raw}"`);
    const walk = (v: unknown): unknown => {
      if (typeof v === 'string') return v.startsWith('\u0001') ? this.value(v.slice(1)) : this.fill(v);
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
      return v;
    };
    return walk(JSON.parse(marked));
  }

  /** Undo what the test set up ("at the end, call …"), newest first. A failure here is a warning. */
  private async cleanUp() {
    for (const c of this.cleanups.splice(0).reverse()) {
      await test.step(`line ${c.line} · ${c.user.name} · clean up: ${c.method} ${c.path}`, async () => {
        this.currentLine = c.line;
        try {
          const res = await c.user.send(c.method, c.path, c.data);
          // Already gone (the test deleted it itself) is fine.
          if (res.status() >= 400 && res.status() !== 404) {
            this.warn(c.user.name, `Cleaning up with ${c.method} ${c.path} failed: ${res.status()} ${short(await res.text().catch(() => ''))}`);
          }
        } catch (e) {
          this.warn(c.user.name, `Cleaning up with ${c.method} ${c.path} failed: ${(e as Error).message}`);
        }
      }, { box: true });
    }
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
        const err = await this.humanError(line, 'setup', `Start with: ${name}`, e);
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
          throw await this.humanError(line, name, `log in as ${name}`, e);
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

  async humanError(line: number, user: string, text: string, err: unknown, u?: User): Promise<Error> {
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
    const activity = u ? u.log.filter((e) => e.line === line) : [];
    const shown = u ? (activity.length ? activity : u.log.slice(-5)) : [];
    // Which side to look at: the page, the server, how the test runs, or the test itself.
    const where = whereProblem(text, raw, await Promise.all(shown.map(async (e) => ({
      method: e.method, path: e.path, status: e.status,
      reply: e.status !== undefined && e.status >= 400 ? await replyMessage(e.body) : undefined,
      expected: this.expectedErrors.some((x) => x.user === user && x.method === e.method && x.status === e.status),
    }))));
    if (where) parts.push('', `   Where the problem is: ${PART_LABEL[where.part]}`, `      ${where.why}`);
    if (u) {
      if (shown.length) {
        parts.push('', activity.length ? '   Backend activity during this step:' : '   Latest backend activity:');
        for (const e of shown) parts.push(`      ${e.method} ${e.path} → ${e.status ?? 'no reply'}${e.mocked ? ' (simulated)' : ''}`);
      }
      // A login kept from an earlier run stops working when the backend forgets it (a fresh database, a new secret).
      if (this.config.login?.keepBetweenRuns && this.config.users[user]?.email
        && u.log.some((e) => e.status === 401 && !this.expectedErrors.some((x) => x.user === user && x.method === e.method && x.status === 401))) {
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
    // What the page looked like when it failed, before anything is cleaned up or closed.
    const reportDir = path.join(process.cwd(), 'humantest-reports', fileSlug(`${this.opts.source} ${info.title}`));
    const screenshot = passed ? undefined : await this.failureScreenshot(reportDir);
    // Before the browsers close: the clean-up calls go with the users' logins.
    await this.cleanUp();
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
    if (!passed || this.warnings.length) this.writeReport(reportDir, passed, screenshot);

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
  /** A screenshot of the page of the user whose step failed. */
  private async failureScreenshot(dir: string): Promise<string | undefined> {
    const failed = [...this.records].reverse().find((r) => r.status === 'failed');
    const u = this.users.find((x) => x.name === failed?.user) ?? this.users[0];
    if (!u) return undefined;
    try {
      fs.mkdirSync(dir, { recursive: true });
      await u.page.screenshot({ path: path.join(dir, 'screenshot.png'), timeout: 5000 });
      return 'screenshot.png';
    } catch {
      return undefined; // the page was already gone
    }
  }

  private writeReport(dir: string, passed: boolean, screenshot?: string) {
    const info = this.opts.testInfo;
    const calls = this.callsPerRecord();
    const report: BugReportData = {
      version: 1,
      test: info.title,
      source: `${this.opts.source}:${this.opts.line}`,
      status: passed ? 'passed' : 'failed',
      at: new Date().toISOString(),
      baseURL: this.config.baseURL,
      browser: `${this.opts.browser.browserType().name()} ${this.opts.browser.version()}`,
      steps: this.records.map((r, i) => ({
        user: r.user, line: r.line, text: r.text, status: r.status,
        ...(r.error ? { error: r.error } : {}),
        ...(this.stepPages[i] ? { page: this.stepPages[i] } : {}),
        calls: calls.get(i) ?? [],
      })),
      warnings: this.warnings,
      values: { unique: this.unique, ...Object.fromEntries(this.vars) },
      ...(screenshot ? { screenshot } : {}),
      ...(passed ? {} : { playwrightTrace: path.relative(process.cwd(), path.join(info.outputDir, 'trace.zip')) }),
      ...(info.annotations.find((a) => a.type === 'replay') ? { replay: info.annotations.find((a) => a.type === 'replay')!.description } : {}),
    };
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 1));
    } catch { /* a report is extra; the run never fails over it */ }
  }

  /** Each user's API calls, by the step (index into records) that sent them. */
  private callsPerRecord(): Map<number, TraceCall[]> {
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
    return calls;
  }

  private writeTrace(passed: boolean) {
    const info = this.opts.testInfo;
    const calls = this.callsPerRecord();
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
  /** A slow network for this user ("on a slow 3G network"), until it is turned off again. */
  private network?: NetworkName;
  private caption?: string;
  /** This user's latest step (index into Scenario.records), so its API calls are counted to it. */
  private stepIndex = -1;
  /** When the last action (click, type, go to ...) started, in ms. */
  private actionAt = 0;
  /**
   * Text that showed up on the page, with when. A toast can come and go between the action and the
   * line that checks it (more so in demo runs, which pause after every step): "should see" counts it.
   */
  private appeared: { at: number; text: string }[] = [];

  /** An action starts: requests and text that show up from now on belong to it. */
  private markAction() {
    this.mark = this.log.length;
    this.actionAt = Date.now();
  }

  /** Did `text` show up on the page since the last action (even if it is gone again)? Matches like getByText. */
  private appearedSinceAction(text: string) {
    const want = text.replace(/\s+/g, ' ').trim().toLowerCase();
    return this.appeared.some((a) => a.at >= this.actionAt && a.text.toLowerCase().includes(want));
  }

  /** Route every API call through Node so we always have its reply body. Simulations are added later and run first. */
  async init() {
    await this.context.exposeBinding('__htAppeared', (_source, at: number, text: string) => {
      this.appeared.push({ at, text: String(text).replace(/\s+/g, ' ').trim() });
      if (this.appeared.length > 500) this.appeared.splice(0, 100);
    });
    await this.context.addInitScript(WATCH_TEXT);
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
        // Calls routed through Node skip Chrome's own throttling, so the slow network is added here.
        await this.networkDelay(route.request(), body);
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
      if (t.responseEnd > slowMs && !this.network) ht.warn(name, `${req.method()} ${new URL(req.url()).pathname} was slow: ${Math.round(t.responseEnd)} ms`);
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
        const err = await this.ht.humanError(line, this.name, text, e, this);
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
        // A check that pointed at nothing on the page (backend should ..., remember, at the end ...)
        // only needs its caption read: the full pause is for watching the page.
        const pause = this.ht.config.demo?.pauseAfterStepMs ?? 700;
        await this.page.waitForTimeout(opts.check && !this.focus ? Math.min(pause, 300) : pause);
      }
      rec.end = Date.now();
      // A finished step gives its time back: the time limit stops a test that is stuck,
      // not a long story (admin, operator and traveller one after another) that keeps moving.
      const info = this.ht.opts.testInfo;
      if (info.timeout > 0) info.setTimeout(info.timeout + (rec.end - rec.start));
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
    name = this.ht.fill(name);
    this.scope = { name, kind };
    try {
      await this.expect(this.root as Locator, `I can't find a ${kind ?? 'section'} called "${name}" on the page.`).toBeVisible();
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
    await this.expect(any.first(), `I can't find ${what}.`).toBeVisible();
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
    url = this.ht.fill(url);
    this.markAction();
    await this.page.goto(url);
  }

  async reload() {
    this.markAction();
    await this.page.reload();
  }

  async type(value: string, field: string) {
    value = this.ht.fill(value);
    const loc = await this.field(field);
    await this.noteFocus(loc);
    this.markAction();
    const { max, kind } = await loc.evaluate((el) => ({
      max: (el as HTMLInputElement).maxLength ?? -1,
      kind: el instanceof HTMLInputElement ? el.type : '',
    })).catch(() => ({ max: -1, kind: '' }));
    // The browser's own date, time, colour and slider inputs: always set whole, also in demo runs.
    // Typed key by key, their parts (month, day, year ...) follow the browser's language, so
    // "2027-09-25" leaves a date box empty, and the form then refuses to send without a word.
    // fill() takes the one format every browser understands, and says so when the value isn't in it.
    const format = SET_WHOLE[kind];
    if (format) {
      try {
        await loc.fill(value);
      } catch (e) {
        if (!/malformed value/i.test(String((e as Error)?.message ?? e))) throw e;
        throw new Error(`"${field}" is a ${format.what} input: write the value as ${format.example}, not "${value}".`);
      }
      return;
    }
    // A code split over one-digit boxes (maxlength="1"): fill() would keep only the first digit.
    // Typed key by key like a person, each key goes to the box the page moved the focus to.
    if (DEMO || (max > 0 && value.length > max)) {
      await loc.fill('');
      await loc.pressSequentially(value, { delay: DEMO ? this.ht.config.demo?.typingDelayMs ?? 60 : 30 });
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
    this.markAction();
    await loc.fill(today);
  }

  async choose(option: string, field: string) {
    option = this.ht.fill(option);
    const loc = await this.field(field);
    await this.noteFocus(loc);
    this.markAction();
    const tag = await loc.evaluate((e) => e.tagName.toLowerCase());
    if (tag === 'select') {
      await loc.selectOption({ label: option });
      return;
    }
    // A custom dropdown (Radix, shadcn, Headless UI ...): open it, then pick the option, which may render outside the section.
    if (DEMO) await this.highlight(loc);
    await loc.click();
    // Opened before its data arrived, a dropdown can stay empty until it is opened again:
    // close it and open it again, the way a person would, until the usual wait runs out.
    const until = Date.now() + this.expectTimeout;
    while (Date.now() < until && !(await this.page.getByRole('option').count())) {
      await this.page.getByRole('option').first().waitFor({ timeout: 1000 }).catch(() => {});
      if (await this.page.getByRole('option').count()) break;
      await this.page.keyboard.press('Escape');
      await loc.click();
    }
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
      await this.expect(exact).toBeVisible({ timeout: 2000 });
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
      await this.expect(labelled.or(near).first(), `I can't find a file input for "${field}"${where}.`).toBeAttached();
      loc = (await labelled.count()) ? labelled.first() : near.first();
    }
    if (!loc) {
      await this.expect(inputs.first(), `I can't find a file input${where}.`).toBeAttached();
      const n = await inputs.count();
      if (n > 1) throw new Error(`There are ${n} file inputs${where}. Say which one: upload "${file}" to "<the text next to it>".`);
      loc = inputs.first();
    }
    if (DEMO) await this.highlight(loc).catch(() => {});
    this.markAction();
    await loc.setInputFiles(full);
  }

  async press(key: string) {
    this.markAction();
    await this.page.keyboard.press(key);
  }

  async click(name: string, role?: string) {
    name = this.ht.fill(name);
    const loc = await this.clickable(name, role);
    await this.noteFocus(loc);
    if (DEMO) await this.highlight(loc);
    this.markAction();
    await loc.click();
    this.lastClicked = loc;
  }

  async see(text: string) {
    text = this.ht.fill(text);
    const loc = this.root.getByText(text).first();
    const deadline = Date.now() + this.expectTimeout;
    for (;;) {
      if (await loc.isVisible().catch(() => false)) {
        await this.noteFocus(loc);
        return;
      }
      // Gone again already: a toast that showed after the last action and closed before this line ran.
      // Not inside a section: the text was seen on the page, but where on it isn't known.
      if (!this.scope && this.appearedSinceAction(text)) return;
      if (Date.now() >= deadline) break;
      await sleep(100);
    }
    const similar = await this.similarText(text);
    throw new Error(`"${text}" should be visible${this.scope ? ` inside "${this.scope.name}"` : ' on the page'}, but it isn't.` +
      (similar.length ? `\nInstead, ${this.scope ? 'that part of the page' : 'the page'} shows: ${similar.map((t) => `"${t}"`).join(', ')}` : ''));
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
    text = this.ht.fill(text);
    await this.expect(this.root.getByText(text).first(), `"${text}" should NOT be visible, but it is.`).toBeHidden();
  }

  async onPage(pathname: string) {
    await expect.poll(() => new URL(this.page.url()).pathname, { message: `The browser should be on ${pathname}.` }).toBe(pathname);
  }

  async shouldBe(name: string, state: 'enabled' | 'disabled' | 'visible' | 'hidden' | 'focused', role?: string) {
    name = this.ht.fill(name);
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
    if (state === 'enabled') await this.expect(loc, msg).toBeEnabled();
    if (state === 'disabled') await this.expect(loc, msg).toBeDisabled();
    if (state === 'focused') await this.expect(loc, msg).toBeFocused();
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
    pathname = this.ht.fill(pathname);
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

  /** An API call as this user, with their login. `data` is sent as JSON. */
  async send(method: string, pathname: string, data?: unknown) {
    const url = this.ht.apiURL(pathname);
    if (!this.ht.allowsHost(url.toString())) throw new Error(this.ht.blockedError(url.toString(), 'call'));
    // The login's cookies go with it; its token too, the way the page sends it (many APIs read only the header).
    const session = this.ht.config.users[this.name]?.email ? await this.ht.login(this.name) : undefined;
    const req = {
      method,
      ...(session?.token ? { headers: { Authorization: `Bearer ${session.token}` } } : {}),
      ...(data !== undefined ? { data } : {}),
    };
    try {
      return await this.context.request.fetch(url.toString(), req);
    } catch (e) {
      if (!/has been closed/.test((e as Error).message)) throw e;
      // The browser is already gone (a test that ran out of time is closed before its clean-up):
      // the login still works without it. Not disposed, so the reply can still be read.
      const api = await apiRequest.newContext(session ? { storageState: { cookies: session.cookies, origins: [] } } : {});
      return api.fetch(url.toString(), req);
    }
  }

  async call(method: string, pathname: string, body?: string) {
    this.markAction();
    pathname = this.ht.fill(pathname);
    const data = body !== undefined ? this.ht.fillBody(body) : undefined;
    const res = await this.send(method, pathname, data);
    const text = res.text().catch(() => null);
    const url = this.ht.apiURL(pathname);
    this.log.push({
      method, path: url.pathname, line: this.ht.currentLine, at: Date.now(), status: res.status(), body: text,
      step: this.stepIndex, query: [...new Set(url.searchParams.keys())],
      bodyKeys: data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data) : [],
    });
    this.lastReply = { label: `${method} ${url.pathname}`, status: res.status(), text: () => text };
  }

  /** "remember data.id as ferry": keep a field of the last reply, for {ferry} in later steps. */
  async remember(field: string, name: string) {
    const body = await this.replyJson();
    field = this.ht.fill(field);
    const value = pick(body, field);
    if (value === undefined || value === null) {
      throw new Error(`The ${this.reply().label} reply has no ${field}.\nReply body: ${short(body)}`);
    }
    if (typeof value === 'object') {
      throw new Error(`${field} in the ${this.reply().label} reply is a list or an object, not one value.\n` +
        `Pick one field inside it, like ${field}.id\nReply body: ${short(body)}`);
    }
    this.ht.vars.set(name.trim().toLowerCase(), value);
  }

  /** "at the end, call DELETE /api/ferries/{ferry}": undo it when the test ends, even when it fails. */
  async atTheEnd(method: string, pathname: string, body?: string) {
    // Filled in now: {ferry} is the ferry of this moment, even if it is remembered again later.
    this.ht.cleanups.push({
      user: this, line: this.ht.currentLine, method, path: this.ht.fill(pathname),
      data: body !== undefined ? this.ht.fillBody(body) : undefined,
    });
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

  // ---------------- email ----------------

  /** The address a step means: the one written in it, or this user's email from the config. */
  private mailAddress(to?: string): string {
    if (to) return this.ht.fill(to).trim().toLowerCase();
    const own = this.ht.config.users[this.name]?.email;
    if (!own) {
      throw new Error(`${this.name} has no email in humantest.config.json, so I don't know where to look.\n` +
        `Write the address in the step, like  "rahim@test.com" should get an email "Welcome"`);
    }
    return own.toLowerCase();
  }

  private mailbox(): Email[] {
    if (!this.ht.config.email?.port) {
      throw new Error('There is no test mailbox. Add  "email": { "port": 2525 }  to humantest.config.json, and point the app\'s SMTP settings at localhost:2525.');
    }
    return allMail().slice(this.ht.mailFrom) as Email[];
  }

  /** What this test's mailbox holds, for an error message. */
  private mailSummary(): string {
    const got = this.mailbox();
    if (!got.length) {
      return `No email arrived at all during this test. Is the app's SMTP set to localhost:${this.ht.config.email!.port} (no TLS)?`;
    }
    return `Emails this test received:\n${got.map((m) => `   • to ${m.to.join(', ')}: "${m.subject}"`).join('\n')}`;
  }

  /** "Rahim should get an email "Verify Your Email"" (or should NOT get one). */
  async expectEmail(to: string | undefined, subject: string | undefined, negate: boolean) {
    const address = this.mailAddress(to);
    const want = subject ? this.ht.fill(subject).toLowerCase() : undefined;
    const matches = (m: Email) => !this.ht.mailTaken.has(m.seq) && m.to.includes(address) && (!want || m.subject.toLowerCase().includes(want));
    const what = `an email${subject ? ` "${this.ht.fill(subject)}"` : ''} to ${address}`;
    const cfg = this.ht.config.email;
    if (negate) {
      const hit = await waitForMail(() => this.mailbox().find(matches), (cfg?.quietSeconds ?? 3) * 1000);
      if (hit) throw new Error(`${what[0].toUpperCase()}${what.slice(1)} should NOT have been sent, but it was: "${hit.subject}".`);
      return;
    }
    const slower = this.network ? NETWORKS[this.network].slower : 1;
    const hit = await waitForMail(() => this.mailbox().find(matches), (cfg?.waitSeconds ?? 10) * 1000 * slower);
    if (!hit) throw new Error(`${what[0].toUpperCase()}${what.slice(1)} never arrived (waited ${(cfg?.waitSeconds ?? 10) * slower}s).\n${this.mailSummary()}`);
    this.ht.mailTaken.add(hit.seq);
    this.ht.email = hit;
  }

  private currentEmail(): Email {
    if (!this.ht.email) throw new Error('There is no email to look at yet.\nAdd a line like  Rahim should get an email "Welcome"  before this one.');
    return this.ht.email;
  }

  async emailContains(text: string, negate: boolean) {
    const m = this.currentEmail();
    const want = this.ht.fill(text);
    const flat = (s: string) => s.replace(/\s+/g, ' ').toLowerCase();
    const found = flat(`${m.subject}\n${m.text}`).includes(flat(want));
    if (found === negate) {
      throw new Error(`The email "${m.subject}" ${negate ? 'should NOT contain' : 'should contain'} "${want}", but it ${found ? 'does' : "doesn't"}.\n` +
        `Its text: ${short(m.text, 400)}`);
    }
  }

  /** "remember the code in the email as otp" / "remember the "Verify" link in the email as link". */
  async rememberFromEmail(what: 'code' | 'link', name: string, linkText?: string) {
    const m = this.currentEmail();
    let value: string | undefined;
    if (what === 'code') {
      // A 6-digit code first (the usual OTP), then any other 4 to 8 digits.
      const hay = `${m.subject}\n${m.text}`;
      value = /(?<![\d-])\d{6}(?![\d-])/.exec(hay)?.[0] ?? /(?<![\d-])\d{4,8}(?![\d-])/.exec(hay)?.[0];
      if (!value) throw new Error(`I can't find a code (4 to 8 digits) in the email "${m.subject}".\nIts text: ${short(m.text, 400)}`);
    } else {
      value = this.emailLink(m, linkText).href;
    }
    this.ht.vars.set(name.trim().toLowerCase(), value);
  }

  private emailLink(m: Email, linkText?: string) {
    const want = linkText ? this.ht.fill(linkText).toLowerCase() : undefined;
    const link = want ? m.links.find((l) => l.text.toLowerCase().includes(want)) : m.links[0];
    if (!link) {
      const all = m.links.map((l) => `"${l.text}" → ${l.href}`).join('\n   ');
      throw new Error(`The email "${m.subject}" has no link${want ? ` with the words "${linkText}"` : ''}.` +
        (all ? `\nIts links:\n   ${all}` : ''));
    }
    return link;
  }

  /** "open the link in the email" / "click "Verify my email" in the email": go where it points. */
  async openEmailLink(linkText?: string) {
    const link = this.emailLink(this.currentEmail(), linkText);
    await this.page.goto(link.href);
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
      await this.networkDelay(route.request(), text);
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
    // Playwright resets Chrome's network settings for this, so a slow network is put back.
    if (this.network) await this.setNetwork(this.network);
  }

  /** Make this user's internet as slow as a mobile network (or normal again with `undefined`). */
  async setNetwork(name: NetworkName | undefined) {
    const browser = this.ht.opts.browser.browserType().name();
    if (browser !== 'chromium') throw new Error(`A slow network can only be simulated in Chromium (this test runs in ${browser}).`);
    this.network = name;
    const n = name ? NETWORKS[name] : undefined;
    // Pages, scripts, styles and images: Chrome slows them down itself.
    for (const page of this.context.pages()) {
      const cdp = await this.context.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', n
        ? { offline: this.offline, latency: n.latency, downloadThroughput: n.down, uploadThroughput: n.up }
        : { offline: this.offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      await cdp.detach();
    }
    // Everything takes longer, so the test may too.
    const info = this.ht.opts.testInfo;
    if (n && info.timeout > 0) info.setTimeout(Math.max(info.timeout, Math.round(info.project.timeout * n.slower * 1.5)));
  }

  /** How long an API call takes on this user's slow network: the delay, then the bytes sent and received. */
  private async networkDelay(req: Request, body: string | null) {
    if (!this.network) return;
    const n = NETWORKS[this.network];
    const sent = req.postDataBuffer()?.length ?? 0;
    const received = Buffer.byteLength(body ?? '');
    await sleep(n.latency + (sent / n.up + received / n.down) * 1000);
  }

  /** `expect`, waiting longer on a slow network: the page is slower to show things. */
  private get expect() {
    if (!this.network) return expect;
    return expect.configure({ timeout: this.expectTimeout });
  }

  /** How long a check waits (the config's expect timeout), longer on a slow network. */
  private get expectTimeout() {
    // The config's expect.timeout is on the project at run time, though Playwright's types leave it out.
    const base = (this.ht.opts.testInfo.project as { expect?: { timeout?: number } }).expect?.timeout ?? 5000;
    return this.network ? Math.round(base * NETWORKS[this.network].slower) : base;
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

const getPath = (v: unknown, p: string): unknown => pick(v, p);
