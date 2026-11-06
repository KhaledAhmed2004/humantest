// Who may make a request: `auth(USER_ROLES.ADMIN)`, `auth(...ALL_ROLES)`, `optionalAuth`.
// Recognised by the middleware's name (auth, role, permission, guard, authorize) and what it is given.

import ts from 'typescript';
import type { RouteArg, RouteEntry } from '../backend/express.mts';
import { declarationOf, type TsProject } from '../ts-project.mts';
import type { AccessRule, Rule } from './types.mts';

const AUTH_NAME = /auth|role|permission|guard|protect/i;
const OPTIONAL_NAME = /optional/i;

const calleeName = (a: RouteArg) => a.text.replace(/\(.*$/s, '').split('.').pop() ?? a.text;

export function accessRules(p: TsProject, route: RouteEntry): Rule[] {
  const out: Rule[] = [];
  for (const mw of route.middlewares) {
    const name = calleeName(mw);
    if (!AUTH_NAME.test(name) || !mw.ref) continue;
    const call = mw.node && ts.isCallExpression(mw.node) ? mw.node : undefined;
    const roles: string[] = [];
    let optional = OPTIONAL_NAME.test(name);
    let allRoles = false;
    for (const arg of call?.arguments ?? []) {
      // `{ optional: true }` options object.
      if (ts.isObjectLiteralExpression(arg)) {
        if (arg.properties.some((pr) => ts.isPropertyAssignment(pr) && pr.name.getText() === 'optional' && pr.initializer.kind === ts.SyntaxKind.TrueKeyword)) optional = true;
        continue;
      }
      const values = roleValues(p, ts.isSpreadElement(arg) ? arg.expression : arg);
      if (!values) continue;
      roles.push(...values.names);
      if (values.whole) allRoles = true;
    }
    const facts: AccessRule = { kind: 'access', roles: [...new Set(roles)], login: optional ? 'optional' : 'required', via: mw.text, ...(allRoles ? { allRoles } : {}) };
    out.push({ ...facts, id: 'access', source: { file: route.file, line: route.line } });
  }
  return out;
}

/**
 * Role names from `USER_ROLES.ADMIN`, `'ADMIN'`, or an array constant like `ALL_ROLES`.
 * `whole`: the array lists every member of its enum.
 */
function roleValues(p: TsProject, e: ts.Expression): { names: string[]; whole?: boolean } | undefined {
  if (ts.isStringLiteral(e)) return { names: [e.text] };
  if (ts.isPropertyAccessExpression(e)) return { names: [e.name.text] };
  if (ts.isIdentifier(e)) {
    const decl = declarationOf(p, e);
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
      let init: ts.Expression = decl.initializer;
      while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init)) init = init.expression;
      // Object.values(USER_ROLES): every role.
      if (ts.isCallExpression(init) && init.expression.getText() === 'Object.values' && init.arguments[0]) {
        const en = declarationOf(p, init.arguments[0]);
        if (en && ts.isEnumDeclaration(en)) return { names: en.members.map((m) => m.name.getText()), whole: true };
      }
      if (ts.isArrayLiteralExpression(init)) {
        const names: string[] = [];
        let enumDecl: ts.EnumDeclaration | undefined;
        for (const el of init.elements) {
          const v = roleValues(p, el);
          if (!v) return undefined;
          names.push(...v.names);
          const d = ts.isPropertyAccessExpression(el) ? declarationOf(p, el) : undefined;
          if (d && ts.isEnumMember(d)) enumDecl = d.parent;
        }
        return { names, whole: !!enumDecl && enumDecl.members.length === new Set(names).size };
      }
    }
  }
  return undefined;
}
