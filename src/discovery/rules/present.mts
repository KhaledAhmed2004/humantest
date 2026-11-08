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
  /** How the test checks it: it sees the message, or it checks the status the request answered. */
  checkedBy?: 'message' | 'status';
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
      // Who may: a wrong role is told 403, someone not logged in 401.
      ...(r.kind === 'access' && r.login === 'required' ? { status: r.roles.length && !r.allRoles ? 403 : 401 } : {}),
    });
    // Rules in the page's own code: what happens before anything reaches the server.
    const front = r.side === 'frontend';
    if (r.kind === 'access') access.push(line(renderRule(r)));
    else if (r.kind === 'reject') refuse.push(line(renderRule(r)));
    else if (r.kind === 'effect' || r.kind === 'together') changes.push(line(renderRule(r)));
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
    // What happens together, after the changes it is about.
    { title: 'What it changes', lines: [...changes.filter((l) => !l.ids[0].startsWith('together:')), ...changes.filter((l) => l.ids[0].startsWith('together:'))] },
    { title: 'The answer when all is well', lines: reply },
  ].filter((g) => g.lines.length);
}

/**
 * Marks lines the test checks: it looks for their message (`should see "…"`), or it checks the
 * status this request answered (`backend should reply 409`) and only one rule of the request gives
 * that status. A status shared by several rules says nothing about which one it was, so none of them
 * counts; except a 401 or 403, which is the "who can do it" rule's when the request has one.
 */
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether a text the test looks for (`should see "…"`, lower case) shows this message: the whole
 * message ("{…}" placeholders stand for any text), or most of it. A few words of it are not enough:
 * `should see "Fleet"` is a heading, not "Fleet retrieved successfully".
 */
export function seesMessage(message: string, seen: string): boolean {
  const m = message.toLowerCase().trim();
  const whole = new RegExp(escape(m).replace(/\\\{[^}]*\\\}/g, '.*'));
  if (whole.test(seen)) return true;
  // Part of it: two or more whole words of the message, at least half of them (placeholders left
  // out). One word alone is more likely a heading or a name on the page.
  const words = (s: string) => s.split(/[^\p{L}\p{N}']+/u).filter(Boolean).length;
  const part = seen.replace(/[\s.!:,"]+$/g, '');
  const n = words(part);
  return n >= 2 && n * 2 >= words(m.replace(/\{[^}]*\}/g, ' ')) && new RegExp(`(^|\\W)${escape(part)}(\\W|$)`).test(m);
}

export function markChecked(groups: Group[], seen: string[], statuses: number[] = []) {
  const texts = seen.map((s) => s.toLowerCase()).filter((s) => s.length >= 4);
  const lines = groups.flatMap((g) => g.lines.map((l) => ({ l, access: g.title === 'Who can do it' })));
  const byStatus = new Set<Line>();
  for (const st of new Set(statuses)) {
    const same = lines.filter((x) => x.l.status === st);
    const access = same.filter((x) => x.access);
    for (const x of access.length ? access : same.length === 1 ? same : []) byStatus.add(x.l);
  }
  for (const { l } of lines) {
    const bySeen = l.messages.some((m) => texts.some((t) => seesMessage(m, t)));
    l.checked = bySeen || byStatus.has(l);
    if (l.checked) l.checkedBy = bySeen ? 'message' : 'status';
    else delete l.checkedBy;
  }
}
