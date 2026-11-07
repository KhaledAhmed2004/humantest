// What a request must contain, from its Zod schema: field by field (required, type, limits,
// allowed values) plus custom checks (refine / superRefine), with the app's own messages.
// Schemas are read, never run. Works for Zod 3 and 4 (`message` or `error` options).

import ts from 'typescript';
import { declarationOf, where, type TsProject } from '../ts-project.mts';
import { translate, type Words } from './condition.mts';
import { messageTexts } from './messages.mts';
import type { Condition, FieldFacet, FieldRule, Rule } from './types.mts';

type Section = FieldRule['section'];
const SECTIONS = new Set<Section>(['body', 'query', 'params', 'cookies']);

interface Check { name: string; value?: number; message?: string; at: ts.Node }
interface Refine { message?: string; field?: string; when?: Condition; at: ts.Node }

/** A schema, as far as it could be read. */
interface ZNode {
  base: string;
  at: ts.Node;
  coerce?: boolean;
  shape?: Map<string, ZNode>;
  element?: ZNode;
  values?: string[];
  optional?: boolean;
  nullable?: boolean;
  default?: string;
  baseMessage?: string;
  checks: Check[];
  refines: Refine[];
}

const IGNORED = new Set(['trim', 'toLowerCase', 'toUpperCase', 'transform', 'pipe', 'describe', 'strict', 'passthrough', 'strip', 'brand', 'catch', 'readonly', 'meta']);
const FORMATS = new Set(['email', 'uuid', 'url', 'cuid', 'cuid2', 'ulid', 'datetime', 'date', 'time', 'ip', 'regex', 'positive', 'nonnegative', 'negative', 'nonpositive', 'finite', 'startsWith', 'endsWith', 'includes']);

/** Rules from a schema used to validate a request, or undefined when `e` isn't a Zod schema. */
export function schemaRules(p: TsProject, e: ts.Expression, w: Words = {}): Rule[] | undefined {
  const node = new Reader(p, w).parse(e, 0);
  if (!node) return undefined;
  const out: Rule[] = [];
  const wrapped = node.base === 'object' && node.shape && node.shape.size > 0 && [...node.shape.keys()].every((k) => SECTIONS.has(k as Section));
  if (wrapped) {
    for (const [k, child] of node.shape!) fields(p, child, k as Section, '', out);
    refines(p, node, 'body', '', out);
  } else {
    fields(p, node, 'body', '', out);
  }
  return out;
}

/** One rule per fact about each field, and one per custom check. */
function fields(p: TsProject, node: ZNode, section: Section, prefix: string, out: Rule[]) {
  refines(p, node, section, prefix, out);
  if (node.base !== 'object' || !node.shape) return;
  for (const [key, f] of node.shape) {
    const field = prefix ? `${prefix}.${key}` : key;
    const add = (facts: FieldFacet & { message?: string }, at: ts.Node, facet: string = facts.facet) => {
      const rule = { kind: 'field', section, field, ...facts } as FieldRule;
      out.push({ ...rule, id: `field:${section}.${field}:${facet}`, source: where(p, at) });
    };
    const required = !f.optional && f.default === undefined;
    add({ facet: 'required', required, ...(f.default !== undefined ? { default: f.default } : {}), ...(required && f.baseMessage ? { message: f.baseMessage } : {}) }, f.at);
    const type = typeWords(f);
    if (type) add({ facet: 'type', type, ...(f.coerce ? { coerced: true } : {}), ...(!required && f.baseMessage ? { message: f.baseMessage } : {}) }, f.at);
    if (f.values?.length) add({ facet: 'oneOf', values: f.values, ...(f.baseMessage ? { message: f.baseMessage } : {}) }, f.at);
    if (f.nullable) add({ facet: 'nullable' }, f.at);
    const unit: 'characters' | 'items' | 'number' = f.base === 'string' ? 'characters' : f.base === 'array' ? 'items' : 'number';
    for (const c of f.checks) {
      const msg = c.message ? { message: c.message } : {};
      if ((c.name === 'min' || c.name === 'gte') && c.value !== undefined) add({ facet: 'min', value: c.value, unit, ...msg }, c.at);
      else if (c.name === 'gt' && c.value !== undefined) add({ facet: 'min', value: c.value + (unit === 'number' && f.checks.some((x) => x.name === 'int') ? 1 : 0), unit, ...msg }, c.at);
      else if ((c.name === 'max' || c.name === 'lte') && c.value !== undefined) add({ facet: 'max', value: c.value, unit, ...msg }, c.at);
      else if (c.name === 'lt' && c.value !== undefined) add({ facet: 'max', value: c.value - (f.checks.some((x) => x.name === 'int') ? 1 : 0), unit, ...msg }, c.at);
      else if (c.name === 'length' && c.value !== undefined) add({ facet: 'length', value: c.value, unit: unit === 'number' ? 'characters' : unit, ...msg }, c.at);
      else if (FORMATS.has(c.name)) add({ facet: 'format', format: c.name, ...msg }, c.at, `format:${c.name}`);
    }
    if (f.base === 'object') fields(p, f, section, field, out);
    else if (f.base === 'array' && f.element?.base === 'object') fields(p, f.element, section, `${field}[]`, out);
    else if (f.base === 'array' && f.element) {
      // Limits on each item: `z.array(z.string().min(1, '…'))`.
      for (const c of f.element.checks) {
        if (c.name === 'min' && c.value !== undefined && f.element.base === 'string') {
          const rule = { kind: 'field', section, field: `${field}[]`, facet: 'min', value: c.value, unit: 'characters', ...(c.message ? { message: c.message } : {}) } as FieldRule;
          out.push({ ...rule, id: `field:${section}.${field}[]:min`, source: where(p, c.at) });
        }
      }
    }
  }
}

