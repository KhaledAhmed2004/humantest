// "Did you mean ...?" helpers.

export function distance(a: string, b: string): number {
  a = a.toLowerCase();
  b = b.toLowerCase();
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

/** Closest candidate, or undefined if nothing is reasonably close. */
export function closest(input: string, candidates: string[], maxRatio = 0.5): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = distance(input, c);
    if (d < bestD) { bestD = d; best = c; }
  }
  if (best === undefined) return undefined;
  return bestD <= Math.max(3, Math.ceil(Math.max(input.length, best.length) * maxRatio)) ? best : undefined;
}

/** Suggest a sentence template, keeping the user's own "quoted values". */
export function suggestSentence(input: string, templates: string[]): string | undefined {
  const shape = (t: string) => t.replace(/"[^"]*"/g, '"…"');
  const byShape = new Map(templates.map((t) => [shape(t), t]));
  const hit = closest(shape(input), [...byShape.keys()], 0.6);
  if (!hit) return undefined;
  const quoted = [...input.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  let i = 0;
  return byShape.get(hit)!.replace(/"[^"]*"/g, (q) => (i < quoted.length ? `"${quoted[i++]}"` : q));
}
