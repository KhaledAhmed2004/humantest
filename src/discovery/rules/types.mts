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
}

export type RuleFacts = AccessRule | FieldRule | CheckRule | RejectRule;

export type Rule = RuleFacts & {
  /** Stable across runs and edits elsewhere: what the rule is about, not what it says. */
  id: string;
  source: Source;
};
