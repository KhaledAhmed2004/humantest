// All business rules of one route's code slice.

import ts from 'typescript';
import type { RouteArg } from '../backend/express.mts';
import type { Slice } from '../backend/slice.mts';
import type { TsProject } from '../ts-project.mts';
import { accessRules } from './access.mts';
import type { Words } from './condition.mts';
import { effectRules } from './effects.mts';
import { rejectRules } from './throws.mts';
import type { Rule } from './types.mts';
import { schemaRules } from './zod.mts';

export function extractRules(p: TsProject, slice: Slice, w: Words = {}): Rule[] {
  const rules: Rule[] = [...accessRules(p, slice.route)];
  // A validation schema can be given to any middleware (`validateRequest(schema)`, `validate(schema)` …).
  const seen = new Set<ts.Node>();
  const fromArg = (a: RouteArg) => {
    for (const inner of a.args ?? []) {
      if (!inner.node || seen.has(inner.node)) continue;
      seen.add(inner.node);
      const found = schemaRules(p, inner.node, w);
      if (found) rules.push(...found);
    }
  };
  slice.route.middlewares.forEach(fromArg);
  rules.push(...rejectRules(p, slice.items, w));
  rules.push(...effectRules(p, slice.items, w));

  // Ids must be unique: a second rule with the same id (e.g. two identical throws) gets a number.
  const count = new Map<string, number>();
  return rules.map((r) => {
    const n = (count.get(r.id) ?? 0) + 1;
    count.set(r.id, n);
    return n === 1 ? r : { ...r, id: `${r.id}#${n}` };
  });
}

export type { Rule } from './types.mts';
