import fs from 'node:fs';
import type { APIRequestContext } from '@playwright/test';
import type { StateContext } from '../../../../src/runtime';

// "Start with: no test trips".
// Deletes the trips an earlier run of the tests scheduled and didn't get to delete (a failed run).
// A test trip is one that leaves DAYS_AHEAD days from today (as {in 300 days} in a test) with an
// adult fare of exactly FARE. Nothing else in the database is touched.
export const DAYS_AHEAD = 300;
export const FARE = 77;

/** {in 300 days} on this machine, as YYYY-MM-DD (like withDates in src/runtime). */
export function testDay(): string {
  const d = new Date();
  d.setDate(d.getDate() + DAYS_AHEAD);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export async function operator({ api, token }: StateContext): Promise<{ api: APIRequestContext; base: string; headers: Record<string, string> }> {
  const config = JSON.parse(fs.readFileSync('humantest.config.json', 'utf8'));
  const endpoint: string = config.login.endpoint;
  return { api, base: endpoint.slice(0, endpoint.indexOf('/auth/')), headers: { Authorization: `Bearer ${await token('operator')}` } };
}

export default async function (ctx: StateContext) {
  const { api, base, headers } = await operator(ctx);
  const list = await api.get(`${base}/operator/schedules?limit=100&date=${testDay()}`, { headers });
  if (!list.ok()) throw new Error(`Listing the trips failed (${list.status()}).`);
  const trips: { id: string; adultFare?: number | string }[] = (await list.json()).data.data;
  for (const t of trips.filter((x) => Number(x.adultFare) === FARE)) {
    const del = await api.delete(`${base}/operator/schedules/${t.id}`, { headers });
    if (!del.ok()) throw new Error(`Deleting the leftover test trip ${t.id} failed (${del.status()}).`);
  }
}