function refines(p: TsProject, node: ZNode, section: Section, prefix: string, out: Rule[]) {
  for (const r of node.refines) {
    const field = r.field ? (prefix ? `${prefix}.${r.field}` : r.field) : prefix || undefined;
    out.push({
      kind: 'check', section, ...(field ? { field } : {}), ...(r.message ? { message: r.message } : {}), ...(r.when ? { when: r.when } : {}),
      id: `check:${section}.${field ?? ''}:${r.message ?? r.when?.code ?? r.at.getText().slice(0, 40)}`,
      source: where(p, r.at),
    });
  }
}

function typeWords(f: ZNode): string | undefined {
  const isInt = f.checks.some((c) => c.name === 'int');
  switch (f.base) {
    case 'string': return 'text';
    case 'number': return isInt ? 'a whole number' : 'a number';
    case 'int': return 'a whole number';
    case 'boolean': return 'true or false';
    case 'date': return 'a date';
    case 'bigint': return 'a whole number';
    case 'array': {
      const of = f.element ? typeWords(f.element) : undefined;
      return of ? `a list of ${of === 'text' ? 'text' : of.replace(/^an? /, '')}${of === 'text' ? '' : 's'}` : 'a list';
    }
    case 'object': return undefined;
    case 'email': return 'an email address';
    case 'uuid': return 'a UUID';
    default: return undefined;
  }
}

class Reader {
  private p: TsProject;
  private w: Words;
  constructor(p: TsProject, w: Words) {
    this.p = p;
    this.w = w;
  }

  /** Is this `z` (or another name imported from 'zod')? */
  private isZod(e: ts.Expression): boolean {
    if (!ts.isIdentifier(e)) return false;
    const sym = this.p.checker.getSymbolAtLocation(e);
    const d = sym?.declarations?.[0];
    if (d && (ts.isImportSpecifier(d) || ts.isNamespaceImport(d) || ts.isImportClause(d))) {
      let n: ts.Node = d;
      while (n && !ts.isImportDeclaration(n)) n = n.parent;
      if (n && ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) return /^zod(\/|$)/.test(n.moduleSpecifier.text);
    }
    return e.text === 'z';
  }

  parse(e: ts.Expression, depth: number): ZNode | undefined {
    if (depth > 8) return undefined;
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
    const methods: ts.CallExpression[] = [];
    let cur: ts.Expression = e;
    let node: ZNode | undefined;
    for (;;) {
      if (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
        const recv = cur.expression.expression;
        if (this.isZod(recv)) { node = this.base(cur.expression.name.text, cur, false, depth); break; }
        // z.coerce.number()
        if (ts.isPropertyAccessExpression(recv) && recv.name.text === 'coerce' && this.isZod(recv.expression)) {
          node = this.base(cur.expression.name.text, cur, true, depth);
          break;
        }
        methods.unshift(cur);
        cur = recv;
        continue;
      }
      if (ts.isCallExpression(cur)) {
        // validateBody({...}) / validateQuery(schema): helpers that wrap a schema in { body } / { query }.
        const name = cur.expression.getText().split('.').pop() ?? '';
        const m = name.match(/^validate(Body|Query|Params|Cookies)$/);
        if (m && cur.arguments[0]) {
          const inner = ts.isObjectLiteralExpression(cur.arguments[0]) ? this.object(cur.arguments[0], cur, depth) : this.parse(cur.arguments[0], depth + 1);
          if (!inner) return undefined;
          node = { base: 'object', at: cur, shape: new Map([[m[1].toLowerCase(), inner]]), checks: [], refines: [] };
          break;
        }
        return undefined;
      }
      if (ts.isIdentifier(cur) || ts.isPropertyAccessExpression(cur)) {
        // Another schema by name: read where it is defined.
        const d = declarationOf(this.p, cur);
        if (d && ts.isVariableDeclaration(d) && d.initializer) {
          const inner = this.parse(d.initializer, depth + 1);
          node = inner && clone(inner);
          break;
        }
      }
      return undefined;
    }
    if (!node) return undefined;
    for (const call of methods) this.method(node, call, depth);
    return node;
  }

