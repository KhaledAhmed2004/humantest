import fs from 'node:fs';
import type { StateContext } from '../../../../src/runtime';

// "Start with: no test ports".
// Deletes the ports an earlier run of the tests added and didn't get to delete (a failed run).
// Only ports named exactly MARKER are touched; nothing else in the database is.
// The tests that add ports must use this name.
export const MARKER = 'HumanTest test port';

export default async function ({ api, token }: StateContext) {
  const config = JSON.parse(fs.readFileSync('humantest.config.json', 'utf8'));
  const endpoint: string = config.login.endpoint;
  const base = endpoint.slice(0, endpoint.indexOf('/auth/'));
  const headers = { Authorization: `Bearer ${await token('admin')}` };

  const list = await api.get(`${base}/ports?limit=100&search=${encodeURIComponent(MARKER)}`, { headers });
  if (!list.ok()) throw new Error(`Listing the ports failed (${list.status()}).`);
  const ports: { id: string; name?: string }[] = (await list.json()).data.data;
  for (const p of ports.filter((x) => x.name === MARKER)) {
    const del = await api.delete(`${base}/ports/${p.id}`, { headers });
    if (!del.ok()) throw new Error(`Deleting the leftover test port ${p.id} failed (${del.status()}).`);
  }
}
