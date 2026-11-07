// Conditions from the code, in plain English. Only what is understood is translated: anything
// else returns undefined, and the rule shows the code instead. A wrong translation is worse than none.
//   !departurePort || !departurePort.isActive  → "departure port is not found, or departure port is not active"
//   schedule.availableSeats < totalPassengers  → "schedule available seats is less than total passengers"
//   schedule.departureTime.getTime() <= Date.now() → "schedule departure time is now or in the past"

import ts from 'typescript';
import type { TsProject } from '../ts-project.mts';
import type { Condition } from './types.mts';

/** Names that only hold the real thing: `dto.departurePortId` reads as "departure port id". */
const CONTAINERS = new Set(['dto', 'data', 'payload', 'body', 'req', 'request', 'args', 'input', 'options', 'opts', 'params', 'query', 'this', 'ctx', 'value', 'values', 'props',
  // React state and forms: `formData.departurePortId` reads as "departure port id".
  'formData', 'form', 'state', 'prev', 'fields']);

/** React Query / form flags that mean "busy": `isPending`, `createMutation.isPending`, `isSubmitting`. */
// isPending, isSaving, isSingleDeleting, isBulkOperating: a request the page sent hasn't answered yet.
const BUSY = /^is([A-Z]\w*)?(Pending|Loading|Submitting|Saving|Fetching|Mutating|Deleting|Updating|Creating|Uploading|Operating|Processing)$/;

export interface Words { glossary?: Record<string, string> }

/** `departurePortId` → "departure port id"; `HTTPStatus` → "http status". */
export function words(name: string, w: Words = {}): string {
  if (w.glossary?.[name]) return w.glossary[name];
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase()
    .trim();
}

export function translate(p: TsProject, expr: ts.Expression, negate = false, w: Words = {}): Condition {
  const code = expr.getText().replace(/\s+/g, ' ');
  try {
    const text = new Humanizer(p, w).cond(expr, negate);
    return text === undefined ? { code: negate ? `!(${code})` : code } : { code: negate ? `!(${code})` : code, text };
  } catch {
    return { code };
  }
}

/** `switch (a) { case b: … }` → the condition "a is b". */
export function translateEquals(p: TsProject, a: ts.Expression, b: ts.Expression, w: Words = {}): Condition {
  const code = `${a.getText()} === ${b.getText()}`.replace(/\s+/g, ' ');
  const h = new Humanizer(p, w);
  const va = h.value(a), vb = h.value(b);
  return va !== undefined && vb !== undefined ? { code, text: `${va} is ${vb}` } : { code };
}

class Humanizer {
  private p: TsProject;
  private w: Words;
  constructor(p: TsProject, w: Words) {
    this.p = p;
    this.w = w;
  }