  private base(kind: string, call: ts.CallExpression, coerce: boolean, depth: number): ZNode | undefined {
    const n: ZNode = { base: kind, at: call, checks: [], refines: [], ...(coerce ? { coerce } : {}) };
    const args = call.arguments;
    switch (kind) {
      case 'object':
      case 'strictObject':
      case 'looseObject':
        if (!args[0] || !ts.isObjectLiteralExpression(args[0])) return { ...n, base: 'object', shape: new Map() };
        return this.object(args[0], call, depth);
      case 'array':
        n.element = args[0] ? this.parse(args[0], depth + 1) : undefined;
        n.baseMessage = message(args[1]);
        return n;
      case 'enum':
      case 'nativeEnum':
        n.base = 'enum';
        n.values = this.enumValues(args[0]);
        n.baseMessage = message(args[1]);
        return n;
      case 'literal':
        n.values = args[0] ? [literalText(args[0])] : [];
        return n;
      case 'email':
      case 'uuid':
      case 'url':
        // Zod 4: z.email() is a string with a format.
        return { ...n, base: 'string', checks: [{ name: kind, at: call, ...(message(args[0]) ? { message: message(args[0]) } : {}) }] };
      default:
        n.baseMessage = message(args[0]);
        return n;
    }
  }

  private object(lit: ts.ObjectLiteralExpression, at: ts.Node, depth: number): ZNode {
    const shape = new Map<string, ZNode>();
    for (const pr of lit.properties) {
      const key = pr.name && (ts.isIdentifier(pr.name) || ts.isStringLiteral(pr.name)) ? pr.name.text : undefined;
      if (!key) continue;
      const value = ts.isPropertyAssignment(pr) ? this.parse(pr.initializer, depth + 1) : ts.isShorthandPropertyAssignment(pr) ? this.parse(pr.name, depth + 1) : undefined;
      // Keep the field even when its schema can't be read: that it exists is still a fact.
      shape.set(key, value ? { ...value, at: pr } : { base: 'unknown', at: pr, checks: [], refines: [] });
    }
    return { base: 'object', at, shape, checks: [], refines: [] };
  }

  private method(n: ZNode, call: ts.CallExpression, depth: number) {
    const name = (call.expression as ts.PropertyAccessExpression).name.text;
    const a = call.arguments;
    if (IGNORED.has(name)) return;
    switch (name) {
      case 'optional': n.optional = true; return;
      case 'nullable': n.nullable = true; return;
      case 'nullish': n.optional = true; n.nullable = true; return;
      case 'default': n.default = a[0] ? literalText(a[0]) : undefined; return;
      case 'partial': for (const f of n.shape?.values() ?? []) f.optional = true; return;
      case 'required': for (const f of n.shape?.values() ?? []) f.optional = false; return;
      case 'extend':
      case 'merge': {
        const more = a[0] && ts.isObjectLiteralExpression(a[0]) ? this.object(a[0], call, depth) : a[0] ? this.parse(a[0], depth + 1) : undefined;
        if (more?.shape) n.shape = new Map([...(n.shape ?? []), ...more.shape]);
        return;
      }
      case 'pick':
      case 'omit': {
        if (!n.shape || !a[0] || !ts.isObjectLiteralExpression(a[0])) return;
        const keys = new Set(a[0].properties.map((pr) => pr.name?.getText()));
        n.shape = new Map([...n.shape].filter(([k]) => keys.has(k) === (name === 'pick')));
        return;
      }
      case 'array':
        Object.assign(n, { base: 'array', element: clone(n), checks: [], refines: [], shape: undefined, values: undefined });
        return;
      case 'refine': {
        const opts = a[1];
        const field = opts && ts.isObjectLiteralExpression(opts) ? pathOf(opts) : undefined;
        n.refines.push({ message: message(opts), ...(field ? { field } : {}), at: call });
        return;
      }
      case 'superRefine':
      case 'check':
        this.superRefine(n, call);
        return;
      default:
        if (['min', 'max', 'length', 'gt', 'gte', 'lt', 'lte', 'int', 'multipleOf'].includes(name) || FORMATS.has(name)) {
          const value = a[0] ? this.number(a[0]) : undefined;
          const msgArg = ['int', 'email', 'uuid', 'url', 'positive', 'nonnegative', 'negative', 'nonpositive', 'datetime', 'cuid'].includes(name) ? a[0] : a[1];
          n.checks.push({ name, at: call, ...(value !== undefined ? { value } : {}), ...(message(msgArg) ? { message: message(msgArg) } : {}) });
        }
    }
  }

