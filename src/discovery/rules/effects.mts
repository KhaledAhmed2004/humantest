// What a request changes and sends, and what it answers when nothing stops it:
//   prisma.route.create({ data })                    → "A new route is saved."
//   tx.schedule.updateMany({ data: { availableSeats: { decrement: seats } } })
//                                                    → "Matching schedules are changed: available seats goes down by seats."
//   EmailService.sendEmail({ subject: 'Verify …' })  → 'An email "Verify …" is sent.'
//   sendResponse(res, { statusCode: 201, message })  → 'The server answers 201 Created: "…".'
// Each with the if/else conditions around it, like the refusals in throws.mts.

import ts from 'typescript';
import type { SliceItem } from '../backend/slice.mts';
import { declarationOf, where, type TsProject } from '../ts-project.mts';
import { translate, translateEquals, words, type Words } from './condition.mts';
import { messageTexts } from './messages.mts';
import { statusOf } from './throws.mts';
import type { Condition, EffectRule, Rule, RulePath, WrittenField } from './types.mts';

const SCANNED = new Set(['route', 'controller', 'service', 'helper', 'shared']);

const WRITES: Record<string, { effect: 'create' | 'update' | 'delete'; many?: boolean }> = {
  create: { effect: 'create' }, createMany: { effect: 'create', many: true }, createManyAndReturn: { effect: 'create', many: true },
  update: { effect: 'update' }, updateMany: { effect: 'update', many: true }, updateManyAndReturn: { effect: 'update', many: true },
  upsert: { effect: 'update' }, delete: { effect: 'delete' }, deleteMany: { effect: 'delete', many: true },
};

/** A Prisma client or transaction: `prisma`, `tx`, `this.prisma`, or anything typed as one. */
function isDbClient(p: TsProject, e: ts.Expression): boolean {
  const text = e.getText();
  if (/^(this\.)?(prisma|db|tx|trx|transactionClient|client)$/i.test(text)) return true;
  const name = p.checker.getTypeAtLocation(e).getSymbol()?.name ?? '';
  return /Prisma|TransactionClient/.test(name);
}

/** Calls that send an email. */
const EMAIL = /(^|\.)(send(Email|Mail)|sendTemplateEmail|mail(er)?\.send)$/i;
/** Calls that push a live message or notification. */
const NOTIFY = /(^|\.)(sendNotifications?|notify\w*|emit)$/;
/** Payment provider calls that change something (not reads). */
const PAYMENT = /^stripe\.(\w+)\.(create|cancel|capture|confirm|update|del)$/;
/** Calls that send the answer. */
const RESPOND = /(^|\.)(sendResponse|sendSuccess|respond)$/;

export function effectRules(p: TsProject, items: SliceItem[], w: Words = {}): Rule[] {
  const out: Rule[] = [];
  const done = new Set<ts.Node>();
  items.forEach((it, index) => {
    if (it.repeat || !SCANNED.has(it.role) || done.has(it.decl)) return;
    done.add(it.decl);
    const path = pathTo(p, items, index, w);
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const r = (effectOf(p, n, it, w) ?? replyOf(p, n, it, w)) as (Rule & { when: Condition[]; bestEffort?: boolean; path?: RulePath }) | undefined;
        if (r && path) {
          // The conditions on the way to this function: "If intent status is "succeeded", …".
          // One that is also the rule's own is said once.
          const own = new Set(r.when.map((c) => c.code));
          const seen = new Set<string>();
          const way = path.when.filter((c) => !own.has(c.code) && !seen.has(c.code) && seen.add(c.code));
          if (way.length) {
            r.path = { through: it.name, when: way };
            r.id = `${r.id}|via:${way.map((c) => c.code).join(' && ')}`;
          }
          if (path.bestEffort && r.kind === 'effect') r.bestEffort = true;
        }
        if (r) out.push(r);
      }
      ts.forEachChild(n, visit);
    };
    visit(it.decl);
  });
  return out;
}

/**
 * The conditions on the way from the route to a called function: at each call site up the chain
 * (`if (intent.status === 'succeeded') await PaymentService.applyIntentResult(…)`). A function
 * called from more than one place in its caller gets none from there: they may differ.
 */
