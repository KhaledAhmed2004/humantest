// Where a piece of code sits in the request: the conditions that lead to it, in its own function and
// at each call on the way from the route, whether a failure there is caught, and the transaction it
// is in. Shared by the refusals (throws.mts) and the changes (effects.mts).

import ts from 'typescript';
import type { SliceItem } from '../backend/slice.mts';
import { declarationOf, type TsProject } from '../ts-project.mts';
import { translate, translateEquals, type Words } from './condition.mts';
import type { Condition } from './types.mts';

/** Where a transaction is: its `$transaction(…)` call and the function it is in. */
export interface Tx { call: ts.CallExpression; in: string }

/** `prisma.$transaction(async (tx) => …)` or `prisma.$transaction([…])`. */
const isTxCall = (n: ts.Node): n is ts.CallExpression => ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === '$transaction';

/**
 * The conditions on the way from the route to a called function: at each call site up the chain
 * (`if (intent.status === 'succeeded') await PaymentService.applyIntentResult(…)`). A function
 * called from more than one place in its caller gets none from there: they may differ.
 */
export function pathTo(p: TsProject, items: SliceItem[], index: number, w: Words): { when: Condition[]; bestEffort: boolean; tx?: Tx } | undefined {
  const when: Condition[] = [];
  let bestEffort = false;
  let tx: Tx | undefined;
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
    // Further up is further out.
    if (ctx.tx) tx = ctx.tx;
  }
  return when.length || bestEffort || tx ? { when, bestEffort, ...(tx ? { tx } : {}) } : undefined;
}

/** The conditions that lead to a node inside its function, and how a failure there is handled. */
export function context(p: TsProject, node: ts.Node, it: SliceItem, w: Words) {
  const when: Condition[] = [];
  let onError = false;
  let bestEffort = false;
  let tx: Tx | undefined;
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
    // The callback or the list given to `$transaction`. Further up is further out.
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isArrayLiteralExpression(n)) && isTxCall(n.parent) &&
      n.parent.arguments.includes(n as ts.Expression)) {
      tx = { call: n.parent, in: it.name };
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
  return { when, onError, bestEffort, tx };
}

/** `return x;` / `{ log(); return; }` / `continue;`: the rest of the block is skipped. */
function leavesEarly(st: ts.Statement): boolean {
  const last = ts.isBlock(st) ? st.statements.at(-1) : st;
  return !!last && (ts.isReturnStatement(last) || ts.isContinueStatement(last));
}

/** The catch passes the error on: throws again, or hands it to Express (`next(error)`). */
export function rethrows(c: ts.CatchClause): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found || ts.isFunctionLike(n)) return;
    if (ts.isThrowStatement(n) || (ts.isCallExpression(n) && n.expression.getText() === 'next' && n.arguments.length)) { found = true; return; }
    ts.forEachChild(n, visit);
  };
  visit(c.block);
  return found;
}
