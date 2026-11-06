// What the page's own code does when a step clicks something: found by the words on it, in the
// page's components. Rules: when it can't be used (`disabled={…}`), when the page stops before
// sending anything (`if (…) { toast.error('…'); return; }` in its handler), and the form's own
// validation (`useForm({ resolver: zodResolver(schema) })`).

import path from 'node:path';
import ts from 'typescript';
import { declarationOf, isOwnFile, refOf, where, type CodeRef, type TsProject } from '../ts-project.mts';
import { translate, type Words } from '../rules/condition.mts';
import { messageTexts } from '../rules/messages.mts';
import type { Condition, Rule } from '../rules/types.mts';
import { schemaRules } from '../rules/zod.mts';
import { componentFiles, type Frontend } from './next.mts';

export interface ActionFound {
  /** Where the clicked element is written. */
  element: { file: string; line: number; tag: string };
  /** The component it is in, e.g. "RouteFormModalDialog". */
  component: string;
  rules: Rule[];
  /** The code this depends on (component, handlers, schema), for change detection. */
  functions: CodeRef[];
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** Interactive elements: what a click lands on. */
const INTERACTIVE_TAG = /^(button|a|input|summary)$|Button$|Link$|MenuItem$|Trigger$|^Tab|Checkbox$|Switch$/;

/** Calls that tell the user why nothing happened. */
const NOTIFY = /^(toast(\.(error|warning|warn|info|message))?|alert|notify\w*|showError\w*|message\.(error|warning))$/;

const tagOf = (el: ts.JsxElement | ts.JsxSelfClosingElement) =>
  (ts.isJsxElement(el) ? el.openingElement.tagName : el.tagName).getText();

const attrsOf = (el: ts.JsxElement | ts.JsxSelfClosingElement) =>
  (ts.isJsxElement(el) ? el.openingElement.attributes : el.attributes).properties;

function attr(el: ts.JsxElement | ts.JsxSelfClosingElement, name: string): ts.Expression | ts.StringLiteral | true | undefined {
  for (const a of attrsOf(el)) {
    if (!ts.isJsxAttribute(a) || a.name.getText() !== name) continue;
    if (!a.initializer) return true;
    if (ts.isStringLiteral(a.initializer)) return a.initializer;
    if (ts.isJsxExpression(a.initializer) && a.initializer.expression) return a.initializer.expression;
  }
  return undefined;
}

/** The words a JSX element shows: its text, string literals in {…} (each branch of a ?: on its own), aria-label. */
function wordsOf(el: ts.JsxElement | ts.JsxSelfClosingElement): string[] {
  const out: string[] = [];
  const label = attr(el, 'aria-label');
  if (label && label !== true && ts.isStringLiteral(label)) out.push(label.text);
  if (!ts.isJsxElement(el)) return out;
  // Each branch of `{busy ? <>Saving…</> : <>Sign In <Arrow /></>}` is its own possible text.
  const textOf = (children: ts.NodeArray<ts.JsxChild>) => {
    let text = '';
    for (const c of children) {
      if (ts.isJsxText(c)) text += ` ${c.text}`;
      else if (ts.isJsxExpression(c) && c.expression) branches(c.expression);
    }
    if (text.trim()) out.push(text);
  };
  const branches = (e: ts.Expression) => {
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) out.push(e.text);
    else if (ts.isConditionalExpression(e)) { branches(e.whenTrue); branches(e.whenFalse); }
    else if (ts.isParenthesizedExpression(e)) branches(e.expression);
    else if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) branches(e.right);
    else if (ts.isJsxFragment(e)) textOf(e.children);
    else if (ts.isJsxElement(e) && !INTERACTIVE_TAG.test(e.openingElement.tagName.getText())) textOf(e.children);
  };
  textOf(el.children);
  return out;
}

type Clickable = ts.JsxElement | ts.JsxSelfClosingElement | ts.ObjectLiteralExpression;

const LABEL_PROP = /^(label|title|name|text)$/;
const HANDLER_PROP = /^(onSelect|onClick|onPress|onAction|action|handler)$/;

/** A property of `{ label: 'Delete route', onSelect: () => … }`. */
function prop(o: ts.ObjectLiteralExpression, re: RegExp): ts.Expression | undefined {
  for (const pr of o.properties) {
    if (ts.isPropertyAssignment(pr) && re.test(pr.name.getText())) return pr.initializer;
    if (ts.isMethodDeclaration(pr) && re.test(pr.name.getText())) return pr as unknown as ts.Expression;
  }
  return undefined;
}

