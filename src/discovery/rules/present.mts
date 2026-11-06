// Rules grouped the way people read them, for the command line and the UI.
// Facts about one field become one sentence; everything keeps where it is in the code.

import { isTranslated, renderField, renderRule } from './render.mts';
import type { FieldRule, Rule, Source } from './types.mts';

export interface Line {
  text: string;
  source: Source;
  /** False when a condition is shown as code because it could not be put into words. */
  translated: boolean;
  /** The app's own messages in these rules, used to see whether a test checks them. */
  messages: string[];
  status?: number;
  ids: string[];
  /** Set by the caller when a step of the test checks this line (sees its message). */
  checked?: boolean;
}

export interface Group { title: string; lines: Line[] }

export function present(rules: Rule[]): Group[] {
  const page: Line[] = [];
  const access: Line[] = [];
  const contain: Line[] = [];
  const refuse: Line[] = [];
  const changes: Line[] = [];
  const reply: Line[] = [];

  const fieldKey = (r: FieldRule & Rule) => `${r.side ?? 'backend'}:${r.section}.${r.field}`;
  const fields = new Map<string, FieldRule[]>();
  for (const r of rules) {
    if (r.kind === 'field') {
      const key = fieldKey(r as FieldRule & Rule);
      fields.set(key, [...(fields.get(key) ?? []), r as FieldRule & Rule]);
    }
  }
  const fieldsDone = new Set<string>();

  for (const r of rules) {
    const line = (text: string): Line => ({
      text, source: r.source, translated: isTranslated(r), ids: [r.id],
      messages: [...('message' in r && r.message ? [r.message] : []), ...((r.kind === 'reject' || r.kind === 'ui-guard' || r.kind === 'reply') ? r.otherMessages ?? [] : [])],
      ...((r.kind === 'reject' || r.kind === 'reply') && r.status !== undefined ? { status: r.status } : {}),
    });
    // Rules in the page's own code: what happens before anything reaches the server.
    const front = r.side === 'frontend';
    if (r.kind === 'access') access.push(line(renderRule(r)));
    else if (r.kind === 'reject') refuse.push(line(renderRule(r)));
    else if (r.kind === 'effect') changes.push(line(renderRule(r)));
    else if (r.kind === 'reply') reply.push(line(renderRule(r)));
    else if (r.kind === 'ui-block' || r.kind === 'ui-guard' || r.kind === 'ui-file') page.push(line(renderRule(r)));
    else if (r.kind === 'check') (front ? page : contain).push(line(renderRule(r)));
    else if (r.kind === 'field') {
      const key = fieldKey(r as FieldRule & Rule);
      if (fieldsDone.has(key)) continue;
      fieldsDone.add(key);
      const facts = fields.get(key)!;
      const where = front || r.section === 'body' ? '' : ` (in the ${r.section === 'query' ? 'address query' : r.section})`;
      (front ? page : contain).push({
        text: renderField(facts).replace(/\.$/, `${where}.`), source: r.source, translated: true,
        ids: facts.map((f) => (f as FieldRule & Rule).id),
        messages: [...new Set(facts.flatMap((f) => (f.message ? [f.message] : [])))],
      });
    }
  }
  // Field by field first, then the checks that span fields.
  const isCheck = (l: Line) => l.ids.some((id) => id.startsWith('check:'));
  return [
    { title: 'On the page, before anything is sent', lines: [...page.filter((l) => !isCheck(l)), ...page.filter(isCheck)] },
    { title: 'Who can do it', lines: access },
    { title: 'What the request must contain', lines: [...contain.filter((l) => !isCheck(l)), ...contain.filter(isCheck)] },
    { title: 'When the server says no', lines: refuse },
    { title: 'What it changes', lines: changes },
    { title: 'The answer when all is well', lines: reply },
  ].filter((g) => g.lines.length);
}

/**
 * Marks lines whose message the test looks for (`should see "…"`). Only a message match counts:
 * a status alone (every refusal is some 400) would claim far more than the test checks.
 */
export function markChecked(groups: Group[], seen: string[]) {
  const texts = seen.map((s) => s.toLowerCase()).filter((s) => s.length >= 4);
  for (const g of groups) {
    for (const l of g.lines) {
      l.checked = l.messages.some((m) => {
        // "{…}" placeholders in a message stand for any text.
        const re = new RegExp(m.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{[^}]*\\\}/g, '.*'));
        return texts.some((t) => re.test(t) || m.toLowerCase().includes(t));
      });
    }
  }
}