  /** A true/false condition. */
  cond(e: ts.Expression, neg: boolean): string | undefined {
    e = strip(e);
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) return this.cond(e.operand, !neg);
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
        // De Morgan: not (a and b) = not a, or not b.
        const and = (op === ts.SyntaxKind.AmpersandAmpersandToken) !== neg;
        // `a || (b && c)`: a part that mixes in the other kind is put in brackets, so it reads one way only.
        const part = (side: ts.Expression) => {
          const text = this.cond(side, neg);
          const s = strip(side);
          const mixed = ts.isBinaryExpression(s) && isLogical(s.operatorToken.kind) && s.operatorToken.kind !== op;
          return text !== undefined && mixed ? `(${text})` : text;
        };
        const parts = [part(e.left), part(e.right)];
        if (parts.some((x) => x === undefined)) return undefined;
        if (parts[0] === parts[1]) return parts[0];
        // `!x || !x.trim()`: "x is empty or only spaces" says both. `x && x.trim()`: "x has more than spaces".
        const [a, b] = parts as string[];
        if (b.startsWith(a) && b.slice(a.length) === ' or only spaces') return b;
        if (a.endsWith(' is set') && b === a.replace(/ is set$/, ' has more than spaces')) return b;
        return parts.join(and ? ', and ' : ', or ');
      }
      return this.compare(e, neg);
    }
    // `!text.trim()`: the text is empty or only spaces (which the browser's `required` lets through).
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && !e.arguments.length &&
      ['trim', 'trimStart', 'trimEnd', 'toLowerCase', 'toUpperCase'].includes(e.expression.name.text)) {
      const inner = this.cond(e.expression.expression, neg);
      if (!inner || !e.expression.name.text.startsWith('trim')) return inner;
      return inner.replace(/ is empty$/, ' is empty or only spaces').replace(/ is set$/, ' has more than spaces');
    }
    if (ts.isCallExpression(e)) return this.call(e, neg);
    // A value used as a condition: `if (schedule)`, `if (user.isActive)`.
    return this.truthy(e, neg);
  }

  private compare(e: ts.BinaryExpression, neg: boolean): string | undefined {
    const k = ts.SyntaxKind;
    let op: ts.SyntaxKind = e.operatorToken.kind;
    const NEG: Partial<Record<ts.SyntaxKind, ts.SyntaxKind>> = {
      [k.EqualsEqualsEqualsToken]: k.ExclamationEqualsEqualsToken, [k.ExclamationEqualsEqualsToken]: k.EqualsEqualsEqualsToken,
      [k.EqualsEqualsToken]: k.ExclamationEqualsToken, [k.ExclamationEqualsToken]: k.EqualsEqualsToken,
      [k.LessThanToken]: k.GreaterThanEqualsToken, [k.GreaterThanEqualsToken]: k.LessThanToken,
      [k.GreaterThanToken]: k.LessThanEqualsToken, [k.LessThanEqualsToken]: k.GreaterThanToken,
    };
    // 'response' in verified → "verified has response"
    if (e.operatorToken.kind === k.InKeyword && (ts.isStringLiteral(e.left) || ts.isNoSubstitutionTemplateLiteral(e.left))) {
      const v = this.value(e.right);
      return v === undefined ? undefined : `${v} ${neg ? 'does not have' : 'has'} ${words(e.left.text, this.w)}`;
    }
    // error instanceof Stripe.errors.StripeError → "error is a stripe error"
    if (e.operatorToken.kind === k.InstanceOfKeyword) {
      const v = this.value(e.left);
      const cls = e.right.getText().split('.').pop()!;
      return v === undefined ? undefined : `${v} is ${neg ? 'not ' : ''}${/^[aeiou]/i.test(cls) ? 'an' : 'a'} ${words(cls, this.w)}`;
    }
    if (neg) {
      const flipped = NEG[op];
      if (flipped === undefined) return undefined;
      op = flipped;
    }
    const isEq = op === k.EqualsEqualsEqualsToken || op === k.EqualsEqualsToken;
    const isNe = op === k.ExclamationEqualsEqualsToken || op === k.ExclamationEqualsToken;

    // x === null / undefined
    const nothing = (n: ts.Expression) => n.kind === k.NullKeyword || (ts.isIdentifier(n) && n.text === 'undefined');
    if ((isEq || isNe) && (nothing(e.right) || nothing(e.left))) {
      const side = nothing(e.right) ? e.left : e.right;
      const v = this.value(side);
      return v === undefined ? undefined : `${v} is ${isEq ? 'missing' : 'set'}`;
    }
    // x.length === 0
    if ((isEq || isNe) && ts.isNumericLiteral(e.right) && e.right.text === '0' && ts.isPropertyAccessExpression(e.left) && e.left.name.text === 'length') {
      const v = this.value(e.left.expression);
      return v === undefined ? undefined : `${v} is ${isEq ? 'empty' : 'not empty'}`;
    }
    // Comparisons with the current time.
    const nowLeft = isNow(e.left), nowRight = isNow(e.right);
    if (nowLeft || nowRight) {
      const other = this.value(nowRight ? e.left : e.right);
      if (other === undefined) return undefined;
      // Put "now" on the right: now < x  ==  x > now.
      const FLIP: Partial<Record<ts.SyntaxKind, ts.SyntaxKind>> = { [k.LessThanToken]: k.GreaterThanToken, [k.GreaterThanToken]: k.LessThanToken, [k.LessThanEqualsToken]: k.GreaterThanEqualsToken, [k.GreaterThanEqualsToken]: k.LessThanEqualsToken };
      const o = nowLeft ? FLIP[op] ?? op : op;
      const when: Partial<Record<ts.SyntaxKind, string>> = {
        [k.LessThanToken]: 'is in the past', [k.LessThanEqualsToken]: 'is now or in the past',
        [k.GreaterThanToken]: 'is in the future', [k.GreaterThanEqualsToken]: 'is now or in the future',
      };
      return when[o] ? `${other} ${when[o]}` : undefined;
    }
    // typeof result !== 'string' → "result is not text"
    const TYPE_WORDS: Record<string, string> = { string: 'text', number: 'a number', boolean: 'true or false', object: 'an object', function: 'a function', undefined: 'missing' };
    if ((isEq || isNe) && ts.isTypeOfExpression(strip(e.left)) && ts.isStringLiteral(strip(e.right)) && TYPE_WORDS[(strip(e.right) as ts.StringLiteral).text]) {
      const v = this.value((strip(e.left) as ts.TypeOfExpression).expression);
      return v === undefined ? undefined : `${v} is ${isNe ? 'not ' : ''}${TYPE_WORDS[(strip(e.right) as ts.StringLiteral).text]}`;
    }
    const a = this.value(e.left);
    let b = this.value(e.right);
    if (a === undefined || b === undefined) return undefined;
    // file.size > 10 * 1024 * 1024 → "file size is more than 10 MB"
    const leftName = ts.isPropertyAccessExpression(strip(e.left)) ? (strip(e.left) as ts.PropertyAccessExpression).name.text : e.left.getText();
    if (/(size|bytes)$/i.test(leftName) && /^\d+$/.test(b)) b = bytes(Number(b));
    // Two things from the request or the data (not a fixed value): "the same as".
    const fixed = (n: ts.Expression) => ts.isLiteralExpression(n) || n.kind === k.TrueKeyword || n.kind === k.FalseKeyword ||
      (ts.isPropertyAccessExpression(n) && /^[A-Z][A-Z0-9_]*$/.test(n.name.text));
    if ((isEq || isNe) && !fixed(strip(e.left)) && !fixed(strip(e.right))) return `${a} is ${isEq ? 'the same as' : 'different from'} ${b}`;
    // Dates compare as before / after.
    const isDate = (n: ts.Expression): boolean => {
      n = strip(n);
      // `d.getTime()` compares the date d.
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'getTime') return isDate(n.expression.expression);
      return this.p.checker.getTypeAtLocation(n).getNonNullableType().getSymbol()?.name === 'Date';
    };
    if (isDate(e.left) && isDate(e.right)) {
      const WHEN: Partial<Record<ts.SyntaxKind, string>> = {
        [k.LessThanToken]: 'is before', [k.LessThanEqualsToken]: 'is not after', [k.GreaterThanToken]: 'is after', [k.GreaterThanEqualsToken]: 'is not before',
      };
      if (WHEN[op]) return `${a} ${WHEN[op]} ${b}`;
    }
    const VERB: Partial<Record<ts.SyntaxKind, string>> = {
      [k.EqualsEqualsEqualsToken]: 'is', [k.EqualsEqualsToken]: 'is', [k.ExclamationEqualsEqualsToken]: 'is not', [k.ExclamationEqualsToken]: 'is not',
      [k.LessThanToken]: 'is less than', [k.LessThanEqualsToken]: 'is at most', [k.GreaterThanToken]: 'is more than', [k.GreaterThanEqualsToken]: 'is at least',
    };
    return VERB[op] ? `${a} ${VERB[op]} ${b}` : undefined;
  }

  /** `LIST.includes(x)` → "x is (not) one of A, B"; other calls are not translated. */
  private call(e: ts.CallExpression, neg: boolean): string | undefined {
    // this.channels.has('email') on a Set or Map → "channels includes "email""
    if (ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === 'has' && e.arguments.length === 1) {
      const kind = this.p.checker.getTypeAtLocation(e.expression.expression).getNonNullableType().getSymbol()?.name;
      if (kind === 'Set' || kind === 'Map' || kind === 'ReadonlySet' || kind === 'ReadonlyMap') {
        const coll = this.value(e.expression.expression), item = this.value(e.arguments[0]);
        if (coll !== undefined && item !== undefined) return `${coll} ${neg ? 'does not include' : 'includes'} ${item}`;
      }
    }
    // file.type.startsWith('image/') → "file type starts with "image/""
    if (ts.isPropertyAccessExpression(e.expression) && /^(startsWith|endsWith)$/.test(e.expression.name.text) && e.arguments.length === 1) {
      const text = this.value(e.expression.expression), part = this.value(e.arguments[0]);
      if (text === undefined || part === undefined) return undefined;
      const verb = e.expression.name.text === 'startsWith' ? 'start' : 'end';
      return `${text} ${neg ? `does not ${verb}` : `${verb}s`} with ${part}`;
    }
    if (ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === 'includes' && e.arguments.length === 1) {
      const item = this.value(e.arguments[0]);
      // `message.includes('foreign key')`: a text that contains another.
      const receiver = e.expression.expression;
      const rt = this.p.checker.getTypeAtLocation(receiver).getNonNullableType().flags;
      const lastName = ts.isPropertyAccessExpression(receiver) ? receiver.name.text : ts.isIdentifier(receiver) ? receiver.text : '';
      // An untyped value (`catch (error: any)`): only its name can tell it is a text.
      const textName = /(message|text|name|title|description|email|url|path|label|code)$/i.test(lastName);
      if (rt & ts.TypeFlags.StringLike || (rt & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) && textName)) {
        const text = this.value(receiver);
        return text === undefined || item === undefined ? undefined : `${text} ${neg ? 'does not contain' : 'contains'} ${item}`;
      }
      const options = this.listValues(receiver);
      if (item === undefined || options === undefined) return undefined;
      return `${item} is ${neg ? 'not ' : ''}one of ${options}`;
    }
    return undefined;
  }

  /** A value used as a condition. What "true" means depends on its type. */
  private truthy(e: ts.Expression, neg: boolean): string | undefined {
    const name = ts.isPropertyAccessExpression(e) ? e.name.text : ts.isIdentifier(e) ? e.text : undefined;
    if (!name) return undefined;
    if (BUSY.test(name)) return neg ? 'no request is in progress' : 'a request is in progress';
    // user.isActive → "user is active"; departurePort.hasSeats → "departure port has seats"
    const m = name.match(/^(is|has|can|should|was|were)([A-Z].*)$/);
    if (m) {
      const owner = ts.isPropertyAccessExpression(e) ? this.value(e.expression) : undefined;
      const rest = words(m[2], this.w);
      const verb = m[1] === 'has' ? (neg ? 'does not have' : 'has') : m[1] === 'can' ? (neg ? 'cannot' : 'can') : `${m[1] === 'was' || m[1] === 'were' ? m[1] : 'is'}${neg ? ' not' : ''}`;
      // `isReverseRoute` on its own (no owner to say it about): "reverse route is false".
      return owner ? `${owner} ${verb} ${rest}` : `${rest} is ${neg ? 'false' : 'true'}`;
    }
    // user.deletedAt → "user is deleted"
    const at = name.match(/^([a-z]+ed)At$/);
    if (at && ts.isPropertyAccessExpression(e)) {
      const owner = this.value(e.expression);
      return owner === undefined ? undefined : `${owner} is ${neg ? 'not ' : ''}${at[1]}`;
    }
    // `const existing = await prisma.route.findUnique(…)`: what was looked up is a route.
    const model = ts.isIdentifier(e) ? this.lookedUp(e) : undefined;
    if (model && model !== words(e.getText(), this.w)) return neg ? `no matching ${model} is found` : `a matching ${model} is found`;
    const v = this.value(e);
    if (v === undefined) return undefined;
    const t = this.p.checker.getTypeAtLocation(e);
    const flags = t.isUnion() ? t.types.reduce((f, x) => f | x.flags, 0) : t.flags;
    if (flags & ts.TypeFlags.BooleanLike) return `${v} is ${neg ? 'false' : 'true'}`;
    // A date that may be empty (`lockedUntil: Date | null`): set or not, rather than found.
    if (t.getNonNullableType().getSymbol()?.name === 'Date') return `${v} is ${neg ? 'not set' : 'set'}`;
    // Prisma's results are intersections of object types.
    if (flags & (ts.TypeFlags.Object | ts.TypeFlags.NonPrimitive | ts.TypeFlags.Intersection)) return `${v} is ${neg ? 'not found' : 'found'}`;
    if (flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike)) return `${v} is ${neg ? 'empty' : 'set'}`;
    return `${v} is ${neg ? 'missing' : 'set'}`;
  }

  /** A value in words: a name, a literal, an enum member, a count. */
  value(e: ts.Expression): string | undefined {
    e = strip(e);
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return `"${e.text}"`;
    if (ts.isNumericLiteral(e)) return e.text;
    if (e.kind === ts.SyntaxKind.TrueKeyword) return 'true';
    if (e.kind === ts.SyntaxKind.FalseKeyword) return 'false';
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(e.operand)) return `-${e.operand.text}`;
    // 10 * 1024 * 1024: a fixed number written as a sum.
    const n = arithmetic(e);
    if (n !== undefined) return String(n);
    if (ts.isIdentifier(e)) return words(e.text, this.w);
    if (ts.isPropertyAccessExpression(e)) {
      // BookingStatus.CANCELLED, StatusCodes.OK, USER_ROLES.ADMIN: an enum-like constant reads as its name.
      if (/^[A-Z][A-Z0-9_]*$/.test(e.name.text) && ts.isIdentifier(e.expression) && /^[A-Z]/.test(e.expression.text)) return e.name.text;
      if (e.name.text === 'length') {
        const of = this.value(e.expression);
        return of === undefined ? undefined : `the number of ${of}`;
      }
      const parts: string[] = [];
      let cur: ts.Expression = e;
      while (ts.isPropertyAccessExpression(cur)) {
        parts.unshift(cur.name.text);
        cur = strip(cur.expression);
      }
      if (ts.isIdentifier(cur)) parts.unshift(cur.text);
      else if (cur.kind !== ts.SyntaxKind.ThisKeyword) return undefined;
      const kept = parts.filter((x, i) => !(CONTAINERS.has(x) && i < parts.length - 1));
      return kept.map((x) => words(x, this.w)).join(' ');
    }
    // date.getTime(), text.trim(), text.toLowerCase(): the value itself, for the purpose of a condition.
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && !e.arguments.length &&
      ['getTime', 'trim', 'trimStart', 'trimEnd', 'toLowerCase', 'toUpperCase', 'toString', 'valueOf'].includes(e.expression.name.text)) {
      return this.value(e.expression.expression);
    }
    return undefined;
  }

  /** For a variable holding a database lookup (`await prisma.route.findUnique(…)`), the model in words. */
  private lookedUp(id: ts.Identifier): string | undefined {
    const sym = this.p.checker.getSymbolAtLocation(id);
    const d = sym?.valueDeclaration;
    if (!d || !ts.isVariableDeclaration(d) || !d.initializer) return undefined;
    let init: ts.Expression = d.initializer;
    while (ts.isAwaitExpression(init) || ts.isParenthesizedExpression(init) || ts.isAsExpression(init) || ts.isNonNullExpression(init)) init = init.expression;
    if (!ts.isCallExpression(init) || !ts.isPropertyAccessExpression(init.expression)) return undefined;
    // findUnique / findFirst on a database client; plain `find` is an array's (`chat.participants.find(…)`).
    if (!/^find(Unique|First)(OrThrow)?$/.test(init.expression.name.text)) return undefined;
    const owner = init.expression.expression;
    return ts.isPropertyAccessExpression(owner) ? words(owner.name.text, this.w) : undefined;
  }

  /** `CANCELLABLE_STATUSES` declared as [A, B] → "A or B"; otherwise its name in words. */
  private listValues(e: ts.Expression): string | undefined {
    if (ts.isArrayLiteralExpression(e)) {
      const vs = e.elements.map((x) => this.value(x));
      return vs.some((v) => v === undefined) ? undefined : orList(vs as string[]);
    }
    if (ts.isIdentifier(e)) {
      const sym = this.p.checker.getSymbolAtLocation(e);
      const decl = sym && (sym.flags & ts.SymbolFlags.Alias ? this.p.checker.getAliasedSymbol(sym) : sym).valueDeclaration;
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
        let init: ts.Expression = decl.initializer;
        while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init)) init = init.expression;
        if (ts.isArrayLiteralExpression(init)) return this.listValues(init);
      }
    }
    return this.value(e);
  }
}

