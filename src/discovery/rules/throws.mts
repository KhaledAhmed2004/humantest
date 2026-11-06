// When the server stops a request: `if (cond) throw new ApiError(StatusCodes.CONFLICT, 'msg')`.
// Every throw in the slice's own functions, with the if/else conditions that lead to it.

import ts from 'typescript';
import type { SliceItem } from '../backend/slice.mts';
import { where, type TsProject } from '../ts-project.mts';
import { translate, translateEquals, type Words } from './condition.mts';
import { messageTexts } from './messages.mts';
import type { Condition, Rule } from './types.mts';

/** Status codes of common exception class names (NestJS style and the like). */
const EXCEPTION_STATUS: Record<string, number> = {
  BadRequest: 400, Unauthorized: 401, Forbidden: 403, NotFound: 404, Conflict: 409, Gone: 410,
  UnprocessableEntity: 422, TooManyRequests: 429, InternalServerError: 500, NotImplemented: 501, BadGateway: 502, ServiceUnavailable: 503,
};

/** http-status-codes names, in case the checker can't read the enum's value. */
const STATUS_NAMES: Record<string, number> = {
  OK: 200, CREATED: 201, NO_CONTENT: 204, BAD_REQUEST: 400, UNAUTHORIZED: 401, PAYMENT_REQUIRED: 402, FORBIDDEN: 403, NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405, CONFLICT: 409, GONE: 410, PRECONDITION_FAILED: 412, UNPROCESSABLE_ENTITY: 422, TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500, NOT_IMPLEMENTED: 501, BAD_GATEWAY: 502, SERVICE_UNAVAILABLE: 503,
};

/** Kinds of slice item whose code is the route's own logic. */
const SCANNED = new Set(['route', 'controller', 'service', 'helper', 'shared']);

export function rejectRules(p: TsProject, items: SliceItem[], w: Words = {}): Rule[] {
  const out: Rule[] = [];
  const done = new Set<ts.Node>();
  for (const it of items) {
    if (it.repeat || !SCANNED.has(it.role) || done.has(it.decl)) continue;
    done.add(it.decl);
    const visit = (n: ts.Node) => {
      if (ts.isThrowStatement(n) && n.expression) {
        const r = rejectFor(p, n, it, w);
        if (r) out.push(r);
      }
      ts.forEachChild(n, visit);
    };
    visit(it.decl);
  }
  return out;
}

function rejectFor(p: TsProject, t: ts.ThrowStatement, it: SliceItem, w: Words): Rule | undefined {
  let e: ts.Expression = t.expression!;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (!ts.isNewExpression(e)) return undefined; // `throw error` re-throws: not a new rule
  const cls = e.expression.getText();
  const args = e.arguments ?? [];
  let status: number | undefined;
  let messages: string[] | undefined;
  const exc = cls.match(/^(\w+?)(Exception|Error)$/);
  if (exc && EXCEPTION_STATUS[exc[1]]) {
    status = EXCEPTION_STATUS[exc[1]];
    messages = messageTexts(args[0]);
  } else if (args.length >= 2 || (args[0] && statusOf(p, args[0]) !== undefined)) {
    // ApiError(status, message)
    status = statusOf(p, args[0]);
    messages = messageTexts(args[1]);
  } else {
    // new Error('…'): an unexpected error, the client sees a 500.
    messages = messageTexts(args[0]);
    status = cls === 'Error' ? 500 : undefined;
  }
  const [message, ...otherMessages] = messages ?? [];

  const when: Condition[] = [];
  let onError = false;
  let child: ts.Node = t;
  for (let n = t.parent; n && n !== it.decl.parent; child = n, n = n.parent) {
    if (ts.isIfStatement(n)) {
      if (child === n.thenStatement) when.unshift(translate(p, n.expression, false, w));
      else if (child === n.elseStatement) when.unshift(translate(p, n.expression, true, w));
    } else if (ts.isCatchClause(n)) {
      onError = true;
    } else if (ts.isCaseClause(n) && ts.isSwitchStatement(n.parent.parent)) {
      when.unshift(translateEquals(p, n.parent.parent.expression, n.expression, w));
    }
  }
  const at = where(p, t);
  // Stable id: where (function) and why (status + the conditions' code), not the message.
  const id = `reject:${it.name}:${status ?? '?'}:${when.map((c) => c.code).join(' && ')}${onError ? ':catch' : ''}`;
  return {
    kind: 'reject', id, source: at, in: it.name, when,
    ...(status !== undefined ? { status } : {}), ...(message !== undefined ? { message } : {}),
    ...(otherMessages.length ? { otherMessages } : {}), ...(onError ? { onError } : {}),
  };
}

function statusOf(p: TsProject, e: ts.Expression): number | undefined {
  if (ts.isNumericLiteral(e)) return Number(e.text);
  if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
    const v = p.checker.getConstantValue(e as ts.PropertyAccessExpression);
    if (typeof v === 'number') return v;
    if (ts.isPropertyAccessExpression(e)) return STATUS_NAMES[e.name.text];
  }
  return undefined;
}

