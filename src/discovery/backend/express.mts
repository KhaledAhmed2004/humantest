// Builds an Express app's route table by reading its code (it is never run), then matches a recorded
// request like `POST /api/v1/routes` to the route Express would pick: the first match, in the
// order the app registers them, through nested routers.

import ts from 'typescript';
import { declarationOf, isOwnFile, refOf, shortText, stringValue, where, type CodeRef, type TsProject } from '../ts-project.mts';

const VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all']);

/** One argument of a route: `auth(USER_ROLES.ADMIN)`, `RouteController.createRoute`. */
export interface RouteArg {
  text: string;
  /** Where its function is defined (for a call like `auth(...)`, the called function). */
  ref?: CodeRef;
  /** The declaration node, for the slicer. */
  decl?: ts.Node;
  /** For a call: its arguments, e.g. the schema in `validateRequest(schema)`. */
  args?: RouteArg[];
  /** The expression as written in the route, for the rule extractors. */
  node?: ts.Expression;
}

export interface RouteEntry {
  method: string;
  /** The full path, mount prefixes included, e.g. `/api/v1/routes/:id`. */
  path: string;
  /** The mount prefixes alone (what Express calls `req.baseUrl`), e.g. `/api/v1/routes`. */
  mount?: string;
  file: string;
  line: number;
  /** Everything between the path and the handler, router-level middleware first. */
  middlewares: RouteArg[];
  handler?: RouteArg;
}

export interface RouteTable {
  routes: RouteEntry[];
  /** Things that could not be read statically, e.g. a path built at runtime. Never silently dropped. */
  unresolved: string[];
}

/** A `const x = express()` or `const r = express.Router()` / `Router()`. */
type Kind = 'app' | 'router';

function kindOf(decl: ts.Node | undefined): Kind | undefined {
  if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer || !ts.isCallExpression(decl.initializer)) return undefined;
  const callee = decl.initializer.expression.getText();
  if (/(^|\.)Router$/.test(callee)) return 'router';
  if (callee === 'express') return 'app';
  return undefined;
}

interface Registration { method: string; args: ts.Expression[]; at: ts.Node; env: Env }
/** forEach over an array of object literals: parameter name -> the element being visited. */
type Env = Map<string, ts.ObjectLiteralExpression>;

/** Resolve `route.path` inside `apiRoutes.forEach(route => router.use(route.path, route.route))`. */
function inEnv(e: ts.Expression, env: Env): ts.Expression {
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) {
    const obj = env.get(e.expression.text);
    const prop = obj?.properties.find((pr) => pr.name && ts.isIdentifier(pr.name) && pr.name.text === e.name.text);
    if (prop && ts.isPropertyAssignment(prop)) return prop.initializer;
    if (prop && ts.isShorthandPropertyAssignment(prop)) return prop.name;
  }
  return e;
}

/** Every `x.get(...)`, `x.use(...)` … made on this app or router, in source order. */
function registrationsOf(p: TsProject, owner: ts.VariableDeclaration): Registration[] {
  const sf = owner.getSourceFile();
  const out: Registration[] = [];
  const visit = (node: ts.Node, env: Env) => {
    // apiRoutes.forEach(route => router.use(route.path, route.route))
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'forEach') {
      const fn = node.arguments[0];
      const arr = declarationOf(p, node.expression.expression);
      if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && fn.parameters[0] && ts.isIdentifier(fn.parameters[0].name) &&
        arr && ts.isVariableDeclaration(arr) && arr.initializer && ts.isArrayLiteralExpression(arr.initializer)) {
        const param = fn.parameters[0].name.text;
        for (const el of arr.initializer.elements) {
          if (ts.isObjectLiteralExpression(el)) visit(fn.body, new Map(env).set(param, el));
        }
        return;
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text.toLowerCase();
      if ((VERBS.has(method) || method === 'use') && declarationOf(p, node.expression.expression) === owner) {
        out.push({ method, args: node.arguments.map((a) => inEnv(a, env)), at: node, env });
      }
    }
    ts.forEachChild(node, (c) => visit(c, env));
  };
  visit(sf, new Map());
  return out;
}

