import fs from 'node:fs';
import type { StateContext } from '../../../../src/runtime';
import noTestRoutes, { MARKER } from './no-test-routes';

// "Start with: one test route".
// Removes leftover test routes, then adds one, open for trips: Blowing Point to Fort Bay Harbor
// (Saba), a pair no real route uses, described MARKER (see no-test-routes.ts). It borrows the
// photo of an existing route. The test that starts with it deletes it again.
export const FROM = 'Blowing Point, Anguilla';
export const TO = 'Fort Bay Harbor, Saba';

export default async function (ctx: StateContext) {
  await noTestRoutes(ctx);
  const config = JSON.parse(fs.readFileSync('humantest.config.json', 'utf8'));
  const endpoint: string = config.login.endpoint;
  const base = endpoint.slice(0, endpoint.indexOf('/auth/'));
  const headers = { Authorization: `Bearer ${await ctx.token('admin')}` };

  const ports = await ctx.api.get(`${base}/ports?limit=100`, { headers });
  if (!ports.ok()) throw new Error(`Listing the ports failed (${ports.status()}).`);
  const all: { id: string; name: string }[] = (await ports.json()).data.data;
  const from = all.find((p) => p.name === FROM), to = all.find((p) => p.name === TO);
  if (!from || !to) throw new Error(`The ports ${FROM} and ${TO} must both exist.`);

  const routes = await ctx.api.get(`${base}/routes?limit=1`, { headers });
  if (!routes.ok()) throw new Error(`Listing the routes failed (${routes.status()}).`);
  const imageUrl: string | undefined = (await routes.json()).data.routes[0]?.imageUrl;
  if (!imageUrl) throw new Error('There is no route to borrow a photo from.');

  const made = await ctx.api.post(`${base}/routes`, {
    headers,
    data: { departurePortId: from.id, destinationPortId: to.id, durationMinutes: 60, description: MARKER, imageUrl },
  });
  if (!made.ok()) throw new Error(`Adding the test route failed (${made.status()}): ${await made.text()}`);
}
