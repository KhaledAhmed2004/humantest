// The code slice of one route: the functions, schemas and constants a request can run through,
// found by following references from the route's handler and middleware arguments through the
// app's own code (never into node_modules).

import ts from 'typescript';
import { declarationOf, isCodeDeclaration, isOwnFile, refOf, type CodeRef, type TsProject } from '../ts-project.mts';
import type { RouteArg, RouteEntry } from './express.mts';

export interface SliceItem extends CodeRef {
  /** How deep in the call chain: 0 = named on the route itself. */
  depth: number;
  /** What led here: `RouteService.createRoute`, `validateRequest(…)`. */
  via: string;
  /** Index of the item that refers to this one, or -1. */
  parent: number;
  /** Already listed earlier (it is reached from more than one place). */
  repeat?: boolean;
  /** Its code, for the rule extractors. Not part of the JSON output. */
  decl: ts.Node;
}

export interface Slice { route: RouteEntry; items: SliceItem[] }

const MAX_DEPTH = 6;

/**
 * Shared infrastructure (catchAsync, sendResponse, the Prisma client, ApiError) and middleware
 * bodies (auth's session checks) are listed, but not followed: they are the same for every route,
 * and their insides would bury the route's own logic. What a middleware is configured with
 * (`auth(ADMIN)`, the schema in `validateRequest(schema)`) is followed.
 */
const FOLLOW = new Set(['route', 'controller', 'service', 'helper', 'validation']);

export function sliceRoute(p: TsProject, route: RouteEntry): Slice {
  const items: SliceItem[] = [];
  const seen = new Map<ts.Node, number>();

  const add = (decl: ts.Node, via: string, depth: number, parent: number): number => {
    const prev = seen.get(decl);
    if (prev !== undefined) {
      // Reached again from somewhere else: note it once per place, so the tree shows who uses it.
      if (prev !== parent && !items.some((it) => it.parent === parent && it.file === items[prev].file && it.line === items[prev].line)) {
        items.push({ ...items[prev], depth, via, parent, repeat: true });
      }
      return -1;
    }
    const index = items.push({ ...refOf(p, decl), depth, via, parent, decl }) - 1;
    seen.set(decl, index);
    if (depth < MAX_DEPTH && FOLLOW.has(items[index].role)) follow(decl, depth + 1, index);
    return index;
  };

  /** Every reference inside `root` to a function/schema/constant declared elsewhere in the app. */
  const follow = (root: ts.Node, depth: number, parent: number) => {
    const visit = (n: ts.Node) => {
      // Type positions (`: IRoute`) are not logic.
      if (ts.isTypeNode(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) return;
      // An identifier that is a name (`x.name`, `{ name: … }`, `const name`) is not a reference to something else.
      const isRef = ts.isIdentifier(n) && (n.parent as { name?: ts.Node }).name !== n;
      const isMember = ts.isPropertyAccessExpression(n);
      if (isRef || isMember) {
        const decl = declarationOf(p, n);
        if (decl && decl !== root && !isInside(decl, root) && isOwnFile(p, decl.getSourceFile()) && isCodeDeclaration(decl) &&
          !isExportMap(decl)) {
          add(decl, viaText(n), depth, parent);
          // `XService.createX`: don't look at `XService` on its own again.
          if (isMember) return;
        }
      }
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(root, visit);
  };

  const fromArg = (arg: RouteArg, depth: number, parent: number) => {
    const at = arg.decl ? add(arg.decl, arg.text, depth, parent) : -1;
    for (const a of arg.args ?? []) fromArg(a, depth + 1, at >= 0 ? at : parent);
  };

  for (const mw of route.middlewares) fromArg(mw, 0, -1);
  if (route.handler) fromArg(route.handler, 0, -1);
  return { route, items };
}

/**
 * `export const RouteService = { createRoute, listRoutes, … }`: only a list of names. Following it
 * would pull in every function of the module, not just the one this route uses.
 */
const isExportMap = (decl: ts.Node) =>
  ts.isVariableDeclaration(decl) && !!decl.initializer && ts.isObjectLiteralExpression(decl.initializer) &&
  decl.initializer.properties.length > 0 &&
  decl.initializer.properties.every((pr) => ts.isShorthandPropertyAssignment(pr) ||
    (ts.isPropertyAssignment(pr) && (ts.isIdentifier(pr.initializer) || ts.isPropertyAccessExpression(pr.initializer))));

const isInside = (node: ts.Node, root: ts.Node) => node.pos >= root.pos && node.end <= root.end && node.getSourceFile() === root.getSourceFile();

const viaText = (n: ts.Node) => {
  const call = ts.isCallExpression(n.parent) && n.parent.expression === n ? '(…)' : '';
  const t = n.getText().replace(/\s+/g, ' ');
  return `${t.length > 60 ? `${t.slice(0, 59)}…` : t}${call}`;
};