function describe(p: TsProject, e: ts.Expression): RouteArg {
  // `router.get('/:id', (req, res, next) => { … })`: the function written right there is the code.
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
    return { text: 'function written in the route', decl: e, ref: refOf(p, e), node: e };
  }
  const arg: RouteArg = { text: shortText(e), node: e };
  // `auth(...ALL_ROLES)`: what is spread is the array.
  const target = ts.isCallExpression(e) ? e.expression : ts.isSpreadElement(e) ? e.expression : e;
  const decl = declarationOf(p, target);
  if (decl && isOwnFile(p, decl.getSourceFile())) {
    arg.decl = decl;
    arg.ref = refOf(p, decl);
  }
  if (ts.isCallExpression(e)) arg.args = e.arguments.map((a) => describe(p, a));
  return arg;
}

const joinPath = (a: string, b: string) => {
  const j = `${a.replace(/\/+$/, '')}/${b.replace(/^\/+/, '')}`.replace(/\/+/g, '/');
  return j.length > 1 ? j.replace(/\/$/, '') : j;
};

export function buildRouteTable(p: TsProject): RouteTable {
  const table: RouteTable = { routes: [], unresolved: [] };
  const apps: ts.VariableDeclaration[] = [];
  for (const sf of p.program.getSourceFiles()) {
    if (!isOwnFile(p, sf)) continue;
    const visit = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) && kindOf(n) === 'app') apps.push(n);
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  if (!apps.length) table.unresolved.push('No `const app = express()` found in the backend code.');

  const walk = (owner: ts.VariableDeclaration, prefix: string, inherited: RouteArg[], stack: ts.Node[]) => {
    if (stack.includes(owner)) return;
    const isApp = kindOf(owner) === 'app';
    // `router.use(auth(...))` without a path applies to every route registered after it on this router.
    const routerLevel: RouteArg[] = [];
    for (const reg of registrationsOf(p, owner)) {
      const at = where(p, reg.at);
      const first = reg.args[0];
      const literal = stringValue(p, first);
      if (reg.method === 'use') {
        const hasPath = literal !== undefined;
        if (!hasPath && first && ts.isTemplateExpression(first)) {
          table.unresolved.push(`${at.file}:${at.line} mounts at a path built at runtime: ${shortText(first)}`);
          continue;
        }
        const rest = hasPath ? reg.args.slice(1) : reg.args;
        const mw: RouteArg[] = [];
        for (const a of rest) {
          const decl = declarationOf(p, a);
          if (decl && ts.isVariableDeclaration(decl) && kindOf(decl) === 'router') {
            walk(decl, joinPath(prefix, literal ?? ''), [...inherited, ...routerLevel, ...mw], [...stack, owner]);
          } else if (!isApp) {
            // Middleware on the app itself (logging, CORS, body parsers) is infrastructure, not business logic.
            (hasPath ? mw : routerLevel).push(describe(p, a));
          }
        }
        continue;
      }
      if (literal === undefined) {
        table.unresolved.push(`${at.file}:${at.line} ${reg.method.toUpperCase()} with a path that isn't a plain string: ${first ? shortText(first) : '(none)'}`);
        continue;
      }
      const handlers = reg.args.slice(1).map((a) => describe(p, a));
      table.routes.push({
        method: reg.method.toUpperCase(),
        path: joinPath(prefix, literal),
        mount: prefix,
        ...at,
        middlewares: [...inherited, ...routerLevel, ...handlers.slice(0, -1)],
        handler: handlers.at(-1),
      });
    }
  };
  for (const app of apps) walk(app, '', [], []);
  return table;
}

/** Express 4 path syntax: `:id`, `:id?`, `*`. Trailing slash optional, case-insensitive (Express's defaults). */
function pathRegex(pattern: string): { re: RegExp; keys: string[] } {
  const keys: string[] = [];
  let src = '';
  for (const seg of pattern.split('/').filter(Boolean)) {
    const m = seg.match(/^:(\w+)(\?)?$/);
    if (m) {
      keys.push(m[1]);
      src += m[2] ? '(?:/([^/]+))?' : '/([^/]+)';
    } else if (seg === '*') {
      keys.push('0');
      src += '/(.*)';
    } else {
      src += `/${seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
    }
  }
  return { re: new RegExp(`^${src || '/'}/?$`, 'i'), keys };
}

export function matchRoute(table: RouteTable, method: string, pathname: string): { route: RouteEntry; params: Record<string, string> } | undefined {
  const m = method.toUpperCase();
  for (const route of table.routes) {
    if (route.method !== m && route.method !== 'ALL' && !(m === 'HEAD' && route.method === 'GET')) continue;
    const { re, keys } = pathRegex(route.path);
    const hit = pathname.match(re);
    if (hit) return { route, params: Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(hit[i + 1] ?? '')])) };
  }
  return undefined;
}
