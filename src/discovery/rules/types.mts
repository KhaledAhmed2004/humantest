// A business rule found in the app's code, as data. The English sentence is made from it later
// (render.mts), so comparing two versions of the code compares facts, not wording.

export interface Source { file: string; line: number }

/** A condition from the code, in English when it could be translated, and always as code too. */
export interface Condition {
  code: string;
  /** Missing when the condition uses something HumanTest can't put into words (it is then shown as code). */
  text?: string;
}

/** Who may make the request. */
export interface AccessRule {
  kind: 'access';
  /** Roles that may, e.g. ["ADMIN"]. Empty with login "required": any logged-in user. */
  roles: string[];
  login: 'required' | 'optional';
  /** Every role there is was listed, so it means "any logged-in user". */
  allRoles?: boolean;
  via: string;
}

export type FieldFacet =
  | { facet: 'required'; required: boolean; default?: string }
  | { facet: 'type'; type: string; coerced?: boolean }
  | { facet: 'min' | 'max' | 'length'; value: number; unit: 'characters' | 'items' | 'number' }
  | { facet: 'oneOf'; values: string[] }
  | { facet: 'format'; format: string }
  | { facet: 'nullable' };

/** One fact about one field of the request, e.g. "durationMinutes must be at most 1440". */
export type FieldRule = {
  kind: 'field';
  section: 'body' | 'query' | 'params' | 'cookies';
  field: string;
  /** The app's own error message for this fact, when it has one. */
  message?: string;
} & FieldFacet;

/** A custom check in the validation schema (refine / superRefine). */
export interface CheckRule {
  kind: 'check';
  section: 'body' | 'query' | 'params' | 'cookies';
  field?: string;
  message?: string;
  when?: Condition;
}

/** The server stops the request: `if (…) throw new ApiError(404, '…')`. */
export interface RejectRule {
  kind: 'reject';
  status?: number;
  message?: string;
  /** Other messages the same throw can give (`isReturn ? 'A' : 'B'`). */
  otherMessages?: string[];
  /** All the conditions around the throw, outermost first. Empty: whenever this code runs. */
  when: Condition[];
  /** The function it is in, e.g. "createRoute". */
  in: string;
  /** It is inside a catch block: it happens when the code before it fails. */
  onError?: boolean;
  /** It is in a function the route's code calls: the conditions at the call sites on the way there. */
  path?: RulePath;
}

/** A button or link that can't be used while something is true: `disabled={isSamePort || !port}`. */
export interface UiBlockRule {
  kind: 'ui-block';
  /** Its visible name, e.g. "Create Route". */
  element: string;
  when: Condition;
}

/** The page stops before sending anything: `if (!description) { toast.error('…'); return; }`. */
export interface UiGuardRule {
  kind: 'ui-guard';
  message?: string;
  otherMessages?: string[];
  /** All the conditions around the stop, outermost first. */
  when: Condition[];
  /** The function it is in, e.g. "handleSubmit". */
  in: string;
}

/** A file input that offers only some kinds of file: `<input type="file" accept="image/png,image/jpeg">`. */
export interface UiFileRule {
  kind: 'ui-file';
  /** The words next to it, e.g. "Route Cover Photo". */
  field: string;
  /** As written, e.g. ["image/png", "image/jpeg", ".pdf"]. */
  accept: string[];
  multiple?: boolean;
}

/** One field a database write sets: `availableSeats: { decrement: seats }`, `status: RouteStatus.ACTIVE`. */
export interface WrittenField {
  name: string;
  /**
   * How: set to `value`, made larger / smaller by `value`, or (a list) `value` added to it / taken
   * out of it (Mongoose's $push, $addToSet, $pull). Missing value: from the code.
   */
  how: 'set' | 'increment' | 'decrement' | 'add' | 'remove';
  value?: string;
  /** `value` is only used when nothing else is given (`dto.status ?? RouteStatus.ACTIVE`). */
  fallback?: boolean;
  /** Written only when sent / when some condition holds (`...(dto.x !== undefined && { x })`). */
  optional?: boolean;
}

/** What the request changes or sends: a database write, an email, a live notification, a payment. */
export interface EffectRule {
  kind: 'effect';
  effect: 'create' | 'update' | 'delete' | 'email' | 'notify' | 'payment';
  /** For database writes: the model in words, e.g. "route". */
  model?: string;
  /** createMany / updateMany / deleteMany. */
  many?: boolean;
  fields?: WrittenField[];
  /** An email's subject, a notification's event name, a payment call ("refunds.create"). */
  what?: string;
  /** All the conditions around it, outermost first. Empty: whenever this code runs. */
  when: Condition[];
  in: string;
  /** It is inside a catch block: it happens when the code before it fails. */
  onError?: boolean;
  /** Its failure is caught and ignored: the request still succeeds without it. */
  bestEffort?: boolean;
  /** It is in a function the route's code calls: the conditions at the call sites on the way there. */
  path?: RulePath;
}

export interface RulePath {
  /** The called function it is in, e.g. "applyIntentResultInTx". */
  through: string;
  when: Condition[];
}

/** The answer when nothing stops the request: `sendResponse(res, { statusCode: 201, message })`. */
export interface ReplyRule {
  kind: 'reply';
  status?: number;
  message?: string;
  otherMessages?: string[];
  when: Condition[];
  in: string;
  path?: RulePath;
}

/**
 * Database changes made in one `prisma.$transaction(…)`: if one fails, none of them is kept.
 * Taking the transaction away is a change of business logic too (a booking without its seats).
 */
export interface TogetherRule {
  kind: 'together';
  /** The changes, in the order of the code. */
  changes: { effect: 'create' | 'update' | 'delete'; model: string; many?: boolean }[];
  /** The function the transaction is in. */
  in: string;
}

export type RuleFacts = AccessRule | FieldRule | CheckRule | RejectRule | UiBlockRule | UiGuardRule | UiFileRule | EffectRule | ReplyRule | TogetherRule;

export type Rule = RuleFacts & {
  /** Stable across runs and edits elsewhere: what the rule is about, not what it says. */
  id: string;
  source: Source;
  /** Where the rule lives. Missing means the backend. */
  side?: 'frontend';
};
