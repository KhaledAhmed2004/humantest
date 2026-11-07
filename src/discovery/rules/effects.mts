// What a request changes and sends, and what it answers when nothing stops it:
//   prisma.route.create({ data })                    → "A new route is saved."
//   Campaign.create(payload), campaign.save()        → the same, for Mongoose models
//   tx.schedule.updateMany({ data: { availableSeats: { decrement: seats } } })
//                                                    → "Matching schedules are changed: available seats goes down by seats."
//   EmailService.sendEmail({ subject: 'Verify …' })  → 'An email "Verify …" is sent.'
//   sendResponse(res, { statusCode: 201, message })  → 'The server answers 201 Created: "…".'
// Each with the if/else conditions around it, like the refusals in throws.mts.

import ts from 'typescript';
import type { SliceItem } from '../backend/slice.mts';
import { declarationOf, where, type TsProject } from '../ts-project.mts';
import { translate, words, type Words } from './condition.mts';
import { context, pathTo, sessionTx, type Tx } from './paths.mts';
import { messageTexts } from './messages.mts';
import { statusOf } from './throws.mts';
import type { Condition, EffectRule, Rule, RulePath, TogetherRule, WrittenField } from './types.mts';

const SCANNED = new Set(['route', 'controller', 'service', 'helper', 'shared']);

const WRITES: Record<string, { effect: 'create' | 'update' | 'delete'; many?: boolean }> = {
  create: { effect: 'create' }, createMany: { effect: 'create', many: true }, createManyAndReturn: { effect: 'create', many: true },
  update: { effect: 'update' }, updateMany: { effect: 'update', many: true }, updateManyAndReturn: { effect: 'update', many: true },
  upsert: { effect: 'update' }, delete: { effect: 'delete' }, deleteMany: { effect: 'delete', many: true },
};

/** Mongoose model calls that write, and which argument says what is written. */
const MONGOOSE: Record<string, { effect: 'create' | 'update' | 'delete'; many?: boolean; data?: number }> = {
  create: { effect: 'create', data: 0 }, insertMany: { effect: 'create', many: true, data: 0 },
  findByIdAndUpdate: { effect: 'update', data: 1 }, findOneAndUpdate: { effect: 'update', data: 1 },
  updateOne: { effect: 'update', data: 1 }, updateMany: { effect: 'update', many: true, data: 1 },
  replaceOne: { effect: 'update', data: 1 }, findOneAndReplace: { effect: 'update', data: 1 },
  findByIdAndDelete: { effect: 'delete' }, findByIdAndRemove: { effect: 'delete' },
  findOneAndDelete: { effect: 'delete' }, findOneAndRemove: { effect: 'delete' },
  deleteOne: { effect: 'delete' }, deleteMany: { effect: 'delete', many: true },
};
/** Mongoose reads that give one record, which `doc.save()` can write back. */
const MONGOOSE_READS = /^(findById|findOne|findByIdAndUpdate|findOneAndUpdate)$/;

/**
 * The model's name when `e` is a Mongoose model: declared as `model<…>('Campaign', schema)` (or
 * `mongoose.model(…)`), or typed as Mongoose's `Model`.
 */
function mongooseModel(p: TsProject, e: ts.Expression, w: Words): string | undefined {
  e = strip(e);
  if (!ts.isIdentifier(e)) return undefined;
  const lower = (s: string) => words(s.replace(/Model$/, '').replace(/^./, (c) => c.toLowerCase()), w);
  const d = declarationOf(p, e);
  if (d && ts.isVariableDeclaration(d) && d.initializer) {
    const init = strip(d.initializer);
    if (ts.isCallExpression(init) && /(^|\.)model$/.test(init.expression.getText())) {
      const named = init.arguments[0];
      return lower(named && ts.isStringLiteral(named) ? named.text : d.name.getText());
    }
  }
  const type = p.checker.getTypeAtLocation(e).getSymbol()?.name;
  return type === 'Model' ? lower(e.text) : undefined;
}

/**
 * The model `doc` was read from or made with, for `doc.save()`: `const doc = await X.findById(…)`
 * (also with `.select(…)`, `.populate(…)` after it) or `const doc = new X({ … })`.
 */