const isLogical = (k: ts.SyntaxKind) => k === ts.SyntaxKind.AmpersandAmpersandToken || k === ts.SyntaxKind.BarBarToken;

/** The value of `10 * 1024 * 1024`, `60 * 60_000`: numbers and + - * / only. */
function arithmetic(e: ts.Expression): number | undefined {
  e = strip(e);
  if (ts.isNumericLiteral(e)) return Number(e.text.replace(/_/g, ''));
  if (!ts.isBinaryExpression(e)) return undefined;
  const a = arithmetic(e.left), b = arithmetic(e.right);
  if (a === undefined || b === undefined) return undefined;
  switch (e.operatorToken.kind) {
    case ts.SyntaxKind.AsteriskToken: return a * b;
    case ts.SyntaxKind.PlusToken: return a + b;
    case ts.SyntaxKind.MinusToken: return a - b;
    case ts.SyntaxKind.SlashToken: return b ? a / b : undefined;
    default: return undefined;
  }
}

/** 10485760 → "10 MB" (only when it is a whole number of KB or MB). */
const bytes = (n: number) => (n >= 1024 * 1024 && n % (1024 * 1024) === 0 ? `${n / 1024 / 1024} MB` : n >= 1024 && n % 1024 === 0 ? `${n / 1024} KB` : `${n} bytes`);

const orList = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs.at(-1)}`);

function strip(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e)) e = e.expression;
  return e;
}

/** `Date.now()` or `new Date()`. */
function isNow(e: ts.Expression): boolean {
  e = strip(e);
  if (ts.isCallExpression(e) && e.expression.getText() === 'Date.now' && !e.arguments.length) return true;
  return ts.isNewExpression(e) && e.expression.getText() === 'Date' && !(e.arguments?.length);
}