/**
 * An item of a data-driven menu: `actions={[{ label: 'Delete route', onSelect: () => onDelete(item) }]}`.
 * Its words are in an object, not in JSX; the component that draws the menu is shared.
 */
function menuItemWords(n: ts.ObjectLiteralExpression): string[] {
  if (!prop(n, HANDLER_PROP) && !prop(n, /^href$/)) return [];
  const out: string[] = [];
  // `label: isActive ? "Pause route" : "Activate route"`: each branch is a possible text.
  const texts = (e: ts.Expression | undefined) => {
    if (!e) return;
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) out.push(e.text);
    else if (ts.isConditionalExpression(e)) { texts(e.whenTrue); texts(e.whenFalse); }
    else if (ts.isParenthesizedExpression(e)) texts(e.expression);
  };
  texts(prop(n, LABEL_PROP));
  return out;
}

/**
 * The element a click on `label` lands on, in the nearest component that shows those words.
 * Like the test's own click: the exact words (case too) first, then any case, then part of the words.
 */
function findElement(files: ts.SourceFile[], label: string): Clickable | undefined {
  const tidy = (s: string) => s.replace(/\s+/g, ' ').trim();
  const passes: ((wd: string) => boolean)[] = [
    (wd) => tidy(wd) === tidy(label),
    (wd) => norm(wd) === norm(label),
    (wd) => norm(wd).includes(norm(label)),
  ];
  for (const matches of passes) {
    for (const sf of files) {
      let found: Clickable | undefined;
      const visit = (n: ts.Node) => {
        if (found) return;
        if (ts.isObjectLiteralExpression(n)) {
          if (menuItemWords(n).some(matches)) { found = n; return; }
        }
        if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
          const hit = wordsOf(n).some(matches);
          if (hit) {
            // The words may sit in a <span> inside the button: climb to what is clickable.
            let cur: ts.Node | undefined = n;
            for (let i = 0; cur && i < 5; i++) {
              if ((ts.isJsxElement(cur) || ts.isJsxSelfClosingElement(cur)) &&
                (INTERACTIVE_TAG.test(tagOf(cur)) || attr(cur, 'onClick') || attr(cur, 'href'))) {
                found = cur;
                return;
              }
              cur = cur.parent;
              while (cur && ts.isJsxOpeningElement(cur)) cur = cur.parent;
            }
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
      if (found) return found;
    }
  }
  return undefined;
}

/** The function an `onClick={…}` / `onSubmit={…}` runs. */
function handlerOf(p: TsProject, e: ts.Expression): ts.Node | undefined {
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return e;
  if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) {
    const d = declarationOf(p, e);
    if (!d || !isOwnFile(p, d.getSourceFile())) return undefined;
    if (ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d)) return d;
    if (ts.isVariableDeclaration(d) && d.initializer) {
      const init = d.initializer;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return d;
      // useCallback(fn, deps)
      if (ts.isCallExpression(init) && /useCallback$/.test(init.expression.getText()) && init.arguments[0]) return d;
    }
  }
  return undefined;
}

/**
 * A handler and the page's own functions it calls, one level deep (`handleFileChange` calls
 * `processImageFile(file)`): a stop in either keeps the page from going on.
 */
function withCalled(p: TsProject, h: ts.Node): ts.Node[] {
  const out = [h];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      const d = handlerOf(p, n.expression);
      if (d && !out.includes(d)) out.push(d);
    }
    ts.forEachChild(n, visit);
  };
  visit(h);
  return out;
}

const nameOfHandler = (h: ts.Node) =>
  (ts.isFunctionDeclaration(h) || ts.isVariableDeclaration(h) || ts.isMethodDeclaration(h)) && h.name && ts.isIdentifier(h.name) ? h.name.text : 'handler';