function documentOf(p: TsProject, doc: ts.Expression, w: Words): { model: string; made?: ts.Expression } | undefined {
  doc = strip(doc);
  if (!ts.isIdentifier(doc)) return undefined;
  const d = declarationOf(p, doc);
  if (!d || !ts.isVariableDeclaration(d) || !d.initializer) return undefined;
  let init = strip(d.initializer);
  if (ts.isNewExpression(init)) {
    const model = mongooseModel(p, init.expression, w);
    return model ? { model, made: init.arguments?.[0] ?? ts.factory.createObjectLiteralExpression() } : undefined;
  }
  // Down the chain: X.findById(id).select('+password').populate('owner')
  while (ts.isCallExpression(init) && ts.isPropertyAccessExpression(init.expression)) {
    const target = init.expression;
    if (MONGOOSE_READS.test(target.name.text)) {
      const model = mongooseModel(p, target.expression, w);
      if (model) return { model };
    }
    init = strip(target.expression);
  }
  return undefined;
}

/** `doc.status = 'ACTIVE'` and `Object.assign(doc, { … })` in the function, before `doc.save()`. */
function assignedBefore(p: TsProject, it: SliceItem, doc: ts.Identifier, save: ts.Node, w: Words): WrittenField[] {
  const out: WrittenField[] = [];
  const visit = (n: ts.Node) => {
    if (n.pos >= save.pos) return;
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(n.left) &&
      ts.isIdentifier(n.left.expression) && n.left.expression.text === doc.text) {
      const value = fixedValue(n.right);
      out.push({ name: words(n.left.name.text, w), how: 'set', ...(value !== undefined ? { value } : {}) });
    } else if (ts.isCallExpression(n) && n.expression.getText() === 'Object.assign' && n.arguments[0]?.getText() === doc.text) {
      for (const a of n.arguments.slice(1)) out.push(...(writtenFields(a, w, false, p) ?? []));
    }
    ts.forEachChild(n, visit);
  };
  visit(it.decl);
  const seen = new Set<string>();
  return out.filter((f) => !seen.has(f.name) && seen.add(f.name));
}