function pathTo(p: TsProject, items: SliceItem[], index: number, w: Words): { when: Condition[]; bestEffort: boolean } | undefined {
  const when: Condition[] = [];
  let bestEffort = false;
  for (let i = index, guard = 0; items[i] && items[i].parent >= 0 && guard < 10; i = items[i].parent, guard++) {
    const child = items[i], parent = items[child.parent];
    const sites: ts.CallExpression[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && declarationOf(p, n.expression) === child.decl) sites.push(n);
      ts.forEachChild(n, visit);
    };
    visit(parent.decl);
    if (sites.length !== 1) continue;
    const ctx = context(p, sites[0], parent, w);
    when.unshift(...ctx.when);
    if (ctx.bestEffort || ctx.onError) bestEffort = bestEffort || ctx.bestEffort;
  }
  return when.length || bestEffort ? { when, bestEffort } : undefined;
}

/** The conditions that lead to a node inside its function, and how a failure there is handled. */
function context(p: TsProject, node: ts.Node, it: SliceItem, w: Words) {
  const when: Condition[] = [];
  let onError = false;
  let bestEffort = false;
  let child: ts.Node = node;
  for (let n = node.parent; n && n !== it.decl.parent; child = n, n = n.parent) {
    // `if (existing) return existing;` before it: it only runs when that is not so.
    // (Early throws are left out: they are the refusals, listed on their own.)
    if (ts.isBlock(n) || ts.isSourceFile(n)) {
      const before = n.statements.slice(0, n.statements.indexOf(child as ts.Statement));
      for (const st of [...before].reverse()) {
        if (ts.isIfStatement(st) && !st.elseStatement && leavesEarly(st.thenStatement)) when.unshift(translate(p, st.expression, true, w));
      }
    }
    if (ts.isIfStatement(n)) {
      if (child === n.thenStatement) when.unshift(translate(p, n.expression, false, w));
      else if (child === n.elseStatement) when.unshift(translate(p, n.expression, true, w));
    } else if (ts.isConditionalExpression(n)) {
      if (child === n.whenTrue) when.unshift(translate(p, n.condition, false, w));
      else if (child === n.whenFalse) when.unshift(translate(p, n.condition, true, w));
    } else if (ts.isCatchClause(n)) {
      onError = true;
    } else if (ts.isTryStatement(n) && child === n.tryBlock && n.catchClause && !rethrows(n.catchClause)) {
      bestEffort = true;
    } else if (ts.isCaseClause(n) && ts.isSwitchStatement(n.parent.parent)) {
      when.unshift(translateEquals(p, n.parent.parent.expression, n.expression, w));
    }
  }
  return { when, onError, bestEffort };
}

/** `return x;` / `{ log(); return; }` / `continue;`: the rest of the block is skipped. */
function leavesEarly(st: ts.Statement): boolean {
  const last = ts.isBlock(st) ? st.statements.at(-1) : st;
  return !!last && (ts.isReturnStatement(last) || ts.isContinueStatement(last));
}

function rethrows(c: ts.CatchClause): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found || ts.isFunctionLike(n)) return;
    if (ts.isThrowStatement(n)) { found = true; return; }
    ts.forEachChild(n, visit);
  };
  visit(c.block);
  return found;
}

