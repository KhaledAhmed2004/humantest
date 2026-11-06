// The whole HumanTest vocabulary lives here.
// Each sentence = a regex (forgiving: case-insensitive, optional words) + how to explain it + what code to emit.
// Order matters: more specific sentences come before more general ones.

export type StepArgs = Record<string, any>;

export interface StepDef {
  kind: string;
  /** An example sentence. Used in docs and in "did you mean" suggestions. */
  template: string;
  re: RegExp;
  parse: (m: RegExpMatchArray) => StepArgs;
  explain: (a: StepArgs) => string;
  /** Code that runs on the user object `u`, e.g. `u.click("Sign up")`. */
  emit: (a: StepArgs) => string;
}

const s = (v: unknown) => JSON.stringify(v);
const METHOD = '(GET|POST|PUT|PATCH|DELETE)';
const PATH = '(\\/\\S*)';
const rx = (src: string) => new RegExp(`^${src}$`, 'i');

export const STEP_DEFS: StepDef[] = [
  // ---------------- browser actions ----------------
  {
    kind: 'goTo',
    template: 'go to signup page',
    re: rx(`(?:go(?:es)? to|opens?|visits?|navigates? to)\\s+(?:the\\s+)?(?:"([^"]+)"|(.+?))`),
    parse: (m) => ({ page: m[1] ?? m[2] }),
    explain: (a) => `open ${a.path}`,
    emit: (a) => `u.goTo(${s(a.path)})`,
  },
  {
    kind: 'reload',
    template: 'reload the page',
    re: rx(`(?:reloads?|refresh(?:es)?)(?:\\s+the)?(?:\\s+page)?`),
    parse: () => ({}),
    explain: () => 'reload the current page',
    emit: () => 'u.reload()',
  },
  {
    kind: 'type',
    template: 'type "rahim@test.com" in email',
    re: rx(`(?:types?|enters?|writes?|fills? in)\\s+"([^"]*)"\\s+(?:in|into)\\s+(?:the\\s+)?(?:"([^"]+)"|(.+?))(?:\\s+(?:field|box|input))?`),
    parse: (m) => ({ value: m[1], field: m[2] ?? m[3] }),
    explain: (a) => `find the input labelled "${a.field}" and type "${a.value}"`,
    emit: (a) => `u.type(${s(a.value)}, ${s(a.field)})`,
  },
  {
    kind: 'typeToday',
    template: 'fill in today\'s date in "Last treated on"',
    re: rx(`(?:types?|enters?|fills? in)\\s+today(?:'s)?(?:\\s+date)?\\s+(?:in|into)\\s+(?:the\\s+)?(?:"([^"]+)"|(.+?))(?:\\s+(?:field|box|input))?`),
    parse: (m) => ({ field: m[1] ?? m[2] }),
    explain: (a) => `type today's date (on the test machine) into "${a.field}"`,
    emit: (a) => `u.typeToday(${s(a.field)})`,
  },
  {
    kind: 'choose',
    template: 'choose "Caries" for Condition',
    re: rx(`(?:chooses?|selects?|picks?)\\s+"([^"]+)"\\s+(?:for|in|from)\\s+(?:the\\s+)?(?:"([^"]+)"|(.+?))(?:\\s+(?:field|dropdown|list|menu))?`),
    parse: (m) => ({ option: m[1], field: m[2] ?? m[3] }),
    explain: (a) => `open the "${a.field}" dropdown and pick "${a.option}"`,
    emit: (a) => `u.choose(${s(a.option)}, ${s(a.field)})`,
  },
  {
    kind: 'key',
    template: 'press Escape',
    re: rx(`(?:press(?:es)?|hits?)\\s+(?:the\\s+)?(Escape|Esc|Enter|Tab|Space|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight)(?:\\s+key)?`),
    parse: (m) => ({ key: ({ esc: 'Escape' } as Record<string, string>)[m[1].toLowerCase()] ?? m[1][0].toUpperCase() + m[1].slice(1) }),
    explain: (a) => `press the ${a.key} key on the keyboard`,
    emit: (a) => `u.press(${s(a.key)})`,
  },
  {
    kind: 'click',
    template: 'click "Sign up"',
    re: rx(`(?:clicks?|press(?:es)?|taps?)\\s+(?:on\\s+)?(?:the\\s+)?"([^"]+)"(?:\\s+(button|link))?`),
    parse: (m) => ({ name: m[1], role: m[2]?.toLowerCase() }),
    explain: (a) => `click the ${a.role ?? 'button or link'} named "${a.name}"`,
    emit: (a) => `u.click(${s(a.name)}${a.role ? `, ${s(a.role)}` : ''})`,
  },
  {
    kind: 'click',
    template: 'click Sign up button',
    re: rx(`(?:clicks?|press(?:es)?|taps?)\\s+(?:on\\s+)?(?:the\\s+)?(.+?)\\s+(button|link)`),
    parse: (m) => ({ name: m[1], role: m[2].toLowerCase() }),
    explain: (a) => `click the ${a.role} named "${a.name}"`,
    emit: (a) => `u.click(${s(a.name)}, ${s(a.role)})`,
  },

  // ---------------- what the user sees ----------------
  {
    kind: 'notSee',
    template: 'should not see "Access denied"',
    re: rx(`(?:i\\s+)?(?:should\\s+not|shouldn't|should\\s+no\\s+longer)\\s+see\\s+"([^"]+)"`),
    parse: (m) => ({ text: m[1] }),
    explain: (a) => `check that "${a.text}" is NOT visible on screen`,
    emit: (a) => `u.notSee(${s(a.text)})`,
  },
  {
    kind: 'see',
    template: 'should see "Welcome, Rahim"',
    re: rx(`(?:i\\s+)?(?:should\\s+)?(?:sees?|expects?\\s+to\\s+see)\\s+"([^"]+)"`),
    parse: (m) => ({ text: m[1] }),
    explain: (a) => `check that "${a.text}" is visible on screen`,
    emit: (a) => `u.see(${s(a.text)})`,
  },
  {
    kind: 'onPage',
    template: 'should still be on signup page',
    re: rx(`(?:i\\s+)?should\\s+(?:still\\s+)?be\\s+on\\s+(?:the\\s+)?(?:"([^"]+)"|(.+?))`),
    parse: (m) => ({ page: m[1] ?? m[2] }),
    explain: (a) => `check that the browser is on ${a.path}`,
    emit: (a) => `u.onPage(${s(a.path)})`,
  },
  {
    kind: 'elementState',
    template: '"Sign up" button should be enabled',
    re: rx(`(?:the\\s+)?"([^"]+)"(?:\\s+(button|link|field|dialog|panel|section))?\\s+(?:should\\s+be|is)\\s+(enabled|disabled|visible|hidden|focused|closed|open)(?:\\s+again)?`),
    parse: (m) => {
      const state = m[3].toLowerCase();
      return { name: m[1], role: m[2]?.toLowerCase(), state: state === 'closed' ? 'hidden' : state === 'open' ? 'visible' : state };
    },
    explain: (a) => `check that the ${a.role ?? 'element'} "${a.name}" is ${a.state}`,
    emit: (a) => `u.shouldBe(${s(a.name)}, ${s(a.state)}${a.role ? `, ${s(a.role)}` : ''})`,
  },
  {
    kind: 'a11y',
    template: 'the page should have no accessibility problems',
    re: rx(`(?:the\\s+)?page\\s+should\\s+(?:have\\s+no\\s+accessibility\\s+(?:problems|issues|violations)|be\\s+accessible)`),
    parse: () => ({}),
    explain: () => 'scan the page with axe for WCAG accessibility problems',
    emit: () => 'u.noAccessibilityProblems()',
  },

  // ---------------- what happens in the backend ----------------
  {
    kind: 'noRequest',
    template: 'backend should not receive any request',
    re: rx(`backend\\s+should\\s+not\\s+receive\\s+any\\s+requests?`),
    parse: () => ({}),
    explain: () => 'check that the page did NOT call the backend since the last action',
    emit: () => 'u.noBackendRequest()',
  },
  {
    kind: 'receive',
    template: 'backend should receive POST /api/users',
    re: rx(`backend\\s+should\\s+receive\\s+${METHOD}\\s+${PATH}`),
    parse: (m) => ({ method: m[1].toUpperCase(), path: m[2] }),
    explain: (a) => `wait until the page sends ${a.method} ${a.path} to the backend (remember its reply)`,
    emit: (a) => `u.backendReceives(${s(a.method)}, ${s(a.path)})`,
  },
  {
    kind: 'replyStatus',
    template: 'backend should reply 201 Created',
    re: rx(`(?:backend\\s+should\\s+(?:reply|respond)(?:\\s+with)?|(?:the\\s+)?reply\\s+status\\s+should\\s+be)\\s+(\\d{3})(?:\\s+[A-Za-z][A-Za-z ]*)?`),
    parse: (m) => ({ status: Number(m[1]) }),
    explain: (a) => `check that the last backend reply had status ${a.status}`,
    emit: (a) => `u.replyStatus(${a.status})`,
  },
  {
    kind: 'replyContains',
    template: 'reply should not contain password',
    re: rx(`(?:the\\s+)?reply\\s+should\\s+(not\\s+)?(?:contain|include|have)\\s+(?:"([^"]+)"|([\\w.]+))`),
    parse: (m) => ({ negate: !!m[1], key: m[2] ?? m[3] }),
    explain: (a) => `check that the last reply ${a.negate ? 'does NOT contain' : 'contains'} "${a.key}" (as a field or a value)`,
    emit: (a) => `u.replyContains(${s(a.key)}, ${a.negate})`,
  },
  {
    kind: 'replyField',
    template: 'reply total should be 1',
    re: rx(`(?:the\\s+)?reply(?:'s)?\\s+([A-Za-z_][\\w.\\[\\]]*)\\s+should\\s+be\\s+(?:"([^"]*)"|(-?\\d+(?:\\.\\d+)?|true|false|null))`),
    parse: (m) => ({ field: m[1], value: m[2] !== undefined ? m[2] : JSON.parse(m[3]) }),
    explain: (a) => `check that the last reply's ${a.field} equals ${s(a.value)}`,
    emit: (a) => `u.replyField(${s(a.field)}, ${s(a.value)})`,
  },
  {
    kind: 'call',
    template: 'call GET /api/admin/users',
    re: rx(`call\\s+${METHOD}\\s+${PATH}`),
    parse: (m) => ({ method: m[1].toUpperCase(), path: m[2] }),
    explain: (a) => `call ${a.method} ${a.path} directly as this user (with their login) and remember the reply`,
    emit: (a) => `u.call(${s(a.method)}, ${s(a.path)})`,
  },

  // ---------------- simulate problems ----------------
  {
    kind: 'mockFail',
    template: 'when the server fails on POST /api/users',
    re: rx(`when\\s+(?:the\\s+)?server\\s+fails\\s+on\\s+${METHOD}\\s+${PATH}`),
    parse: (m) => ({ method: m[1].toUpperCase(), path: m[2] }),
    explain: (a) => `from now on, answer ${a.method} ${a.path} with a fake 500 server error`,
    emit: (a) => `u.simulateReply(${s(a.method)}, ${s(a.path)}, 500)`,
  },
  {
    kind: 'mockReply',
    template: 'when the server replies 401 on GET /api/me',
    re: rx(`when\\s+(?:the\\s+)?server\\s+(?:replies|responds)\\s+(\\d{3})\\s+on\\s+${METHOD}\\s+${PATH}`),
    parse: (m) => ({ status: Number(m[1]), method: m[2].toUpperCase(), path: m[3] }),
    explain: (a) => `from now on, answer ${a.method} ${a.path} with a fake ${a.status}`,
    emit: (a) => `u.simulateReply(${s(a.method)}, ${s(a.path)}, ${a.status})`,
  },
  {
    kind: 'mockSlow',
    template: 'when the server is slow on POST /api/users',
    re: rx(`when\\s+(?:the\\s+)?server\\s+is\\s+slow\\s+on\\s+${METHOD}\\s+${PATH}(?:\\s+by\\s+(\\d+(?:\\.\\d+)?)\\s+seconds?)?`),
    parse: (m) => ({ method: m[1].toUpperCase(), path: m[2], seconds: m[3] ? Number(m[3]) : 3 }),
    explain: (a) => `from now on, delay ${a.method} ${a.path} by ${a.seconds}s (then let the real server answer)`,
    emit: (a) => `u.simulateSlow(${s(a.method)}, ${s(a.path)}, ${a.seconds})`,
  },
  {
    kind: 'mockEmpty',
    template: 'when GET /api/products returns an empty list',
    re: rx(`when\\s+${METHOD}\\s+${PATH}\\s+returns\\s+(?:an\\s+)?empty\\s+list`),
    parse: (m) => ({ method: m[1].toUpperCase(), path: m[2] }),
    explain: (a) => `from now on, answer ${a.method} ${a.path} with an empty list []`,
    emit: (a) => `u.simulateReply(${s(a.method)}, ${s(a.path)}, 200, [])`,
  },
  {
    kind: 'offline',
    template: 'when the internet is off',
    re: rx(`when\\s+(?:the\\s+)?internet\\s+is\\s+(off|back(?:\\s+on)?|on)`),
    parse: (m) => ({ off: m[1].toLowerCase() === 'off' }),
    explain: (a) => (a.off ? 'turn this user\'s internet OFF' : 'turn this user\'s internet back ON'),
    emit: (a) => `u.setOffline(${a.off})`,
  },

  // ---------------- misc ----------------
  {
    kind: 'wait',
    template: 'wait 2 seconds',
    re: rx(`wait\\s+(\\d+(?:\\.\\d+)?)\\s+seconds?`),
    parse: (m) => ({ seconds: Number(m[1]) }),
    explain: (a) => `wait ${a.seconds} seconds`,
    emit: (a) => `u.wait(${a.seconds})`,
  },
];

