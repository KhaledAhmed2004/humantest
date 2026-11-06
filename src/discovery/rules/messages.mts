// The app's own messages as written in the code. A message can be built:
//   'Booking not found'                       → ["Booking not found"]
//   `Booking ${ref} not found`                → ["Booking {ref} not found"]
//   isReturn ? 'Return trip gone' : 'Trip gone' → ["Return trip gone", "Trip gone"]

import ts from 'typescript';
import { words } from './condition.mts';

const CONTAINERS = new Set(['dto', 'data', 'payload', 'body', 'req', 'args', 'input']);

export function messageTexts(e: ts.Expression | undefined): string[] | undefined {
  if (!e) return undefined;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e)) e = e.expression;
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return [e.text];
  if (ts.isTemplateExpression(e)) return [e.head.text + e.templateSpans.map((s) => `{${placeholder(s.expression)}}${s.literal.text}`).join('')];
  if (ts.isConditionalExpression(e)) {
    const both = [...(messageTexts(e.whenTrue) ?? []), ...(messageTexts(e.whenFalse) ?? [])];
    return both.length ? both : undefined;
  }
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const a = messageTexts(e.left) ?? [`{${placeholder(e.left)}}`];
    const b = messageTexts(e.right) ?? [`{${placeholder(e.right)}}`];
    return a.flatMap((x) => b.map((y) => x + y));
  }
  return undefined;
}

/** `departurePort.name` → "departure port name"; `data.passengers.length` → "passengers length". */
function placeholder(e: ts.Expression): string {
  if (ts.isPropertyAccessExpression(e)) return `${placeholder(e.expression)} ${words(e.name.text)}`.trim();
  if (ts.isIdentifier(e)) return CONTAINERS.has(e.text) ? '' : words(e.text);
  return '…';
}
