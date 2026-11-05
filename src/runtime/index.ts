// HumanTest runtime: what the generated Playwright specs call.
// - every user gets their own browser context (separate login, cookies, video)
// - every API call the page makes is recorded, so tests can check the backend
// - a watchdog reports hidden problems (5xx, JS errors, slow APIs) even when nobody asserted them
// - demo mode (HUMANTEST_DEMO=1) slows things down and shows captions for readable videos

import fs from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import path from 'node:path';
import {
  test, expect, request as apiRequest,
  type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page,
  type Request, type Response, type TestInfo,
} from '@playwright/test';

const DEMO = !!process.env.HUMANTEST_DEMO;

interface Config {
  baseURL: string;
  apiPrefix?: string;
  login?: { endpoint: string };
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
}
export type StateFn = (ctx: StateContext) => Promise<void>;

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Warning { line: number; user: string; message: string }

export class Scenario {
  readonly users: User[] = [];
  readonly warnings: Warning[] = [];
  currentLine = 0;

  constructor(readonly opts: Options, readonly config: Config) {}

  warn(user: string, message: string) {
    if (this.warnings.some((w) => w.message === message && w.user === user)) return;
    this.warnings.push({ line: this.currentLine, user, message });
  }

  async startWith(line: number, name: string, args: string[], fn: StateFn) {
    this.currentLine = line;
    await test.step(`line ${line} · start with: ${name}`, async () => {
      const api = await apiRequest.newContext({ baseURL: this.config.baseURL });
      try {
        await fn({ api, args });
      } catch (e) {
        throw this.humanError(line, 'setup', `Start with: ${name}`, e);
      } finally {
        await api.dispose();
      }
    }, { box: true });
  }

  async user(line: number, name: string): Promise<User> {
    const info = this.opts.testInfo;
    const context = await this.opts.browser.newContext({
      baseURL: this.config.baseURL,
      viewport: { width: 1280, height: 720 },
      recordVideo: DEMO ? { dir: info.outputPath(`videos-${fileSlug(name)}`), size: { width: 1280, height: 720 } } : undefined,
    });
    const page = await context.newPage();
    const u = new User(this, name, context, page);
    await u.init();
    this.users.push(u);

    const creds = this.config.users[name] ?? {};
    if (creds.email) {
      await test.step(`line ${line} · log in as ${name} (${creds.email})`, async () => {
        const endpoint = this.config.login?.endpoint ?? '/api/login';
        const res = await context.request.post(new URL(endpoint, this.config.baseURL).toString(), {
          data: { email: creds.email, password: creds.password },
        });
        if (!res.ok()) {
          throw this.humanError(line, name, `log in as ${name}`,
            new Error(`${endpoint} replied ${res.status()}: ${short(await res.text())}\nCheck the email/password for "${name}" in humantest.config.json.`));
        }
      }, { box: true });
    }
    return u;
  }

  humanError(line: number, user: string, text: string, err: unknown, u?: User): Error {
    if ((err as any)?.humantest) return err as Error;
    const raw = stripAnsi(String((err as any)?.message ?? err)).split(/\n\s*Call log:/)[0];
    const why = raw.split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(0, 10).map((l) => `      ${l}`).join('\n');
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
    }
    parts.push('', `   📄 ${this.opts.source}:${line}`);
    const out = new HumanError(parts.join('\n'));
    out.stack = out.message;
    return out;
  }

  async finish(passed: boolean) {
    const info = this.opts.testInfo;
    const videoDir = path.join(process.cwd(), 'humantest-videos', fileSlug(info.title));
    for (const u of this.users) {
      const video = u.page.video();
      await u.context.close().catch(() => {});
      if (video) {
        fs.mkdirSync(videoDir, { recursive: true });
        const dest = path.join(videoDir, `${fileSlug(u.name)}.webm`);
        await video.saveAs(dest).catch(() => {});
        if (fs.existsSync(dest)) {
          await info.attach(`🎬 ${u.name}`, { path: dest, contentType: 'video/webm' });
          info.annotations.push({ type: 'video', description: `${u.name}: ${path.relative(process.cwd(), dest)}` });
        }
      }
    }
    for (const w of this.warnings) {
      info.annotations.push({ type: 'watchdog', description: `line ${w.line} · ${w.user} · ${w.message}` });
    }
    if (passed && this.warnings.length && this.config.watchdog?.failTestOnWarning) {
      throw new HumanError(`The test steps passed, but the watchdog found ${this.warnings.length} problem(s):\n` +
        this.warnings.map((w) => `   ⚠ line ${w.line} · ${w.user} · ${w.message}`).join('\n'));
    }
  }
}

interface LogEntry {
  method: string;
  path: string;
  line: number;
  status?: number;
  mocked?: boolean;
  req?: Request;
  body?: Promise<string | null>;
}

interface Reply { label: string; status: number; text: () => Promise<string | null> }

export class User {
  readonly log: LogEntry[] = [];
  private mark = 0;
  private lastReply?: Reply;
  private readonly mocked = new WeakSet<Request>();
  /** Reply bodies, captured on the Node side so they survive page navigations. */
  private readonly bodies = new WeakMap<Request, string>();
  private offline = false;
  private caption?: string;

