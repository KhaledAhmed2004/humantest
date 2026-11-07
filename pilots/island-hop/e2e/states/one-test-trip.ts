import type { StateContext } from '../../../../src/runtime';
import noTestTrips, { FARE, operator, testDay } from './no-test-trips';

// "Start with: one test trip".
// Removes leftover test trips, then schedules one: Royal Alpha, Blowing Point to Marigot,
// leaving at 10:00 (Anguilla time) on the test day, with the test fare (see no-test-trips.ts).
// The test that starts with it deletes it again.
export const FERRY = 'Royal Alpha';
export const FROM = 'Blowing Point, Anguilla';
export const TO = 'Marigot, Saint Martin';

export default async function (ctx: StateContext) {
  await noTestTrips(ctx);
  const { api, base, headers } = await operator(ctx);

  const ferries = await api.get(`${base}/ferries?limit=100`, { headers });
  if (!ferries.ok()) throw new Error(`Listing the ferries failed (${ferries.status()}).`);
  const ferry = ((await ferries.json()).data.items as { id: string; name: string }[]).find((f) => f.name === FERRY);
  if (!ferry) throw new Error(`The operator has no ferry called ${FERRY}.`);

  const routes = await api.get(`${base}/routes?limit=100`, { headers });
  if (!routes.ok()) throw new Error(`Listing the routes failed (${routes.status()}).`);
  type Route = { id: string; departurePort: { name: string }; destinationPort: { name: string } };
  const route = ((await routes.json()).data.routes as Route[]).find((r) => r.departurePort.name === FROM && r.destinationPort.name === TO);
  if (!route) throw new Error(`There is no route from ${FROM} to ${TO}.`);

  const day = testDay();
  const made = await api.post(`${base}/operator/schedules`, {
    headers,
    data: { routeId: route.id, ferryId: ferry.id, departureTime: `${day}T10:00`, arrivalTime: `${day}T10:25`, adultFare: FARE },
  });
  if (!made.ok()) throw new Error(`Scheduling the test trip failed (${made.status()}): ${await made.text()}`);
}
