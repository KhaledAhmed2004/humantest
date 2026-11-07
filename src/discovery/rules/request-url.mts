// Conditions on the request's own address, worked out for the route they are read for:
//   if (req.baseUrl.endsWith('/trips') || req.originalUrl.includes('/trips/')) return getPublicTripById(…)
// For GET /api/v1/trips/:id that is always so: the rules past it never happen there (they are left
// out), and for GET /api/v1/schedules/:id it never is (the condition is left out: it says nothing).

import ts from 'typescript';
import type { RouteEntry } from '../backend/express.mts';
import type { Condition, Rule } from './types.mts';

/** The parts of the address Express gives a handler, for one route. */
interface Address { baseUrl: string; originalUrl: string; path: string }

const REQ = /^(req|request)$/;

/** true / false when the code is only about the address, undefined when anything else is in it. */
export function evalAddress(code: string, a: Address): boolean | undefined {
  const sf = ts.createSourceFile('c.ts', `(${code})`, ts.ScriptTarget.Latest, false);
  const st = sf.statements[0];
  if (!st || !ts.isExpressionStatement(st)) return undefined;
  const part = (e: ts.Expression): string | undefined => {
    if (!ts.isPropertyAccessExpression(e) || !ts.isIdentifier(e.expression) || !REQ.test(e.expression.text)) return undefined;
    const n = e.name.text;
    return n === 'baseUrl' ? a.baseUrl : n === 'originalUrl' || n === 'url' ? a.originalUrl : n === 'path' ? a.path : undefined;
  };
  const text = (e: ts.Expression) => (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) ? e.text : undefined);
  const ev = (e: ts.Expression): boolean | undefined => {
    if (ts.isParenthesizedExpression(e)) return ev(e.expression);
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
      const v = ev(e.operand);
      return v === undefined ? undefined : !v;
    }
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.AmpersandAmpersandToken) {
        const l = ev(e.left), r = ev(e.right);
        const or = op === ts.SyntaxKind.BarBarToken;
        // One side settles it whatever the other is: `true || ?`, `false && ?`.
        if (l === or || r === or) return or;
        return l === undefined || r === undefined ? undefined : or ? l || r : l && r;
      }
      if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
        const v = part(e.left) ?? part(e.right), t = text(e.right) ?? text(e.left);
        if (v === undefined || t === undefined) return undefined;
        return (v === t) === (op === ts.SyntaxKind.EqualsEqualsEqualsToken);
      }
      return undefined;
    }
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.arguments.length === 1) {
      const v = part(e.expression.expression), t = text(e.arguments[0]);
      if (v === undefined || t === undefined) return undefined;
      const m = e.expression.name.text;
      return m === 'endsWith' ? v.endsWith(t) : m === 'startsWith' ? v.startsWith(t) : m === 'includes' ? v.includes(t) : undefined;
    }
    return undefined;
  };
  return ev(st.expression);
}

/**
 * Rules for one route: one behind an address condition that is never so there is left out; an
 * address condition that is always so is taken out of the rule (its id stays as it was).
 */
export function forAddress(rules: Rule[], route: RouteEntry): Rule[] {
  const mount = route.mount ?? '';
  const a: Address = { baseUrl: mount, originalUrl: route.path, path: route.path.slice(mount.length) || '/' };
  const out: Rule[] = [];
  for (const r of rules) {
    if (!('when' in r) || !Array.isArray(r.when)) { out.push(r); continue; }
    const path = 'path' in r ? r.path : undefined;
    const all = [...(path?.when ?? []), ...r.when];
    const values = all.map((c) => evalAddress(c.code, a));
    if (values.includes(false)) continue;
    if (!values.includes(true)) { out.push(r); continue; }
    const keep = (cs: Condition[]) => cs.filter((c) => evalAddress(c.code, a) !== true);
    const when = keep(path?.when ?? []);
    out.push({
      ...r, when: keep(r.when),
      ...(path ? (when.length ? { path: { ...path, when } } : { path: undefined }) : {}),
    } as Rule);
  }
  return out;
}