/** What a Mongoose update writes: `{ $set: { … }, $inc: { views: 1 }, $push: { tags: tag } }`, or plain fields. */
function mongoUpdateFields(update: ts.Expression | undefined, w: Words, p: TsProject): WrittenField[] | undefined {
  if (!update) return undefined;
  update = strip(update);
  if (ts.isIdentifier(update)) {
    const d = declarationOf(p, update);
    if (d && ts.isVariableDeclaration(d) && d.initializer) update = strip(d.initializer);
  }
  if (!ts.isObjectLiteralExpression(update)) return undefined;
  const out: WrittenField[] = [];
  const plain: ts.ObjectLiteralElementLike[] = [];
  for (const pr of update.properties) {
    const key = ts.isPropertyAssignment(pr) ? pr.name.getText().replace(/['"]/g, '') : '';
    if (!key.startsWith('$') || !ts.isPropertyAssignment(pr)) { plain.push(pr); continue; }
    const inner = strip(pr.initializer);
    if (key === '$set' || key === '$setOnInsert') { out.push(...(writtenFields(inner, w, false, p) ?? [])); continue; }
    if (!ts.isObjectLiteralExpression(inner)) continue;
    for (const f of inner.properties) {
      if (!ts.isPropertyAssignment(f) && !ts.isShorthandPropertyAssignment(f)) continue;
      const name = words(f.name.getText().replace(/['"]/g, ''), w);
      const v = ts.isPropertyAssignment(f) ? strip(f.initializer) : f.name;
      const say = (e: ts.Expression) => fixedValue(e) ?? (prop(e, '$each') ? undefined : words(e.getText().replace(/^.*\./, ''), w));
      if (key === '$inc') {
        // { $inc: { stock: -quantity } }: goes down.
        const down = ts.isPrefixUnaryExpression(v) && v.operator === ts.SyntaxKind.MinusToken;
        out.push({ name, how: down ? 'decrement' : 'increment', value: say(down ? (v as ts.PrefixUnaryExpression).operand : v) });
      } else if (key === '$push' || key === '$addToSet') out.push({ name, how: 'add', value: say(v) });
      else if (key === '$pull') out.push({ name, how: 'remove', value: say(v) });
      else if (key === '$unset') out.push({ name, how: 'set', value: 'empty' });
    }
  }
  if (plain.length) out.push(...(writtenFields(ts.factory.createObjectLiteralExpression(plain as ts.ObjectLiteralElementLike[]), w, false, p) ?? []));
  return out;
}

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
  // The database changes in each transaction, in the order found.
  const txs = new Map<ts.CallExpression, { tx: Tx; changes: TogetherRule['changes'] }>();
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
        // Inside a transaction here, or called from inside one: the outermost one is what counts.
        const tx = path?.tx ?? (r ? context(p, n, it, w).tx ?? sessionTx(n, it) : undefined);
        if (r && r.kind === 'effect' && tx && !r.onError && (r.effect === 'create' || r.effect === 'update' || r.effect === 'delete')) {
          if (!txs.has(tx.call)) txs.set(tx.call, { tx, changes: [] });
          txs.get(tx.call)!.changes.push({ effect: r.effect, model: r.model ?? 'record', ...(r.many ? { many: true } : {}) });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(it.decl);
  });
  // One change alone needs no transaction to be all or nothing.
  const count = new Map<string, number>();
  for (const { tx, changes } of txs.values()) {
    if (changes.length < 2) continue;
    const k = count.get(tx.in) ?? 0;
    count.set(tx.in, k + 1);
    out.push({ kind: 'together', changes, in: tx.in, id: `together:${tx.in}#${k}`, source: where(p, tx.call) });
  }
  return out;
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
        } else if (ts.isConditionalExpression(v)) {
          // `startsPending ? BookingStatus.PENDING : BookingStatus.CONFIRMED`: both, with when.
          const a = fixedValue(v.whenTrue), b = fixedValue(v.whenFalse);
          const when = p ? translate(p, v.condition, false, w).text : undefined;
          if (a !== undefined && b !== undefined) field.value = a === b ? a : when ? `${a} if ${when}, otherwise ${b}` : `${a} or ${b}`;
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
  // Mongoose: Campaign.create(…), User.findByIdAndUpdate(id, { $set: … }), Post.deleteMany(…)
  if (ts.isPropertyAccessExpression(callee) && Object.hasOwn(MONGOOSE, callee.name.text)) {
    const model = mongooseModel(p, callee.expression, w);
    if (model) {
      const op = MONGOOSE[callee.name.text];
      const arg = op.data === undefined ? undefined : call.arguments[op.data];
      const list = !!arg && ts.isArrayLiteralExpression(strip(arg)) ? (strip(arg) as ts.ArrayLiteralExpression).elements.length : undefined;
      const many = op.many || (op.effect === 'create' && list !== undefined && list !== 1);
      // `X.create([{ … }])`: one record written as a list says what each one gets.
      const one = arg && ts.isArrayLiteralExpression(strip(arg)) && (strip(arg) as ts.ArrayLiteralExpression).elements.length === 1
        ? (strip(arg) as ts.ArrayLiteralExpression).elements[0] : arg;
      const fields = op.effect === 'create' ? writtenFields(one, w, false, p) : op.effect === 'update' ? mongoUpdateFields(arg, w, p) : undefined;
      return base({ effect: op.effect, model, ...(many ? { many: true } : {}), ...(fields?.length ? { fields } : {}) });
    }
  }
  // doc.save() on a record read before (an update) or made with `new X(…)` (a new one); doc.deleteOne().
  if (ts.isPropertyAccessExpression(callee) && /^(save|deleteOne|remove)$/.test(callee.name.text) && ts.isIdentifier(strip(callee.expression))) {
    const doc = documentOf(p, callee.expression, w);
    if (doc) {
      if (callee.name.text !== 'save') return base({ effect: 'delete', model: doc.model });
      const fields = doc.made ? writtenFields(doc.made, w, false, p) : assignedBefore(p, it, strip(callee.expression) as ts.Identifier, call, w);
      return base({ effect: doc.made ? 'create' : 'update', model: doc.model, ...(fields?.length ? { fields } : {}) });
    }
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
