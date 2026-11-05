// Phrases: your own story sentences, defined in plain HumanTest sentences (no code).
//
//   Phrase: <user> signs up with "<email>"
//     As <user>:
//       go to signup page
//       type "<email>" in email
//       click "Sign up"
//
// <name> is a placeholder. (text) is optional text, e.g.  admin should see <n> user(s)

import fs from 'node:fs';
import path from 'node:path';
import { rel, type Project } from './project.mts';

export interface PhraseLine { text: string; line: number }
export interface Phrase { header: string; file: string; line: number; params: string[]; re: RegExp; body: PhraseLine[] }
export interface PhraseProblem { file: string; line: number; text: string; message: string; hint?: string }

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const stripThe = (s: string) => s.replace(/^the\s+/i, '');

export function stripComment(line: string): string {
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') inQuote = !inQuote;
    else if (line[i] === '#' && !inQuote) return line.slice(0, i);
  }
  return line;
}

function compileHeader(header: string): { re: RegExp; params: string[] } {
  const params: string[] = [];
  let src = '';
  for (const part of stripThe(header).split(/(<[^>]+>|\([^)]*\))/)) {
    if (!part) continue;
    if (part.startsWith('<')) {
      params.push(part.slice(1, -1).trim().toLowerCase());
      src += '(.+?)';
    } else if (part.startsWith('(')) {
      src += `(?:${escape(part.slice(1, -1)).replace(/\s+/g, '\\s+')})?`;
    } else {
      src += escape(part).replace(/\s+/g, '\\s+');
    }
  }
  return { re: new RegExp(`^${src}$`, 'i'), params };
}

export function loadPhrases(project: Project): { phrases: Phrase[]; problems: PhraseProblem[] } {
  const phrases: Phrase[] = [];
  const problems: PhraseProblem[] = [];
  const dir = project.phrasesDir;
  if (!fs.existsSync(dir)) return { phrases, problems };

  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.ht')).sort()) {
    const file = path.join(dir, name);
    const relFile = rel(project, file);
    let current: Phrase | undefined;
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((raw, i) => {
      const text = stripComment(raw).trim();
      if (!text) return;
      const m = text.match(/^phrase\s*:\s*(.+)$/i);
      if (m) {
        const header = m[1].trim();
        current = { header, file: relFile, line: i + 1, body: [], ...compileHeader(header) };
        phrases.push(current);
        return;
      }
      if (!current) {
        problems.push({ file: relFile, line: i + 1, text, message: 'This line is outside of a phrase.', hint: 'Start each phrase with a line like:  Phrase: <user> signs up with "<email>"' });
        return;
      }
      current.body.push({ text, line: i + 1 });
    });
  }

  for (const p of phrases) {
    if (!p.body.length) problems.push({ file: p.file, line: p.line, text: `Phrase: ${p.header}`, message: 'This phrase has no steps.' });
  }
  return { phrases, problems };
}

/** If `text` is one of the phrases, return its body with the placeholders filled in. */
export function expandPhrase(phrases: Phrase[], text: string): { phrase: Phrase; lines: PhraseLine[] } | undefined {
  const t = stripThe(text.replace(/\s+/g, ' ').replace(/\.$/, '').trim());
  for (const phrase of phrases) {
    const m = t.match(phrase.re);
    if (!m) continue;
    const values = new Map(phrase.params.map((p, i) => [p, m[i + 1].trim()]));
    const lines = phrase.body.map((l) => ({
      line: l.line,
      text: l.text.replace(/<([^>]+)>/g, (all, key) => values.get(String(key).trim().toLowerCase()) ?? all),
    }));
    return { phrase, lines };
  }
  return undefined;
}