/**
 * Steps that make the app do something, and so cause API calls. Every other step only checks,
 * waits or sets up a simulation; calls sent while it runs were caused by the action before it
 * (a page load's data fetches usually land during the next "should see").
 */
export const ACTION_KINDS = new Set(['goTo', 'reload', 'type', 'typeToday', 'choose', 'key', 'click', 'call']);

// "in "Selected tooth", click "Add issue""  /  "in the "Add issue" dialog: choose ..."
const SCOPE = /^(?:in|inside|within)\s+(?:the\s+)?"([^"]+)"(?:\s+(dialog|panel|section|region|form|table|row|menu|list))?\s*[,:]\s*(.+)$/i;

export function matchStep(text: string): { def: StepDef; args: StepArgs } | undefined {
  let clean = text.replace(/\s+/g, ' ').replace(/\.$/, '').trim();
  let scope: { name: string; kind?: string } | undefined;
  const sm = clean.match(SCOPE);
  if (sm) {
    scope = { name: sm[1], kind: sm[2]?.toLowerCase() };
    clean = sm[3];
  }
  for (const def of STEP_DEFS) {
    const m = clean.match(def.re);
    if (m) return { def, args: { ...def.parse(m), ...(scope ? { scope } : {}) } };
  }
  return undefined;
}

/** Explain a step, including its "in ..." part. */
export function explainStep(def: StepDef, a: StepArgs): string {
  const inner = def.explain(a);
  return a.scope ? `inside the ${a.scope.kind ?? 'section'} "${a.scope.name}": ${inner}` : inner;
}

/** Code for a step, including its "in ..." part. */
export function emitStep(def: StepDef, a: StepArgs): string {
  const inner = def.emit(a);
  return a.scope ? `u.within(${s(a.scope.name)}, ${s(a.scope.kind ?? null)}, () => ${inner})` : inner;
}
