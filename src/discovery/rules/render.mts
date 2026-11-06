// Rules into plain English. Everything people read about a rule is made here, from its facts.

import type { CheckRule, Condition, FieldRule, RejectRule, Rule } from './types.mts';

export const STATUS_WORDS: Record<number, string> = {
  200: 'OK', 201: 'Created', 204: 'No Content', 400: 'Bad Request', 401: 'Not Logged In', 403: 'Forbidden',
  404: 'Not Found', 409: 'Conflict', 422: 'Invalid', 429: 'Too Many Requests', 500: 'Server Error', 502: 'Bad Gateway', 503: 'Unavailable',
};

export const statusText = (s?: number) => (s === undefined ? 'an error' : `${s}${STATUS_WORDS[s] ? ` ${STATUS_WORDS[s]}` : ''}`);
const FORMAT_WORDS: Record<string, string> = {
  email: 'must be a valid email address', uuid: 'must be a valid UUID', url: 'must be a valid URL',
  cuid: 'must be a valid id', cuid2: 'must be a valid id', ulid: 'must be a valid id',
  datetime: 'must be a valid date and time', date: 'must be a valid date', time: 'must be a valid time', ip: 'must be a valid IP address',
  regex: 'must match a set pattern', positive: 'must be more than 0', nonnegative: 'cannot be negative',
  negative: 'must be less than 0', nonpositive: 'cannot be more than 0', finite: 'must be a finite number',
  startsWith: 'must start with a set text', endsWith: 'must end with a set text', includes: 'must contain a set text',
};

const quote = (m?: string) => (m ? ` "${m}"` : '');
const condition = (c: Condition) => c.text ?? `\`${c.code}\``;
/**
 * Several conditions that all hold ("and"). One that is itself an "or" goes in brackets, so
 * "edit is false, and (port A is empty, or port B is empty)" can only be read one way.
 */
const allOf = (cs: Condition[]) => cs.map((c) => {
  const t = condition(c);
  return cs.length > 1 && c.text && c.text.includes(', or ') && !(t.startsWith('(') && t.endsWith(')')) ? `(${t})` : t;
}).join(', and ');
const list = (xs: string[], word = 'or') => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} ${word} ${xs.at(-1)}`);

/** Whether every condition in the rule could be put into words. */
export function isTranslated(r: Rule): boolean {
  if (r.kind === 'reject' || r.kind === 'ui-guard') return r.when.every((c) => c.text !== undefined);
  if (r.kind === 'check') return !r.when || r.when.text !== undefined;
  if (r.kind === 'ui-block') return r.when.text !== undefined;
  return true;
}

export function renderRule(r: Rule): string {
  switch (r.kind) {
    case 'access':
      if (r.login === 'optional') return 'Guests can do this too; a logged-in user is recognised.';
      if (r.allRoles || !r.roles.length) return 'Any logged-in user can do this.';
      return `Only ${list(r.roles)} can do this.`;
    case 'check':
      return renderCheck(r);
    case 'reject':
      return renderReject(r);
    case 'field':
      return `${r.field}: ${fieldFacet(r)}.`;
    case 'ui-block':
      return `"${r.element}" can't be used while ${condition(r.when)}.`;
    case 'ui-guard': {
      const others = r.otherMessages?.length ? ` (or${r.otherMessages.map(quote).join(', or')})` : '';
      const stop = r.message ? `the page stops and shows${quote(r.message)}${others}` : 'the page stops';
      return r.when.length ? `If ${allOf(r.when)}, ${stop}, before sending anything.` : `${stop[0].toUpperCase()}${stop.slice(1)}, before sending anything.`;
    }
  }
}

function renderCheck(r: CheckRule): string {
  const on = r.field ? ` (on ${r.field})` : '';
  if (r.when) return `If ${condition(r.when)}, the request is refused${on}${r.message ? `:${quote(r.message)}` : ''}.`;
  return `Custom check${on}:${quote(r.message) || ' (no message)'}.`;
}

function renderReject(r: RejectRule): string {
  const others = r.otherMessages?.length ? ` (or${r.otherMessages.map(quote).join(', or')})` : '';
  const answer = `the server answers ${statusText(r.status)}${r.message ? `:${quote(r.message)}${others}` : ''}`;
  if (r.onError) return `If the work before it fails, ${answer}.`;
  if (!r.when.length) return `Whenever ${r.in} runs this far, ${answer}.`;
  return `If ${allOf(r.when)}, ${answer}.`;
}

function fieldFacet(r: FieldRule): string {
  switch (r.facet) {
    case 'required':
      return r.required ? 'required' : `optional${r.default !== undefined ? ` (default ${r.default})` : ''}`;
    case 'type':
      return `${r.coerced ? 'read as ' : 'must be '}${r.type}`;
    case 'min':
      if (r.unit === 'characters') return r.value === 1 ? 'must not be empty' : `at least ${r.value} characters`;
      if (r.unit === 'items') return `at least ${r.value} item${r.value === 1 ? '' : 's'}`;
      return `at least ${r.value}`;
    case 'max':
      if (r.unit === 'characters') return `at most ${r.value} characters`;
      if (r.unit === 'items') return `at most ${r.value} items`;
      return `at most ${r.value}`;
    case 'length':
      return r.unit === 'characters' ? `exactly ${r.value} characters` : `exactly ${r.value} items`;
    case 'oneOf':
      return `one of ${list(r.values)}`;
    case 'format':
      return FORMAT_WORDS[r.format] ?? `must be a valid ${r.format}`;
    case 'nullable':
      return 'can be empty (null)';
  }
}

/**
 * All facts about one field in one sentence:
 * "durationMinutes is required, must be a whole number, at least 1, at most 1440."
 */
export function renderField(facts: FieldRule[]): string {
  const order = ['required', 'type', 'oneOf', 'format', 'length', 'min', 'max', 'nullable'];
  const sorted = [...facts].sort((a, b) => order.indexOf(a.facet) - order.indexOf(b.facet));
  const parts = sorted.map(fieldFacet);
  const head = parts[0]?.startsWith('required') || parts[0]?.startsWith('optional') ? `${facts[0].field} is ${parts.shift()}` : facts[0].field;
  return `${head}${parts.length ? `, ${parts.join(', ')}` : ''}.`;
}
