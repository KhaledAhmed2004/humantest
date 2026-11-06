// Rules into plain English. Everything people read about a rule is made here, from its facts.

import type { CheckRule, Condition, EffectRule, FieldRule, RejectRule, Rule, RulePath, WrittenField } from './types.mts';

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
/** `afterAnd`: the conditions follow another one ("… fails, and (a, or b)"), so an "or" needs brackets. */
const allOf = (cs: Condition[], afterAnd = false) => cs.map((c) => {
  const t = condition(c);
  return (cs.length > 1 || afterAnd) && c.text && c.text.includes(', or ') && !(t.startsWith('(') && t.endsWith(')')) ? `(${t})` : t;
}).join(', and ');
const list = (xs: string[], word = 'or') => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} ${word} ${xs.at(-1)}`);

/** Whether every condition in the rule could be put into words. */
export function isTranslated(r: Rule): boolean {
  if (r.kind === 'effect' || r.kind === 'reply') return [...(r.path?.when ?? []), ...r.when].every((c) => c.text !== undefined);
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
    case 'effect':
      return renderEffect(r);
    case 'reply': {
      const others = r.otherMessages?.length ? ` (or${r.otherMessages.map(quote).join(', or')})` : '';
      const answer = `the server answers ${statusText(r.status)}${r.message ? `:${quote(r.message)}${others}` : ''}`;
      const lead = leadOf(r.path, r.when);
      return lead ? `${lead}${answer}.` : `When nothing stops it, ${answer}.`;
    }
    case 'ui-file': {
      // image/png → PNG, .pdf → PDF, image/* → any image
      const kinds = [...new Set(r.accept.map((a) => (a.endsWith('/*') ? `any ${a.slice(0, -2)}` : (a.split('/').pop() ?? a).replace(/^\./, '').toUpperCase())))];
      return `"${r.field}" takes ${r.multiple ? 'files' : 'one file'}: the file picker offers only ${list(kinds)}.`;
    }
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

const plural = (s: string) => (/[^aeiou]y$/.test(s) ? `${s.slice(0, -1)}ies` : /(s|x|ch|sh)$/.test(s) ? `${s}es` : `${s}s`);

function writtenField(f: WrittenField, saySent = true): string {
  if (f.fallback) return `${f.name}: ${f.value} unless given`;
  const what = f.how === 'increment' ? `${f.name} goes up by ${f.value ?? 'some'}`
    : f.how === 'decrement' ? `${f.name} goes down by ${f.value ?? 'some'}`
    : f.value !== undefined ? `${f.name} becomes ${f.value}` : `${f.name} is set`;
  return f.optional && saySent ? `${what} (only when given)` : what;
}

function renderEffect(r: EffectRule): string {
  const m = r.model ?? 'record';
  let what: string;
  switch (r.effect) {
    case 'create': {
      // For a new record, only the fields with a fixed value or fallback say something.
      const fixed = (r.fields ?? []).filter((f) => f.value !== undefined).map((f) => writtenField(f));
      what = `${r.many ? `new ${plural(m)} are` : `a new ${m} is`} saved${fixed.length ? ` (${fixed.join('; ')})` : ''}`;
      break;
    }
    case 'update': {
      // Said once when every field is written only when given.
      const all = !!r.fields?.length && r.fields.every((f) => f.optional);
      const fields = (r.fields ?? []).map((f) => writtenField(f, !all));
      what = `${r.many ? `the matching ${plural(m)} are` : `the ${m} is`} changed${fields.length ? `: ${fields.join(all ? ', ' : '; ')}${all ? ' (each only when given)' : ''}` : ''}`;
      break;
    }
    case 'delete':
      what = r.many ? `the matching ${plural(m)} are deleted` : `the ${m} is deleted`;
      break;
    case 'email':
      what = `an email${r.what ? ` "${r.what}"` : ''} is sent`;
      break;
    case 'notify':
      what = `a live notification${r.what ? ` "${r.what}"` : ''} is sent`;
      break;
    case 'payment': {
      // refunds.create → "Stripe is asked to create a refund"
      const [res, verb] = (r.what ?? 'payment.change').split('.');
      const thing = res.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/s$/, '');
      what = `Stripe is asked to ${verb === 'del' ? 'delete' : verb} a ${thing}`;
      break;
    }
  }
  const lead = leadOf(r.path, r.onError ? [FAILED, ...r.when] : r.when);
  const text = lead ? `${lead}${what}` : `${what[0].toUpperCase()}${what.slice(1)}`;
  return `${text}.${r.bestEffort ? ' If that fails, the request still goes on.' : ''}`;
}

/**
 * "If a, and b, " with the conditions on the way to a called function first. Past four, the last
 * three (the closest to what happens, so the most telling) are said and the others counted: all
 * of them stay in the rule's data, and its code is one click away.
 */
function leadOf(path: RulePath | undefined, when: Condition[]): string {
  const all = [...(path?.when ?? []), ...when];
  if (all.length <= 4) return all.length ? `If ${allOf(all)}, ` : '';
  const shown = all.slice(-3);
  return `After ${all.length - 3} earlier checks (the first: ${condition(all[0])}${path ? `; on the way to ${path.through}` : ''}), if ${allOf(shown)}, `;
}

/** A catch block, as a condition: it happens when the code before it fails. */
const FAILED: Condition = { code: '(catch)', text: 'the work before it fails' };

function renderReject(r: RejectRule): string {
  const others = r.otherMessages?.length ? ` (or${r.otherMessages.map(quote).join(', or')})` : '';
  const answer = `the server answers ${statusText(r.status)}${r.message ? `:${quote(r.message)}${others}` : ''}`;
  if (r.onError) return `If the work before it fails${r.when.length ? `, and ${allOf(r.when, true)}` : ''}, ${answer}.`;
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
