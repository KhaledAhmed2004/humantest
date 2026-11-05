import fs from 'node:fs';
import path from 'node:path';
import { parseFile, type ParsedFile, type Diagnostic } from './parser.mts';
import { generate } from './generator.mts';
import { loadPhrases } from './phrases.mts';
import { listTestFiles, type Project } from './project.mts';

export { loadProject, listTestFiles, rel } from './project.mts';
export { parseFile } from './parser.mts';
export { loadPhrases } from './phrases.mts';
export type { ParsedFile, Diagnostic } from './parser.mts';

export interface BuildResult { parsed: ParsedFile[]; diagnostics: Diagnostic[]; written: string[] }

export function check(project: Project, files = listTestFiles(project)): BuildResult {
  const loaded = loadPhrases(project);
  const parsed = files.map((f) => parseFile(project, f, loaded));
  // A phrase used by several tests could report the same problem several times.
  const seen = new Set<string>();
  const diagnostics = [...loaded.problems, ...parsed.flatMap((p) => p.diagnostics)].filter((d) => {
    const key = `${d.file}:${d.line}:${d.message}`;
    return !seen.has(key) && seen.add(key);
  });
  return { parsed, diagnostics, written: [] };
}

/** Parse every .ht file and, if there are no problems, write the Playwright specs. */
export function build(project: Project): BuildResult {
  const result = check(project);
  if (result.diagnostics.length) return result;

  fs.mkdirSync(project.outDir, { recursive: true });
  for (const old of fs.readdirSync(project.outDir)) {
    if (old.endsWith('.spec.ts')) fs.rmSync(path.join(project.outDir, old));
  }
  for (const p of result.parsed) {
    const relToTests = path.relative(project.testsDir, p.file).replace(/\.ht$/, '');
    const out = path.join(project.outDir, `${relToTests.replace(/[\\/]/g, '__')}.spec.ts`);
    fs.writeFileSync(out, generate(project, p));
    result.written.push(out);
  }
  return result;
}
