// A draft test for a rule no test checks, made from a test that reaches it. Read from the code and
// the test files; no AI. Used by the coverage report (gaps.mts) and by each test's own rules (index.mts).

import fs from 'node:fs';
import path from 'node:path';
import type { Project } from '../compiler/project.mts';
import type { GapLine, GapRequest, ReachedBy } from './gaps.mts';

/** A refusal or page stop with a message: a test can look for it, so a draft can be made. */
export const draftable = (l: GapLine) => !l.checked && l.messages.length > 0 && /says no|On the page/.test(l.group);

/**
 * A draft test for a rule no test checks: the lines of a test that reaches it, up to the step that
 * gets there, then what has to be true and what to see. It is a start, not a finished test: making
 * the condition true (another port, a full trip) is for whoever writes it.
 */
/** `unchecked`: who doesn't check the rule, for the header; by default no test at all. */
export function draftFor(project: Project, req: GapRequest, line: GapLine, unchecked = 'no test checks'): string | undefined {
  const message = line.messages[0];
  // A test that got through (2xx), else one that at least got past who may (not 401/403): one turned
  // away at the door never reaches the rules inside.
  const rank = (b: ReachedBy) => (b.status === undefined ? 1 : b.status < 300 ? 0 : b.status === 401 || b.status === 403 ? 3 : 2);
  const by = [...req.reachedBy].sort((a, b) => rank(a) - rank(b))[0];
  if (!message || !by) return undefined;
  const file = path.join(project.root, by.file);
  if (!fs.existsSync(file)) return undefined;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  // From the test's own header to the step that reached this request.
  const body = lines.slice(by.testLine, by.stepLine).filter((l) => !/^\s*#/.test(l));
  while (body.length && !body.at(-1)!.trim()) body.pop();
  const indent = body.at(-1)?.match(/^\s*/)?.[0] ?? '    ';
  // A message with {placeholders}: look for its longest fixed part.
  const seen = message.split(/\{[^}]*\}/).map((x) => x.trim()).sort((a, b) => b.length - a.length)[0] || message;
  const why = line.text.replace(/,? (the server answers|the page stops|the request is refused).*$/, '').replace(/^If /, '');
  const name = `${line.status ? `${line.status} ` : ''}${seen.replace(/[."]+$/, '')}`.slice(0, 70);
  return [
    `# Draft from "${by.test}" (${by.file}:${by.testLine}), for this rule ${unchecked}:`,
    `#   ${line.text}`,
    `#   ${req.root}/${line.source.file}:${line.source.line}`,
    `# Change the steps so that this is true before the last one: ${why}`,
    `# It is not run while it says "Draft:". When the steps are right, change that to "Test:".`,
    `Draft: ${name}`,
    ...body,
    `${indent}should see "${seen}"`,
  ].join('\n');
}
