import type { StateContext } from '../../src/runtime';

// "Start with: empty database". No users, no data.
// It resets the users too, so logins from before it no longer work.
export const logsOut = true;

export default async function ({ api }: StateContext) {
  const res = await api.post('/api/test/reset');
  if (!res.ok()) throw new Error(`Reset failed: ${res.status()}`);
}
