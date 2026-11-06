// The frontend's code for a page the test was on: Next.js App Router pages, and every component
// they import from the app's own code. Read only, never run.

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { Project } from '../../compiler/project.mts';
import { isOwnFile, openTsProject, type TsProject } from '../ts-project.mts';

interface Page { file: string; re: RegExp; dynamic: number }
export interface Frontend { ts: TsProject; pages: Page[] }

export function openFrontend(project: Project): Frontend | undefined {
  const dir = project.config.source?.frontend;
  if (!dir) return undefined;
  const p = openTsProject(path.resolve(project.root, dir));
  const appDir = ['src/app', 'app'].map((d) => path.join(p.root, d)).find((d) => fs.existsSync(d));
  return { ts: p, pages: appDir ? pagesIn(appDir) : [] };
}

/**
 * `app/(group)/book/[tripId]/review/page.tsx` → /book/<anything>/review. Groups `(x)` and slots `@x`
 * are not in the address; `[...x]` takes the rest of it.
 */
function pagesIn(appDir: string): Page[] {
  const out: Page[] = [];
  const walk = (dir: string, segs: string[]) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith('_') || e.name === 'api' || e.name === 'node_modules') continue;
        walk(full, [...segs, e.name]);
      } else if (/^page\.(tsx|jsx|ts|js)$/.test(e.name)) {
        let src = '';
        let dynamic = 0;
        for (const s of segs) {
          if (/^\(.*\)$/.test(s) || s.startsWith('@')) continue;
          if (/^\[\[\.\.\..+\]\]$/.test(s)) { src += '(?:/.*)?'; dynamic += 2; }
          else if (/^\[\.\.\..+\]$/.test(s)) { src += '/.+'; dynamic += 2; }
          else if (/^\[.+\]$/.test(s)) { src += '/[^/]+'; dynamic++; }
          else src += `/${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
        }
        out.push({ file: full, re: new RegExp(`^${src || ''}/?$`, 'i'), dynamic });
      }
    }
  };
  walk(appDir, []);
  // A fixed address wins over one with [params], as in Next itself.
  return out.sort((a, b) => a.dynamic - b.dynamic);
}

export function pageFor(fe: Frontend, pathname: string): string | undefined {
  return fe.pages.find((pg) => pg.re.test(pathname))?.file;
}

/**
 * The page file and every file of the app's own code it imports, nearest first (breadth first),
 * so a label found in the page's own components wins over the same words somewhere else.
 */
export function componentFiles(fe: Frontend, pageFile: string, maxFiles = 400): ts.SourceFile[] {
  const p = fe.ts;
  const start = p.program.getSourceFile(pageFile);
  if (!start) return [];
  const seen = new Set<ts.SourceFile>([start]);
  const queue = [start];
  for (let i = 0; i < queue.length && seen.size < maxFiles; i++) {
    const sf = queue[i];
    for (const st of sf.statements) {
      const spec = (ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) ? st.moduleSpecifier : undefined;
      if (!spec || !ts.isStringLiteral(spec)) continue;
      if (ts.isImportDeclaration(st) && st.importClause?.isTypeOnly) continue;
      const sym = p.checker.getSymbolAtLocation(spec);
      const target = sym?.declarations?.find(ts.isSourceFile);
      if (!target || seen.has(target) || !isOwnFile(p, target)) continue;
      seen.add(target);
      queue.push(target);
    }
  }
  return queue;
}