const strip = (e: ts.Expression): ts.Expression => {
  while (ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  return e;
};

/** A property of an object literal argument. */
function prop(o: ts.Expression | undefined, name: string): ts.Expression | undefined {
  if (!o) return undefined;
  o = strip(o);
  if (!ts.isObjectLiteralExpression(o)) return undefined;
  for (const pr of o.properties) {
    if (ts.isPropertyAssignment(pr) && pr.name.getText().replace(/['"]/g, '') === name) return pr.initializer;
    if (ts.isShorthandPropertyAssignment(pr) && pr.name.text === name) return pr.name;
  }
  return undefined;
}

/** A fixed value in words (an enum member, a literal), or undefined when it comes from the code. */
function fixedValue(e: ts.Expression): string | undefined {
  e = strip(e);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return `"${e.text}"`;
  if (ts.isNumericLiteral(e)) return e.text;
  if (e.kind === ts.SyntaxKind.TrueKeyword) return 'true';
  if (e.kind === ts.SyntaxKind.FalseKeyword) return 'false';
  if (e.kind === ts.SyntaxKind.NullKeyword) return 'empty';
  if (ts.isPropertyAccessExpression(e) && /^[A-Z][A-Z0-9_]*$/.test(e.name.text)) return e.name.text;
  if (ts.isNewExpression(e) && e.expression.getText() === 'Date' && !e.arguments?.length) return 'the current time';
  return undefined;
}

/** The fields a write's `data` sets. Relations (`connect`, nested `create`) are named, not followed. */
function writtenFields(data: ts.Expression | undefined, w: Words, optional = false, p?: TsProject): WrittenField[] | undefined {
  if (!data) return undefined;
  data = strip(data);
  // `data: updateData`, with `const updateData = { … }` before it.
  if (ts.isIdentifier(data) && p) {
    const d = declarationOf(p, data);
    if (d && ts.isVariableDeclaration(d) && d.initializer) data = strip(d.initializer);
  }
  if (!ts.isObjectLiteralExpression(data)) return undefined;
  const out: WrittenField[] = [];
  for (const pr of data.properties) {
    if (ts.isSpreadAssignment(pr)) {
      // ...(dto.x !== undefined && { x: dto.x }): written only then.
      let e = strip(pr.expression);
      if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) e = strip(e.right);
      const inner = writtenFields(e, w, true, p);
      if (inner) out.push(...inner);
      continue;
    }
    const name = ts.isPropertyAssignment(pr) || ts.isShorthandPropertyAssignment(pr) ? pr.name.getText().replace(/['"]/g, '') : undefined;
    if (!name) continue;
    const field: WrittenField = { name: words(name, w), how: 'set', ...(optional ? { optional } : {}) };
    if (ts.isPropertyAssignment(pr)) {
      const v = strip(pr.initializer);
      const by = (k: string) => prop(v, k);
      const inc = by('increment'), dec = by('decrement');
      if (inc || dec) {
        field.how = inc ? 'increment' : 'decrement';
        const amount = inc ?? dec!;
        field.value = fixedValue(amount) ?? words(amount.getText().replace(/^.*\./, ''), w);
      } else {
        const fixed = by('set') ? fixedValue(by('set')!) : fixedValue(v);
        if (fixed !== undefined) field.value = fixed;
        // `x ?? false`, `dto.status ?? RouteStatus.ACTIVE`: the fallback is worth saying.
        else if (ts.isBinaryExpression(v) && v.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
          const fb = fixedValue(v.right);
          if (fb !== undefined) { field.value = fb; field.fallback = true; }
        }
      }
    }
    out.push(field);
  }
  return out;
}

function effectOf(p: TsProject, call: ts.CallExpression, it: SliceItem, w: Words): Rule | undefined {
  const callee = call.expression;
  const text = callee.getText().replace(/\s+/g, '');
  // Inside the email sender itself (`EmailService.sendEmail`), its own sending is the same email
  // the caller already sends: counted once, where it says what (the subject).
  const own = it.name.split('.').pop() ?? '';
  const base = (facts: Omit<EffectRule, 'kind' | 'when' | 'in' | 'onError' | 'bestEffort'>) => {
    const ctx = context(p, call, it, w);
    const key = [facts.effect, facts.model ?? facts.what ?? '', ctx.when.map((c) => c.code).join(' && ')].join(':');
    return {
      kind: 'effect' as const, ...facts, when: ctx.when, in: it.name,
      ...(ctx.onError ? { onError: true } : {}), ...(ctx.bestEffort ? { bestEffort: true } : {}),
      id: `effect:${it.name}:${key}${ctx.onError ? ':catch' : ''}`, source: where(p, call),
    };
  };

  // prisma.route.create(…), tx.schedule.updateMany(…)
  if (ts.isPropertyAccessExpression(callee) && WRITES[callee.name.text] && ts.isPropertyAccessExpression(callee.expression) &&
    /^[a-z]\w*$/.test(callee.expression.name.text) && isDbClient(p, callee.expression.expression)) {
    const op = WRITES[callee.name.text];
    const arg = call.arguments[0];
    const fields = op.effect === 'delete' ? undefined
      : callee.name.text === 'upsert' ? writtenFields(prop(arg, 'update'), w, false, p) : writtenFields(prop(arg, 'data'), w, false, p);
    return base({
      effect: op.effect, model: words(callee.expression.name.text, w),
      ...(op.many ? { many: true } : {}), ...(fields?.length ? { fields } : {}),
    });
  }
  if (EMAIL.test(text) && !EMAIL.test(own)) {
    const subject = prop(call.arguments[0], 'subject');
    const what = subject ? messageTexts(subject)?.[0] : undefined;
    return base({ effect: 'email', ...(what ? { what } : {}) });
  }
  const pay = text.match(PAYMENT);
  if (pay) return base({ effect: 'payment', what: `${pay[1]}.${pay[2]}` });
  if (NOTIFY.test(text) && !NOTIFY.test(own) && !/^(this\.)?(emitter|events?|eventEmitter)\./i.test(text)) {
    const event = call.arguments[0] && messageTexts(call.arguments[0])?.[0];
    return base({ effect: 'notify', ...(event ? { what: event } : {}) });
  }
  return undefined;
}

/** `sendResponse(res, { statusCode, message })`, `res.status(201).json({ message })`. */
function replyOf(p: TsProject, call: ts.CallExpression, it: SliceItem, w: Words): Rule | undefined {
  const callee = call.expression;
  let status: number | undefined;
  let message: ts.Expression | undefined;
  if (RESPOND.test(callee.getText()) && call.arguments.length >= 2) {
    const data = call.arguments[1];
    const sc = prop(data, 'statusCode') ?? prop(data, 'status');
    status = sc ? statusOf(p, sc) : undefined;
    message = prop(data, 'message');
    if (status === undefined && !message) return undefined;
  } else if (ts.isPropertyAccessExpression(callee) && /^(json|send)$/.test(callee.name.text)) {
    // res.status(201).json(…) / res.json(…)
    const target = callee.expression;
    if (ts.isCallExpression(target) && ts.isPropertyAccessExpression(target.expression) && target.expression.name.text === 'status' && target.arguments[0]) {
      status = statusOf(p, target.arguments[0]);
    } else if (!/^res(ponse)?$/.test(target.getText())) return undefined;
    else status = 200;
    message = prop(call.arguments[0], 'message');
  } else return undefined;
  if (status !== undefined && status >= 400) return undefined; // an error answer is a refusal, not the reply
  const texts = message ? messageTexts(message) ?? fromResult(p, message) : undefined;
  const [msg, ...others] = texts ?? [];
  // The response helper's own `res.status(data.statusCode).json(…)` says nothing by itself.
  if (status === undefined && msg === undefined) return undefined;
  const ctx = context(p, call, it, w);
  return {
    kind: 'reply', when: ctx.when, in: it.name, ...(status !== undefined ? { status } : {}),
    ...(msg !== undefined ? { message: msg } : {}), ...(others.length ? { otherMessages: others } : {}),
    id: `reply:${it.name}:${status ?? '?'}:${ctx.when.map((c) => c.code).join(' && ')}`, source: where(p, call),
  };
}

/**
 * `message: result.message`, where `const result = await RouteService.deleteRoute(id)`:
 * the messages that function returns (`return { message: 'Route deleted successfully' }`).
 */
function fromResult(p: TsProject, e: ts.Expression): string[] | undefined {
  e = strip(e);
  if (!ts.isPropertyAccessExpression(e) || !ts.isIdentifier(e.expression)) return undefined;
  const key = e.name.text;
  const v = declarationOf(p, e.expression);
  if (!v || !ts.isVariableDeclaration(v) || !v.initializer) return undefined;
  const init = strip(v.initializer);
  if (!ts.isCallExpression(init)) return undefined;
  const fn = declarationOf(p, init.expression);
  const body = fn && (ts.isFunctionDeclaration(fn) ? fn : ts.isVariableDeclaration(fn) ? fn.initializer : fn);
  if (!body) return undefined;
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (n !== body && ts.isFunctionLike(n)) return;
    if (ts.isReturnStatement(n) && n.expression) {
      const m = prop(n.expression, key);
      const t = m ? messageTexts(m) : undefined;
      if (t) out.push(...t);
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(body, visit);
  return out.length ? [...new Set(out)] : undefined;
}