  /** `ctx.addIssue({ message, path })` inside superRefine, with the if-conditions around it. */
  private superRefine(n: ZNode, call: ts.CallExpression) {
    const fn = call.arguments[0];
    if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
      n.refines.push({ at: call });
      return;
    }
    const found: Refine[] = [];
    const visit = (x: ts.Node) => {
      if (ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression) && x.expression.name.text === 'addIssue' && x.arguments[0] && ts.isObjectLiteralExpression(x.arguments[0])) {
        const opts = x.arguments[0];
        const when: Condition[] = [];
        let child: ts.Node = x;
        for (let up = x.parent; up && up !== fn; child = up, up = up.parent) {
          if (ts.isIfStatement(up)) when.unshift(translate(this.p, up.expression, child === up.elseStatement, this.w));
        }
        const field = pathOf(opts);
        const joined: Condition | undefined = when.length === 0 ? undefined : when.length === 1 ? when[0]
          : { code: when.map((c) => c.code).join(' && '), ...(when.every((c) => c.text) ? { text: when.map((c) => c.text).join(', and ') } : {}) };
        found.push({ message: message(opts), ...(field ? { field } : {}), ...(joined ? { when: joined } : {}), at: x });
      }
      ts.forEachChild(x, visit);
    };
    visit(fn.body);
    n.refines.push(...(found.length ? found : [{ at: call }]));
  }

  private number(e: ts.Expression): number | undefined {
    if (ts.isNumericLiteral(e)) return Number(e.text.replace(/_/g, ''));
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(e.operand)) return -Number(e.operand.text);
    if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) {
      const d = declarationOf(this.p, e);
      if (d && ts.isVariableDeclaration(d) && d.initializer) return this.number(d.initializer);
    }
    return undefined;
  }

  /** Values of `z.enum(['A', 'B'])`, `z.enum([Status.A, Status.B])` or `z.enum(PrismaEnum)`. */
  private enumValues(e: ts.Expression | undefined): string[] | undefined {
    if (!e) return undefined;
    if (ts.isArrayLiteralExpression(e)) return e.elements.map((x) => (ts.isPropertyAccessExpression(x) ? x.name.text : literalText(x)));
    if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) {
      const d = declarationOf(this.p, e);
      if (d && ts.isVariableDeclaration(d) && d.initializer) {
        let init: ts.Expression = d.initializer;
        while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init)) init = init.expression;
        if (ts.isArrayLiteralExpression(init)) return this.enumValues(init);
      }
      // An enum or an enum-like object (Prisma's): its property names.
      const t = this.p.checker.getTypeAtLocation(e);
      const names = this.p.checker.getPropertiesOfType(t).map((s) => s.name);
      if (names.length) return names;
    }
    return undefined;
  }
}

function clone(n: ZNode): ZNode {
  return { ...n, checks: [...n.checks], refines: [...n.refines], ...(n.shape ? { shape: new Map([...n.shape].map(([k, v]) => [k, clone(v)])) } : {}) };
}

/** The message in `'text'`, `{ message: 'text' }` or `{ error: 'text' }` (Zod 4). */
function message(e: ts.Expression | undefined): string | undefined {
  if (!e) return undefined;
  if (!ts.isObjectLiteralExpression(e)) return messageTexts(e)?.join('" or "');
  {
    for (const key of ['message', 'error', 'required_error', 'invalid_type_error']) {
      const pr = e.properties.find((x) => ts.isPropertyAssignment(x) && x.name.getText() === key);
      if (pr && ts.isPropertyAssignment(pr)) {
        const m = message(pr.initializer);
        if (m) return m;
      }
    }
  }
  return undefined;
}

/** `path: ['destinationPortId']` → "destinationPortId". */
function pathOf(opts: ts.ObjectLiteralExpression): string | undefined {
  const pr = opts.properties.find((x) => ts.isPropertyAssignment(x) && x.name.getText() === 'path');
  if (!pr || !ts.isPropertyAssignment(pr) || !ts.isArrayLiteralExpression(pr.initializer)) return undefined;
  const parts = pr.initializer.elements.map((x) => (ts.isStringLiteral(x) ? x.text : ts.isNumericLiteral(x) ? `[${x.text}]` : '…'));
  return parts.join('.').replace(/\.\[/g, '[');
}

function literalText(e: ts.Expression): string {
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (ts.isPropertyAccessExpression(e) && /^[A-Z][A-Z0-9_]*$/.test(e.name.text)) return e.name.text;
  if (ts.isArrayLiteralExpression(e) && !e.elements.length) return 'empty list';
  return e.getText().replace(/\s+/g, ' ');
}
