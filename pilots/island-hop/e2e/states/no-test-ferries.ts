import fs from 'node:fs';
import type { StateContext } from '../../../../src/runtime';

// "Start with: no test ferries".
// Deletes the ferries an earlier run of the tests added and didn't get to remove (a failed run).
// Only the operator's ferries named exactly MARKER are touched; nothing else in the database is.
// The tests that add ferries must use this name.
export const MARKER = 'HumanTest test ferry';

export default async function ({ api, token }: StateContext) {
  const config = JSON.parse(fs.readFileSync('humantest.config.json', 'utf8'));
  const endpoint: string = config.login.endpoint;
  const base = endpoint.slice(0, endpoint.indexOf('/auth/'));
  const headers = { Authorization: `Bearer ${await token('operator')}` };

  const list = await api.get(`${base}/ferries?limit=100&search=${encodeURIComponent(MARKER)}`, { headers });
  if (!list.ok()) throw new Error(`Listing the ferries failed (${list.status()}).`);
  const ferries: { id: string; name?: string }[] = (await list.json()).data.items;
  for (const f of ferries.filter((x) => x.name === MARKER)) {
    const del = await api.delete(`${base}/ferries/${f.id}`, { headers });
    if (!del.ok()) throw new Error(`Deleting the leftover test ferry ${f.id} failed (${del.status()}).`);
  }
}