/** `if (cond) { toast.error('…'); return; }` inside a handler: the page stops there. */
function guards(p: TsProject, handler: ts.Node, w: Words): Rule[] {
  const out: Rule[] = [];
  const name = nameOfHandler(handler);
  const visit = (n: ts.Node) => {
    if (ts.isIfStatement(n)) {
      const then = n.thenStatement;
      const stmts = ts.isBlock(then) ? [...then.statements] : [then];
      // Only a stop: a message and state resets (`setIsProcessing(false)`) at most. A block that
      // does real work first (`onChange(result); return;`) is another way through, not a stop.
      const onlyStops = stmts.every((s) => ts.isReturnStatement(s) && (!s.expression || s.expression.kind === ts.SyntaxKind.FalseKeyword ||
        s.expression.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(s.expression) && s.expression.text === 'undefined')) ||
        (ts.isExpressionStatement(s) && ts.isCallExpression(s.expression) &&
          (NOTIFY.test(s.expression.expression.getText()) || /^(set[A-Z]\w*|\w+\.preventDefault|\w+\.stopPropagation|console\.\w+)$/.test(s.expression.expression.getText()))));
      if (stmts.some(ts.isReturnStatement) && onlyStops) {
        let messages: string[] | undefined;
        for (const s of stmts) {
          if (ts.isExpressionStatement(s) && ts.isCallExpression(s.expression) && NOTIFY.test(s.expression.expression.getText())) {
            messages = messageTexts(s.expression.arguments[0]);
          }
        }
        const when: Condition[] = [translate(p, n.expression, false, w)];
        let child: ts.Node = n;
        for (let up = n.parent; up && up !== handler; child = up, up = up.parent) {
          if (ts.isIfStatement(up)) when.unshift(translate(p, up.expression, child === up.elseStatement, w));
        }
        const [message, ...otherMessages] = messages ?? [];
        out.push({
          kind: 'ui-guard', side: 'frontend', in: name, when,
          ...(message ? { message } : {}), ...(otherMessages.length ? { otherMessages } : {}),
          id: `ui-guard:${name}:${when.map((c) => c.code).join(' && ')}`, source: where(p, n),
        });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(handler);
  return out;
}

/**
 * What the browser itself checks before a form is sent: `required`, `min`, `maxLength`, `type="email"`
 * on the form's inputs. The handler doesn't even run while one of them fails, so these come first.
 */
function htmlChecks(p: TsProject, form: ts.JsxElement): Rule[] {
  const out: Rule[] = [];
  const sf = form.getSourceFile();
  // <Label htmlFor="route-description">Route Description *</Label>: the words people see for a field.
  const labels = new Map<string, string>();
  const findLabels = (n: ts.Node) => {
    if (ts.isJsxElement(n)) {
      const forId = attr(n, 'htmlFor');
      if (forId && forId !== true && ts.isStringLiteral(forId)) {
        const text = n.children.filter(ts.isJsxText).map((c) => c.text).join(' ').replace(/[*:]/g, ' ').replace(/\s+/g, ' ').trim();
        if (text) labels.set(forId.text, text);
      }
    }
    ts.forEachChild(n, findLabels);
  };
  findLabels(sf);
  const literal = (v: ReturnType<typeof attr>) => {
    if (v === true) return true;
    if (!v) return undefined;
    if (ts.isStringLiteral(v)) return v.text;
    if (ts.isNumericLiteral(v)) return Number(v.text);
    if (v.kind === ts.SyntaxKind.TrueKeyword) return true;
    return undefined;
  };
  const visit = (n: ts.Node) => {
    if ((ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) && /^(input|textarea|select|Input|Textarea)$/.test(tagOf(n))) {
      const id = literal(attr(n, 'id'));
      const name = literal(attr(n, 'name'));
      const placeholder = literal(attr(n, 'placeholder'));
      const field = (typeof id === 'string' && labels.get(id)) || (typeof name === 'string' && name) || (typeof id === 'string' && id) ||
        (typeof placeholder === 'string' && placeholder) || undefined;
      if (field) {
        const add = (facts: Record<string, unknown>, facet: string) => out.push({
          kind: 'field', section: 'body', field, side: 'frontend', ...facts, id: `fe:html:${field}:${facet}`, source: where(p, n),
        } as Rule);
        if (literal(attr(n, 'required')) === true) add({ facet: 'required', required: true }, 'required');
        const type = literal(attr(n, 'type'));
        if (type === 'email' || type === 'url') add({ facet: 'format', format: type }, `format:${type}`);
        const numeric = type === 'number';
        for (const [a, facet] of [['min', 'min'], ['minLength', 'min'], ['max', 'max'], ['maxLength', 'max']] as const) {
          const v = literal(attr(n, a));
          const num = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined;
          if (num !== undefined) add({ facet, value: num, unit: a.endsWith('Length') ? 'characters' : numeric ? 'number' : 'number' }, `${facet}:${a}`);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(form);
  return out;
}

/** The component (function) an element is written in. */
function componentOf(n: ts.Node): ts.Node | undefined {
  let found: ts.Node | undefined;
  for (let up: ts.Node | undefined = n.parent; up; up = up.parent) {
    if (ts.isFunctionDeclaration(up) && up.name) found = up;
    else if (ts.isVariableDeclaration(up) && up.initializer && (ts.isArrowFunction(up.initializer) || ts.isFunctionExpression(up.initializer) || ts.isCallExpression(up.initializer))) found = up;
    // The outermost named function is the component (inner ones are callbacks).
  }
  return found;
}

/** `useForm({ resolver: zodResolver(schema) })` in a component: the schema the form checks first. */
function formSchema(component: ts.Node): ts.Expression | undefined {
  let schema: ts.Expression | undefined;
  const visit = (n: ts.Node) => {
    if (schema) return;
    if (ts.isCallExpression(n) && /Resolver$/.test(n.expression.getText()) && n.arguments[0]) {
      schema = n.arguments[0];
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(component);
  return schema;
}

export function actionRules(fe: Frontend, pageFile: string, label: string, w: Words = {}): ActionFound | undefined {
  const p = fe.ts;
  // The page's own folder first (its _components), then everything it imports: the same words in a
  // shared widget elsewhere (a "Sign In" link in the site header) must not win over the page's button.
  const dir = path.dirname(pageFile);
  const all = componentFiles(fe, pageFile);
  const inside = (sf: ts.SourceFile) => !path.relative(dir, sf.fileName).startsWith('..');
  const files = [...all.filter(inside), ...all.filter((sf) => !inside(sf))];
  const el = findElement(files, label);
  if (!el) return undefined;
  const rules: Rule[] = [];
  const deps: ts.Node[] = [];
  const component = componentOf(el);
  if (component) deps.push(component);

  const isItem = ts.isObjectLiteralExpression(el);
  const disabled = isItem ? prop(el, /^disabled$/) : attr(el, 'disabled');
  if (disabled && disabled !== true && !ts.isStringLiteral(disabled) && disabled.kind !== ts.SyntaxKind.FalseKeyword) {
    rules.push({ kind: 'ui-block', side: 'frontend', element: label, when: translate(p, disabled, false, w), id: `ui-block:${label}`, source: where(p, el) });
  }

  const onClick = isItem ? prop(el, HANDLER_PROP) : attr(el, 'onClick');
  if (onClick && onClick !== true && !ts.isStringLiteral(onClick)) {
    const h = ts.isMethodDeclaration(onClick) ? onClick : handlerOf(p, onClick);
    if (h) for (const f of withCalled(p, h)) { deps.push(f); rules.push(...guards(p, f, w)); }
  }

  // A submit button runs its form's onSubmit (and, with react-hook-form, the form's schema first).
  const type = isItem ? undefined : attr(el, 'type');
  const isSubmit = !isItem && ((type && type !== true && ts.isStringLiteral(type) && type.text === 'submit') || (!type && /^button$/i.test(tagOf(el))));
  if (isSubmit) {
    for (let up: ts.Node | undefined = el.parent; up; up = up.parent) {
      if ((ts.isJsxElement(up) || ts.isJsxSelfClosingElement(up)) && /^form$/i.test(tagOf(up))) {
        // The browser's own checks run first (unless the form says noValidate).
        if (ts.isJsxElement(up) && !attr(up, 'noValidate')) rules.push(...htmlChecks(p, up));
        let onSubmit = attr(up, 'onSubmit');
        if (onSubmit && onSubmit !== true && !ts.isStringLiteral(onSubmit)) {
          // form.handleSubmit(onSubmit): the form's validation runs, then onSubmit.
          if (ts.isCallExpression(onSubmit) && /handleSubmit$/.test(onSubmit.expression.getText()) && onSubmit.arguments[0]) {
            const schema = component && formSchema(component);
            const fromSchema = schema ? schemaRules(p, schema, w) : undefined;
            if (fromSchema) {
              rules.push(...fromSchema.map((r) => ({ ...r, side: 'frontend' as const, id: `fe:${r.id}` })));
              const sd = declarationOf(p, schema!);
              if (sd) deps.push(sd);
            }
            onSubmit = onSubmit.arguments[0];
          }
          const h = handlerOf(p, onSubmit);
          if (h) for (const f of withCalled(p, h)) { deps.push(f); rules.push(...guards(p, f, w)); }
        }
        break;
      }
    }
  }

  const at = where(p, el);
  return {
    element: { ...at, tag: isItem ? 'menu item' : tagOf(el) },
    component: component ? refOf(p, component).name : '(page)',
    rules,
    functions: [...new Set(deps)].map((d) => refOf(p, d)),
  };
}

type Jsx = ts.JsxElement | ts.JsxSelfClosingElement;
const isJsx = (n: ts.Node): n is Jsx => ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n);

/** The words around a field: its text, and words given to it (`<RouteImageUploader label="Route Cover Photo *">`). */
function fieldWords(el: Jsx): string[] {
  const out = wordsOf(el);
  for (const name of ['label', 'title', 'aria-label', 'placeholder']) {
    const v = attr(el, name);
    if (v && v !== true && (ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v))) out.push(v.text);
  }
  return out;
}

const isFileInput = (n: ts.Node): n is Jsx => {
  if (!isJsx(n) || tagOf(n) !== 'input') return false;
  const t = attr(n, 'type');
  return !!t && t !== true && ts.isStringLiteral(t) && t.text === 'file';
};

function fileInputIn(n: ts.Node | undefined): Jsx | undefined {
  if (!n) return undefined;
  let found: Jsx | undefined;
  const visit = (x: ts.Node) => {
    if (found) return;
    if (isFileInput(x)) { found = x; return; }
    ts.forEachChild(x, visit);
  };
  visit(n);
  return found;
}

/** The function a `<RouteImageUploader>` tag draws, through `export const RouteImageUploader = VesselImageUploader`. */
function componentDecl(p: TsProject, el: Jsx): ts.Node | undefined {
  const tag = ts.isJsxElement(el) ? el.openingElement.tagName : el.tagName;
  if (!ts.isIdentifier(tag) || !/^[A-Z]/.test(tag.text)) return undefined;
  let d = declarationOf(p, tag);
  for (let i = 0; d && i < 3 && ts.isVariableDeclaration(d) && d.initializer && ts.isIdentifier(d.initializer); i++) d = declarationOf(p, d.initializer);
  return d && isOwnFile(p, d.getSourceFile()) ? d : undefined;
}

/**
 * For `upload "cover.jpg" to "Route Cover Photo"`: the file input next to those words, and its rules.
 * The input is looked for where the runtime finds it: inside the element with the words, inside the
 * component they are given to, or in the smallest block around them.
 */
export function uploadRules(fe: Frontend, pageFile: string, field: string, w: Words = {}): ActionFound | undefined {
  const p = fe.ts;
  const dir = path.dirname(pageFile);
  const all = componentFiles(fe, pageFile);
  const inside = (sf: ts.SourceFile) => !path.relative(dir, sf.fileName).startsWith('..');
  const files = [...all.filter(inside), ...all.filter((sf) => !inside(sf))];
  const bare = (s: string) => norm(s).replace(/[\s*:]+$/, '');
  const passes: ((wd: string) => boolean)[] = [
    (wd) => bare(wd) === bare(field),
    (wd) => bare(wd).startsWith(bare(field)),
  ];
  let host: Jsx | undefined;
  let input: Jsx | undefined;
  for (const matches of passes) {
    for (const sf of files) {
      const visit = (n: ts.Node) => {
        if (input) return;
        if (isJsx(n) && fieldWords(n).some(matches)) {
          const comp = componentDecl(p, n);
          let found = fileInputIn(n) ?? fileInputIn(comp);
          // <Label>Photo</Label> <input type="file" />: the block around both.
          for (let up: ts.Node | undefined = n.parent, i = 0; !found && up && i < 6; up = up.parent, i++) if (isJsx(up)) found = fileInputIn(up);
          if (found) { host = n; input = found; return; }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
      if (input) break;
    }
    if (input) break;
  }
  if (!host || !input) return undefined;

  const rules: Rule[] = [];
  const deps: ts.Node[] = [];
  const hostComponent = componentOf(host);
  if (hostComponent) deps.push(hostComponent);
  const inputComponent = componentOf(input);
  if (inputComponent && inputComponent !== hostComponent) deps.push(inputComponent);

  const accept = attr(input, 'accept');
  if (accept && accept !== true && ts.isStringLiteral(accept)) {
    const kinds = accept.text.split(',').map((x) => x.trim()).filter(Boolean);
    if (kinds.length) {
      const multiple = !!attr(input, 'multiple');
      rules.push({ kind: 'ui-file', side: 'frontend', field, accept: kinds, ...(multiple ? { multiple } : {}), id: `ui-file:${field}`, source: where(p, input) });
    }
  }
  const onChange = attr(input, 'onChange');
  if (onChange && onChange !== true && !ts.isStringLiteral(onChange)) {
    const h = handlerOf(p, onChange);
    if (h) for (const f of withCalled(p, h)) { deps.push(f); rules.push(...guards(p, f, w)); }
  }
  return {
    element: { ...where(p, input), tag: 'file input' },
    component: inputComponent ? refOf(p, inputComponent).name : '(page)',
    rules,
    functions: [...new Set(deps)].map((d) => refOf(p, d)),
  };
}
