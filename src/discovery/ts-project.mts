// Opens an app's own TypeScript code with the compiler API, and answers "where is this defined?".
// Nothing here runs the app's code; it is only read.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export interface TsProject {
  /** The folder with the app's tsconfig.json. File paths in results are relative to it. */
  root: string;
  program: ts.Program;
  checker: ts.TypeChecker;
}

/** What a piece of the slice is, guessed from where it lives. */
export type Role = 'route' | 'middleware' | 'validation' | 'controller' | 'service' | 'shared' | 'helper';

/** A function, schema or constant in the app's own code. */
export interface CodeRef {
  name: string;
  /** Relative to the project root, with forward slashes. */
  file: string;
  line: number;
  role: Role;
  /** sha1 of its code without comments or formatting. Changes only when the code does. */
  hash: string;
}

export function openTsProject(dir: string): TsProject {
  const root = path.resolve(dir);
  const configFile = path.join(root, 'tsconfig.json');
  if (!fs.existsSync(configFile)) throw new Error(`No tsconfig.json in ${root}. Check "source" in humantest.config.json.`);
  const read = ts.readConfigFile(configFile, ts.sys.readFile);
  if (read.error) throw new Error(`Can't read ${configFile}: ${ts.flattenDiagnosticMessageText(read.error.messageText, '\n')}`);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root);
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: { ...parsed.options, noEmit: true } });
  return { root, program, checker: program.getTypeChecker() };
}

const posix = (p: string) => p.split(path.sep).join('/');

/** The app's own code: inside the project, not a dependency, not a .d.ts file. */
export function isOwnFile(p: TsProject, sf: ts.SourceFile): boolean {
  if (sf.isDeclarationFile) return false;
  const rel = path.relative(p.root, sf.fileName);
  return !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.split(/[\\/]/).includes('node_modules');
}

export function where(p: TsProject, node: ts.Node): { file: string; line: number } {
  const sf = node.getSourceFile();
  return { file: posix(path.relative(p.root, sf.fileName)), line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 };
}

const isJsDoc = (n: ts.Node) => n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode;

/**
 * Built from the code's tokens only, so what a formatter changes never changes it: comments and
 * whitespace (not tokens), a statement's final `;`, a trailing comma, and 'single' vs "double" quotes.
 * (Printing the node instead would keep comments: the printer copies them from the source.)
 */
export function hashOf(node: ts.Node): string {
  const sf = node.getSourceFile();
  const tokens: string[] = [];
  const walk = (n: ts.Node, last: boolean, inList: boolean) => {
    if (isJsDoc(n)) return;
    const kids = n.getChildren(sf);
    if (kids.length) {
      const list = n.kind === ts.SyntaxKind.SyntaxList;
      kids.forEach((k, i) => walk(k, i === kids.length - 1, list));
      return;
    }
    if (n.kind === ts.SyntaxKind.EndOfFileToken) return;
    if (last && n.kind === ts.SyntaxKind.SemicolonToken && !inList) return;
    if (last && n.kind === ts.SyntaxKind.CommaToken && inList) return;
    tokens.push(ts.isStringLiteral(n) ? JSON.stringify(n.text) : n.getText(sf));
  };
  walk(node, false, false);
  return crypto.createHash('sha1').update(tokens.join('\u0000')).digest('hex').slice(0, 12);
}