  /** Route every API call through Node so we always have its reply body. Simulations are added later and run first. */
  async init() {
    const prefix = this.ht.config.apiPrefix ?? '/api';
    await this.context.route((url) => url.pathname.startsWith(prefix), async (route) => {
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

  constructor(readonly ht: Scenario, readonly name: string, readonly context: BrowserContext, readonly page: Page) {
    const prefix = ht.config.apiPrefix ?? '/api';
    const slowMs = ht.config.watchdog?.slowApiMs ?? 2000;
    const isApi = (r: Request) => { try { return new URL(r.url()).pathname.startsWith(prefix); } catch { return false; } };
    const entryOf = (r: Request) => this.log.find((e) => e.req === r);

    context.on('request', (req) => {
      if (!isApi(req)) return;
      this.log.push({ method: req.method(), path: new URL(req.url()).pathname, line: ht.currentLine, req });
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
      if (this.mocked.has(req) || this.offline || /ABORTED/i.test(err)) return;
      ht.warn(name, `${req.method()} ${req.url()} failed: ${err}`);
    });
    page.on('pageerror', (err) => ht.warn(name, `JavaScript error on the page: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !/Failed to load resource/i.test(msg.text())) ht.warn(name, `Console error: ${msg.text()}`);
    });
    if (DEMO) page.on('load', () => { void this.showCaption(); });
  }

  // ---------------- step wrapper ----------------

  async step(line: number, text: string, fn: (u: User) => Promise<void>) {
    await test.step(`line ${line} · ${this.name} · ${text}`, async () => {
      this.ht.currentLine = line;
      this.caption = `👤 ${this.name}   ·   line ${line}   ·   ${text}`;
      await this.showCaption();
      try {
        await fn(this);
      } catch (e) {
        throw this.ht.humanError(line, this.name, text, e, this);
      }
      if (DEMO) {
        await this.showCaption();
        await this.page.waitForTimeout(this.ht.config.demo?.pauseAfterStepMs ?? 700);
      }
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
    ];
  }

  /** Wait until one of the candidates is visible, then use the best one. */
  private async pick(candidates: Locator[], what: string): Promise<Locator> {
    let any = candidates[0];
    for (const c of candidates.slice(1)) any = any.or(c);
    await expect(any.first(), `I can't find ${what}.`).toBeVisible();
    for (const c of candidates) {
      if (await c.first().isVisible().catch(() => false)) return c.first();
    }
    return any.first();
  }

  private clickable(name: string, role?: string) {
    const where = this.scope ? ` inside "${this.scope.name}"` : '';
    return this.pick(this.clickableCandidates(name, role), `a ${role ?? 'button, link or menu item'} called "${name}"${where}`);
  }

  private field(name: string) {
    const where = this.scope ? ` inside "${this.scope.name}"` : '';
    return this.pick(this.fieldCandidates(name), `an input or dropdown called "${name}"${where} (looked for a label, placeholder or name)`);
  }

  // ---------------- browser actions ----------------

  async goTo(url: string) {
    this.mark = this.log.length;
    await this.page.goto(url);
  }

  async reload() {
    this.mark = this.log.length;
    await this.page.reload();
  }

  async type(value: string, field: string) {
    const loc = await this.field(field);
    this.mark = this.log.length;
    if (DEMO) {
      await loc.fill('');
      await loc.pressSequentially(value, { delay: this.ht.config.demo?.typingDelayMs ?? 60 });
    } else {
      await loc.fill(value);
    }
  }

  async choose(option: string, field: string) {
    const loc = await this.field(field);
    this.mark = this.log.length;
    const tag = await loc.evaluate((e) => e.tagName.toLowerCase());
    if (tag === 'select') {
      await loc.selectOption({ label: option });
      return;
    }
    // A custom dropdown (Radix, shadcn, Headless UI ...): open it, then pick the option, which may render outside the section.
    if (DEMO) await this.highlight(loc);
    await loc.click();
    const opt = this.page.getByRole('option', { name: option, exact: true });
    await expect(opt, `The "${field}" dropdown opened, but it has no option called "${option}".`).toBeVisible();
    if (DEMO) await this.highlight(opt);
    await opt.click();
  }

  async press(key: string) {
    this.mark = this.log.length;
    await this.page.keyboard.press(key);
  }

  async click(name: string, role?: string) {
    const loc = await this.clickable(name, role);
    if (DEMO) await this.highlight(loc);
    this.mark = this.log.length;
    await loc.click();
  }

  async see(text: string) {
    try {
      await expect(this.root.getByText(text).first(), `"${text}" should be visible${this.scope ? ` inside "${this.scope.name}"` : ' on the page'}, but it isn't.`).toBeVisible();
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
    while (!(entry = this.log.slice(this.mark).find((e) => e.method === method && e.path === pathname)) && Date.now() < deadline) {
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
    const res = await this.context.request.fetch(new URL(pathname, this.ht.config.baseURL).toString(), { method });
    const body = res.text().catch(() => null);
    this.log.push({ method, path: pathname, line: this.ht.currentLine, status: res.status(), body });
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
    if (!DEMO || !this.caption) return;
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
