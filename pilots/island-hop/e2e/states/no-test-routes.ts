import fs from 'node:fs';
import type { StateContext } from '../../../../src/runtime';

// "Start with: no test routes".
// Deletes the routes an earlier run of the tests created and didn't get to delete (a failed run).
// Only routes whose description is exactly MARKER are touched; nothing else in the database is.
// The tests that create routes must use this description.
export const MARKER = 'HumanTest test route';

export default async function ({ api, token }: StateContext) {
  const config = JSON.parse(fs.readFileSync('humantest.config.json', 'utf8'));
  const endpoint: string = config.login.endpoint;
  const base = endpoint.slice(0, endpoint.indexOf('/auth/'));
  const headers = { Authorization: `Bearer ${await token('admin')}` };

  const list = await api.get(`${base}/routes?limit=100`, { headers });
  if (!list.ok()) throw new Error(`Listing the routes failed (${list.status()}).`);
  const routes: { id: string; description?: string }[] = (await list.json()).data.routes;
  for (const r of routes.filter((x) => x.description === MARKER)) {
    const del = await api.delete(`${base}/routes/${r.id}`, { headers });
    if (!del.ok()) throw new Error(`Deleting the leftover test route ${r.id} failed (${del.status()}).`);
  }
}
