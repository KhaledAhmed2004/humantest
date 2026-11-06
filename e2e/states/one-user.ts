import type { StateContext } from '../../src/runtime';

// "Start with: one user "rahim@test.com"". Empty database plus one customer (password Secret123).
// It resets the users too, so logins from before it no longer work.
export const logsOut = true;

export default async function ({ api, args }: StateContext) {
  const [email = 'rahim@test.com'] = args;
  await api.post('/api/test/reset');
  const res = await api.post('/api/test/seed', { data: { users: [{ email, password: 'Secret123' }] } });
  if (!res.ok()) throw new Error(`Seeding failed: ${res.status()}`);
}