export function roleOf(file: string): Role {
  if (/\.routes?\.[cm]?ts$/.test(file)) return 'route';
  if (/\.controller\.[cm]?ts$/.test(file)) return 'controller';
  if (/\.service\.[cm]?ts$/.test(file)) return 'service';
  if (/\.validation\.[cm]?ts$/.test(file) || /(^|\/)(schemas?|validations?)\//.test(file)) return 'validation';
  if (/(^|\/)middlewares?\//.test(file)) return 'middleware';
  if (/(^|\/)(shared|errors|config|lib)\//.test(file)) return 'shared';
  return 'helper';
}

/** A readable name: `createRoute`, `RouteService.createRoute`'s target, `ApiError`. */
export function nameOf(decl: ts.Node): string {
  if ((ts.isFunctionDeclaration(decl) || ts.isClassDeclaration(decl)) && decl.name) return decl.name.text;
  if (ts.isMethodDeclaration(decl) && ts.isIdentifier(decl.name)) {
    const cls = decl.parent;
    return ts.isClassLike(cls) && cls.name ? `${cls.name.text}.${decl.name.text}` : decl.name.text;
  }
  if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) return decl.name.text;
  if (ts.isEnumMember(decl)) return `${decl.parent.name.text}.${decl.name.getText()}`;
  if (ts.isExportAssignment(decl)) return 'default';
  if (ts.isArrowFunction(decl) || ts.isFunctionExpression(decl)) return 'function written in the route';
  return decl.getText().slice(0, 40);
}

export function refOf(p: TsProject, decl: ts.Node): CodeRef {
  const at = where(p, decl);
  return { name: nameOf(decl), ...at, role: roleOf(at.file), hash: hashOf(decl) };
}

/** Declarations that make up the app's logic: functions, methods, classes and top-level variables. */
export function isCodeDeclaration(decl: ts.Node): boolean {
  if (ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl) || ts.isClassDeclaration(decl)) return true;
  // Top-level `const x = …` only: locals are part of the function they're in.
  return ts.isVariableDeclaration(decl) && ts.isVariableDeclarationList(decl.parent) && ts.isVariableStatement(decl.parent.parent) &&
    ts.isSourceFile(decl.parent.parent.parent);
}

/**
 * Where an expression is really defined, following imports and re-exports, `export const A = b`,
 * `export default router`, and object maps like `export const XService = { createX }`.
 */
export function declarationOf(p: TsProject, expr: ts.Node, depth = 0): ts.Node | undefined {
  if (depth > 12) return undefined;
  let target: ts.Node = expr;
  while (ts.isParenthesizedExpression(target) || ts.isAsExpression(target) || ts.isNonNullExpression(target)) target = target.expression;
  const at = ts.isPropertyAccessExpression(target) ? target.name : target;
  let sym = p.checker.getSymbolAtLocation(at);
  if (!sym) return undefined;
  return declarationOfSymbol(p, sym, depth);
}

function declarationOfSymbol(p: TsProject, symbol: ts.Symbol, depth: number): ts.Node | undefined {
  let sym = symbol;
  if (sym.flags & ts.SymbolFlags.Alias) sym = p.checker.getAliasedSymbol(sym);
  const decl = sym.valueDeclaration ?? sym.declarations?.[0];
  if (!decl) return undefined;
  if (ts.isShorthandPropertyAssignment(decl)) {
    const value = p.checker.getShorthandAssignmentValueSymbol(decl);
    return value ? declarationOfSymbol(p, value, depth + 1) : decl;
  }
  if (ts.isPropertyAssignment(decl) && isReference(decl.initializer)) return declarationOf(p, decl.initializer, depth + 1) ?? decl;
  if (ts.isExportAssignment(decl) && isReference(decl.expression)) return declarationOf(p, decl.expression, depth + 1) ?? decl;
  if (ts.isVariableDeclaration(decl) && decl.initializer && isReference(decl.initializer)) {
    return declarationOf(p, decl.initializer, depth + 1) ?? decl;
  }
  return decl;
}

const isReference = (e: ts.Node) => ts.isIdentifier(e) || ts.isPropertyAccessExpression(e);

/** Literal text of a string, or of a `const` that holds one. */
export function stringValue(p: TsProject, e: ts.Node | undefined): string | undefined {
  if (!e) return undefined;
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (ts.isIdentifier(e)) {
    const d = declarationOf(p, e);
    if (d && ts.isVariableDeclaration(d) && d.initializer && (ts.isStringLiteral(d.initializer) || ts.isNoSubstitutionTemplateLiteral(d.initializer))) {
      return d.initializer.text;
    }
  }
  return undefined;
}

export const shortText = (node: ts.Node, max = 80) => {
  const t = node.getText().replace(/\s+/g, ' ');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
