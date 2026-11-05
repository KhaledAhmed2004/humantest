import type { StateContext } from '../../src/runtime';

// "Start with: one user "rahim@test.com"". Empty database plus one customer (password Secret123).
export default async function ({ api, args }: StateContext) {
  const [email = 'rahim@test.com'] = args;
  await api.post('/api/test/reset');
  const res = await api.post('/api/test/seed', { data: { users: [{ email, password: 'Secret123' }] } });
  if (!res.ok()) throw new Error(`Seeding failed: ${res.status()}`);
}
